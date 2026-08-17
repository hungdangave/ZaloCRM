// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * presence-service.ts — Real-time Zalo presence cache + bulk refresh.
 *
 * Architecture:
 *   - In-memory cache: Map<`${accountId}:${friendUid}`, { lastOnline, fetchedAt }>
 *   - TTL: 30s. Stale entries return cached value but trigger background refresh.
 *   - Bulk cron 60s: call api.getFriendOnlines() per account → update cache + emit
 *     socket 'friend:presence' for live UI updates.
 *   - Single-uid fetch: api.lastOnline(uid) for on-demand (conv open).
 *
 * Privacy: Zalo returns `settings.show_online_status: false` if user disabled
 * status sharing — store `null` lastOnline in that case.
 */
import cron from 'node-cron';
import type { Server } from 'socket.io';
import { zaloOps } from '../../shared/zalo-operations.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { runSystemQuery } from '../../shared/tenant/tenant-context.js';

export interface PresenceEntry {
  /** Unix ms timestamp from Zalo lastOnline. null = privacy off OR unknown */
  lastOnline: number | null;
  /** Whether user has show_online_status privacy enabled */
  showStatus: boolean;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000; // 30s — single-uid fetch dedup
const cache = new Map<string, PresenceEntry>();
let ioRef: Server | null = null;

function key(accountId: string, friendUid: string): string {
  return `${accountId}:${friendUid}`;
}

/**
 * Get presence for a single friend uid. Returns cached entry if fresh (<30s),
 * else fetches via Zalo SDK lastOnline + updates cache.
 *
 * Returns null on fetch error (caller handles fallback UI).
 */
export async function getPresence(accountId: string, friendUid: string): Promise<PresenceEntry | null> {
  const k = key(accountId, friendUid);
  const cached = cache.get(k);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const result: any = await zaloOps.getLastOnline(accountId, friendUid);
    // Zalo returns: { lastOnline: number, settings: { show_online_status: boolean } }
    // lastOnline = 0 nghĩa là Zalo không có data hoặc KH chưa từng online → treat as null
    let lastOnlineMs: number | null = null;
    if (typeof result?.lastOnline === 'number' && result.lastOnline > 0) {
      // Zalo trả ms hoặc s tuỳ version — detect bằng magnitude (<1e12 ≈ trước 2001 nếu ms → s)
      lastOnlineMs = result.lastOnline < 1e12 ? result.lastOnline * 1000 : result.lastOnline;
    }
    const showStatus = result?.settings?.show_online_status !== false;

    const entry: PresenceEntry = {
      lastOnline: showStatus ? lastOnlineMs : null,
      showStatus,
      fetchedAt: now,
    };
    cache.set(k, entry);
    return entry;
  } catch (err) {
    logger.warn('[presence] fetch failed', { accountId, friendUid, err: (err as Error).message });
    return cached || null;
  }
}

/**
 * Bulk refresh — getFriendOnlines() per account, mark friends in `onlines` list
 * as fresh, emit socket update. Stale entries naturally TTL-expire.
 *
 * Note: getFriendOnlines returns currently-online friends only. Friends NOT in
 * the list might still be online if they recently went offline — we don't
 * proactively mark offline; we let stale data expire and re-fetch on demand.
 */
async function refreshAccountPresence(accountId: string): Promise<{ onlineCount: number } | null> {
  try {
    const result: any = await zaloOps.getFriendOnlines(accountId);
    const onlines: Array<{ userId: string; status?: string }> = result?.onlines ?? [];
    const now = Date.now();

    for (const o of onlines) {
      if (!o.userId) continue;
      cache.set(key(accountId, o.userId), {
        lastOnline: now, // currently online → lastOnline ≈ now
        showStatus: true,
        fetchedAt: now,
      });
    }

    // Emit socket to all org clients — frontend uses to update conv list dots
    if (ioRef) {
      // Find org of this account (account-by-id, cross-org discovery) → runSystemQuery.
      const acc = await runSystemQuery(() =>
        prisma.zaloAccount.findUnique({
          where: { id: accountId },
          select: { orgId: true },
        }),
      );
      if (acc) {
        ioRef.to(`org:${acc.orgId}`).emit('friend:presence', {
          accountId,
          onlines: onlines.map((o) => o.userId),
          at: now,
        });
      }
    }

    ghiNhanTot();
    return { onlineCount: onlines.length };
  } catch (err) {
    // Thường gặp: nick chưa kết nối → im lặng. Nhưng vẫn phải đếm để cầu dao biết
    // khi endpoint chết hẳn (Zalo trả 404 cho mọi nick).
    ghiNhanHong();
    return null;
  }
}

