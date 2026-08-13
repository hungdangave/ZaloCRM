// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * send-pacing.ts — giãn nhịp gửi GIỐNG NGƯỜI per-account (AN AN anti-lock 2026-08-13).
 *
 * Rate limiter hiện có (zalo-rate-limiter) chỉ CHẶN khi vượt trần daily/burst —
 * nó không ngăn 20 tin bắn ra trong 2 giây (vẫn dưới burst 20/30s) = pattern bot
 * lộ liễu nhất. Lớp này bổ sung: giữa 2 thao tác cùng loại trên CÙNG một số Zalo
 * phải có khoảng nghỉ tối thiểu + jitter ngẫu nhiên, như người thật gõ phím.
 *
 * Thiết kế:
 *  - Mỗi (accountId, category) là một chuỗi promise nối đuôi (serial queue).
 *    Caller await xong lượt của mình rồi mới gửi → không bao giờ burst.
 *  - Chỉ áp cho category NHẠY (message, friend_action, profile). Đọc/typing
 *    không giãn — người thật cũng đọc nhanh.
 *  - Nhiều SỐ khác nhau vẫn song song bình thường (chỉ serialize trong 1 số).
 *
 * Env override (ms): ZALO_PACE_MESSAGE_MIN / ZALO_PACE_MESSAGE_JITTER, tương tự
 * ZALO_PACE_FRIEND_MIN / _JITTER. Đặt ZALO_PACE_DISABLED=1 để tắt (chỉ nên khi dev).
 */
import type { OpCategory } from '../../shared/zalo-operations.js';
import { logger } from '../../shared/utils/logger.js';

interface PaceRule { minGapMs: number; jitterMs: number; }

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Mốc mặc định: tin nhắn cách nhau ≥1,5s + 0–2,5s ngẫu nhiên (~18-40 tin/phút khi
// dồn dập — khớp mốc an toàn ~30 tin/phút của cộng đồng zca-js, mục 6 brief).
// friend_action hiếm + nhạy (kết bạn hàng loạt là cờ đỏ) → nghỉ dài hơn hẳn.
const PACE_RULES: Partial<Record<OpCategory, PaceRule>> = {
  message:       { minGapMs: envInt('ZALO_PACE_MESSAGE_MIN', 1_500), jitterMs: envInt('ZALO_PACE_MESSAGE_JITTER', 2_500) },
  friend_action: { minGapMs: envInt('ZALO_PACE_FRIEND_MIN', 20_000), jitterMs: envInt('ZALO_PACE_FRIEND_JITTER', 25_000) },
  profile:       { minGapMs: envInt('ZALO_PACE_PROFILE_MIN', 10_000), jitterMs: envInt('ZALO_PACE_PROFILE_JITTER', 10_000) },
};
// ── AN AN 13/08 (CEO chốt gộp 4 số/proxy): GIÃN NHỊP THEO NHÓM IP ────────────
// Giãn nhịp per-account KHÔNG đủ khi nhiều số dùng chung 1 proxy: 4 số × ~18-40 tin/phút
// = tới ~160 tin/phút phát ra từ MỘT IP nhà dân — không hộ nào như vậy. Zalo soi TỔNG TẢI/IP.
// → Nối chuỗi theo NHÓM (các account cùng proxyUrl = cùng IP thoát) và ràng khoảng nghỉ
//   nhóm, để tổng tải mỗi IP giữ mức người thật (~24-40 tin/phút cho CẢ nhóm).
//
// Thực tế trần ngày (200 tin/số) đã thấp hơn nhiều: 4 số × 200 tin rải 10 tiếng ≈ 1,3 tin/phút
// → lớp này gần như không bao giờ chạm khi làm việc bình thường; nó CHỈ siết đúng lúc có
// burst (chiến dịch gửi loạt) — tức là đúng lúc cần siết.
const GROUP_GAP_MS = envInt('ZALO_PACE_GROUP_MIN', 1_500);
const GROUP_JITTER_MS = envInt('ZALO_PACE_GROUP_JITTER', 1_500);

// Chuỗi serialize per (nhóm-IP, category). Không cần dọn — key nhỏ (≤30 số × 3 loại).
const chains = new Map<string, Promise<void>>();
const lastDoneAt = new Map<string, number>();      // mốc gửi cuối theo account
const lastGroupAt = new Map<string, number>();     // mốc gửi cuối theo nhóm IP

// accountId → khoá nhóm (proxyUrl, hoặc 'direct' khi chạy thẳng IP server — các số
// không proxy cũng đang DÙNG CHUNG một IP nên vẫn phải chung nhóm).
const groupCache = new Map<string, { key: string; expiresAt: number }>();
const GROUP_TTL_MS = 5 * 60_000;

async function resolveGroupKey(accountId: string): Promise<string> {
  const hit = groupCache.get(accountId);
  if (hit && hit.expiresAt > Date.now()) return hit.key;
  let key = `acct:${accountId}`; // không tra được → tự đứng riêng (an toàn nhất, không nới cho ai)
  try {
    const { prisma } = await import('../../shared/database/prisma-client.js');
    const rec = await prisma.zaloAccount.findUnique({
      where: { id: accountId },
      select: { proxyUrl: true },
    });
    key = rec?.proxyUrl?.trim() ? `proxy:${rec.proxyUrl.trim()}` : 'direct';
  } catch (err) {
    logger.warn(`[pacing] không tra được proxy của ${accountId}, tạm xếp nhóm riêng:`, err);
  }
  groupCache.set(accountId, { key, expiresAt: Date.now() + GROUP_TTL_MS });
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chờ tới lượt gửi của mình. Ràng CẢ HAI mức:
 *   - khoảng nghỉ của chính số đó (giống người gõ phím), và
 *   - khoảng nghỉ của NHÓM IP mà số đó dùng chung (tổng tải/IP giống người).
 * Lấy mức chờ LỚN HƠN. Trả về ngay nếu category không nhạy hoặc pacing bị tắt.
 *
 * Đánh đổi đã biết: các số cùng nhóm xếp hàng nối đuôi, nên một số phải chờ có thể
 * giữ chỗ của số khác vài giây. Với tải thật (~1,3 tin/phút/IP) điều này không xảy ra.
 */
export function awaitSendTurn(accountId: string, category: OpCategory): Promise<void> {
  if (process.env.ZALO_PACE_DISABLED === '1') return Promise.resolve();
  const rule = PACE_RULES[category];
  if (!rule) return Promise.resolve();

  const acctKey = `${accountId}:${category}`;
  // Nối chuỗi theo nhóm — nhưng khoá nhóm phải tra bất đồng bộ, nên chốt chuỗi theo
  // account trước rồi hợp nhất vào chuỗi nhóm bên trong (tra proxy có cache 5 phút).
  const prev = chains.get(acctKey) ?? Promise.resolve();
  const turn = prev.then(async () => {
    const groupKey = await resolveGroupKey(accountId);
    const groupChainKey = `${groupKey}:${category}`;
    const prevGroup = chains.get(groupChainKey) ?? Promise.resolve();
    const groupTurn = prevGroup.then(async () => {
      const now = Date.now();
      const acctGap = rule.minGapMs + Math.floor(Math.random() * (rule.jitterMs + 1));
      const groupGap = GROUP_GAP_MS + Math.floor(Math.random() * (GROUP_JITTER_MS + 1));
      const waitAcct = (lastDoneAt.get(acctKey) ?? 0) + acctGap - now;
      const waitGroup = (lastGroupAt.get(groupChainKey) ?? 0) + groupGap - now;
      const waitMs = Math.max(waitAcct, waitGroup);
      if (waitMs > 0) await sleep(waitMs);
      const done = Date.now();
      lastDoneAt.set(acctKey, done);
      lastGroupAt.set(groupChainKey, done);
    });
    chains.set(groupChainKey, groupTurn);
    return groupTurn;
  });
  // Chuỗi không bao giờ reject (thân trên không throw) → nối tiếp an toàn.
  chains.set(acctKey, turn);
  return turn;
}