/**
 * CẦU DAO cho tính năng "chấm xanh đang online" (AN AN 17/08/2026).
 *
 * BỆNH ĐO ĐƯỢC: `getFriendOnlines()` bị Zalo trả **404 với MỌI nick** —
 * endpoint này đã chết phía Zalo (zca-js chưa cập nhật). Nhưng lịch chạy vẫn gọi
 * **mỗi nick mỗi 60 giây**: đo được **792 lỗi/giờ khi mới 15 nick**, quy ra
 * **~2.160 lượt gọi hỏng/giờ khi đủ 36 nick**.
 *
 * VÌ SAO PHẢI CHẶN (không chỉ là "log ồn"):
 *  1. Đây đúng kiểu dấu vết máy móc mà lớp chống khoá đang cố tránh — 36 nick cùng
 *     bắn một lời gọi hỏng, đều tăm tắp mỗi phút, không người dùng thật nào như vậy.
 *  2. Ăn hạn mức thao tác/ngày của SDK cho một tính năng KHÔNG chạy được.
 *  3. Ăn CPU + rác nhật ký, che mất lỗi thật.
 *
 * CÁCH: hỏng liên tiếp quá ngưỡng → NGẮT hẳn, ghi log MỘT lần. Có kết quả tốt trở
 * lại thì tự đóng cầu dao (phòng khi Zalo bật lại endpoint / zca-js cập nhật).
 * Tắt tay bằng ZALO_PRESENCE_DISABLED=1.
 *
 * Mất gì: chỉ mất chấm xanh "đang online" trên giao diện. Không ảnh hưởng nhắn tin,
 * đồng bộ bạn bè hay hội thoại.
 */
const NGUONG_HONG_LIEN_TIEP = 5;
let soHongLienTiep = 0;
let cauDaoNgat = false;

function ghiNhanHong(): void {
  soHongLienTiep++;
  if (!cauDaoNgat && soHongLienTiep >= NGUONG_HONG_LIEN_TIEP) {
    cauDaoNgat = true;
    logger.warn(
      `[presence] NGẮT tính năng "đang online": getFriendOnlines hỏng ${soHongLienTiep} lần liên tiếp ` +
        '(Zalo trả 404 — endpoint đã chết). Ngừng gọi để không bắn hàng nghìn lượt hỏng/giờ tới Zalo. ' +
        'Chỉ mất chấm xanh trên giao diện; nhắn tin và đồng bộ vẫn bình thường.',
    );
  }
}

function ghiNhanTot(): void {
  if (cauDaoNgat) {
    logger.info('[presence] endpoint "đang online" sống lại — đóng cầu dao, chạy tiếp');
    cauDaoNgat = false;
  }
  soHongLienTiep = 0;
}

let cronJob: cron.ScheduledTask | null = null;

export function startPresenceCron(io: Server | null): void {
  ioRef = io;

  if (process.env.ZALO_PRESENCE_DISABLED === '1') {
    logger.info('[presence] ZALO_PRESENCE_DISABLED=1 → không chạy lịch "đang online"');
    return;
  }

  // Every 60s — bulk refresh all connected accounts
  cronJob = cron.schedule('*/1 * * * *', async () => {
    if (cauDaoNgat) return; // endpoint đã chết — đừng bắn thêm lượt gọi hỏng nào nữa
    // Cross-org sweep (mọi account connected mọi org) → runSystemQuery.
    const accounts = await runSystemQuery(() =>
      prisma.zaloAccount.findMany({
        where: { status: 'connected' },
        select: { id: true },
      }),
    );
    let totalOnline = 0;
    for (const acc of accounts) {
      const result = await refreshAccountPresence(acc.id);
      if (result) totalOnline += result.onlineCount;
    }
    if (accounts.length > 0) {
      logger.debug('[presence] bulk refresh done', {
        accounts: accounts.length,
        totalOnline,
        cacheSize: cache.size,
      });
    }
  });
  logger.info('[presence] cron started — refresh every 60s');
}

export function stopPresenceCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

/** Cleanup entries older than 5min (called periodically). */
export function pruneCache(): number {
  const cutoff = Date.now() - 5 * 60_000;
  let removed = 0;
  for (const [k, v] of cache) {
    if (v.fetchedAt < cutoff) {
      cache.delete(k);
      removed++;
    }
  }
  return removed;
}
