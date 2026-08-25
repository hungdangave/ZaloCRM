// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-autotags-dirty.ts — Redis dirty set + cron batch SQL.
 *
 * Issue 6A /plan-eng-review M57. Tránh N+1 query khi cron scoring touch
 * 4500 KH × 7 friend → 31,500 calls. Mỗi addFriendTag(auto_*) chỉ markDirty.
 * Cron 5 phút batch 1 SQL UPDATE Contact.autoTags = union DISTINCT.
 *
 * Wave 5 Slim Big-Bang sẽ DROP Contact.autoTags → bỏ luôn cron này.
 */

import { prisma, tenantTransaction } from '../../shared/database/prisma-client.js';
import { getRedis } from '../../shared/redis-client.js';
import { logger } from '../../shared/utils/logger.js';
import { withTenant, runSystemQuery } from '../../shared/tenant/tenant-context.js';

const REDIS_KEY = 'tag-autotags-dirty';
const IN_MEMORY_FALLBACK = new Set<string>();
const BATCH_LIMIT = 500;

export async function markContactAutoTagsDirty(contactId: string): Promise<void> {
  if (!contactId) return;
  const redis = await getRedis();
  if (redis) {
    await redis.sadd(REDIS_KEY, contactId);
  } else {
    IN_MEMORY_FALLBACK.add(contactId);
  }
}

export async function drainDirtyContacts(): Promise<string[]> {
  const redis = await getRedis();
  if (redis) {
    const members = await redis.spop(REDIS_KEY, BATCH_LIMIT);
    return Array.isArray(members) ? members : [];
  }
  const arr = Array.from(IN_MEMORY_FALLBACK);
  IN_MEMORY_FALLBACK.clear();
  return arr.slice(0, BATCH_LIMIT);
}

/**
 * Cron worker: scan dirty set + batch UPDATE Contact.autoTags = union DISTINCT
 * across all friends WHERE FriendTag(source=auto_*).
 */
export async function runAutoTagsAggregateBatch(): Promise<{ updated: number }> {
  const contactIds = await drainDirtyContacts();
  if (contactIds.length === 0) return { updated: 0 };
  const batDau = Date.now();

  // Phase 1a RLS (Giai đoạn 0.2): dirty set TRỘN nhiều org → group theo org, mỗi org chạy
  // 1 UPDATE trong tenantTransaction (set app.current_org cho raw SQL — extension chỉ wrap
  // model op, KHÔNG chạm $executeRaw, nên raw phải tự set qua tenantTransaction). RLS lúc đó
  // lọc đúng org cho cả contacts + friends/friend_tags/tags trong subquery.
  const rows = await runSystemQuery(() =>
    prisma.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, orgId: true },
    }),
  );
  const byOrg = new Map<string, string[]>();
  for (const r of rows) {
    if (!byOrg.has(r.orgId)) byOrg.set(r.orgId, []);
    byOrg.get(r.orgId)!.push(r.id);
  }

  let updated = 0;
  for (const [orgId, ids] of byOrg) {
    const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    if (!idList) continue;
    try {
      await withTenant(orgId, () =>
        tenantTransaction((tx: any) =>
          // ── VIẾT LẠI THEO LÔ (AN AN 25/08/2026) ─────────────────────────
          // BỆNH: bản cũ dùng truy vấn con TƯƠNG QUAN — chạy lại toàn bộ phép gộp
          // cho TỪNG hồ sơ. Đo thật: **66ms/hồ sơ** → 500 hồ sơ ≈ 33 GIÂY, trong khi
          // giao dịch chỉ có 5 giây → **hỏng 72/72 lần trong 6 giờ**, và mỗi lần hỏng
          // lại đánh dấu bẩn lại 500 hồ sơ đó → **hỏng vĩnh viễn**, hàng đợi không bao
          // giờ vơi (đo được 1.121 hồ sơ đang kẹt), `auto_tags` không bao giờ cập nhật.
          //
          // NAY: gộp MỘT LẦN cho cả lô rồi ghép vào (LEFT JOIN để hồ sơ không có thẻ
          // vẫn được đặt về '[]', giữ nguyên ngữ nghĩa cũ).
          // Đo trên máy thật: 300 hồ sơ **20 giây → 124ms** (~160 lần nhanh hơn),
          // và **300/300 kết quả GIỐNG HỆT** bản cũ (đã đối chiếu trước khi đổi).
          tx.$executeRawUnsafe(`
            WITH ids AS (SELECT unnest(ARRAY[${idList}]::text[]) AS id),
            agg AS (
              SELECT f.contact_id, json_agg(DISTINCT t.slug) AS slugs
              FROM friends f
              JOIN friend_tags ft ON ft.friend_id = f.id AND ft.removed_at IS NULL
              JOIN tags t ON t.id = ft.tag_id
                         AND t.source IN ('auto_detect', 'auto_score', 'auto_engagement')
              WHERE f.contact_id IN (SELECT id FROM ids)
              GROUP BY f.contact_id
            )
            UPDATE contacts c
            SET auto_tags = COALESCE(agg.slugs, '[]'::json)
            FROM ids LEFT JOIN agg ON agg.contact_id = ids.id
            WHERE c.id = ids.id
          `),
        ),
      );
      updated += ids.length;
      const giay = (Date.now() - batDau) / 1000;
      // Cảnh báo SỚM nếu chậm lại: giới hạn giao dịch là 5 giây. Trước đây job chạy 30
      // giây và hỏng im lặng suốt nhiều ngày — không ai biết cho tới khi soi tay.
      if (giay > 3) {
        logger.warn('[autotags-dirty] lo %d ho so chay %ss — sat tran 5s, xem lai truy van', ids.length, giay.toFixed(1));
      }
    } catch (err) {
      logger.error('[autotags-dirty] batch failed org=%s: %s', orgId, (err as Error).message);
      // Re-mark dirty để retry next round
      for (const id of ids) await markContactAutoTagsDirty(id);
    }
  }
  logger.debug(`[autotags-dirty] aggregated ${updated} contacts across ${byOrg.size} org(s)`);
  return { updated };
}

let cronTimer: NodeJS.Timeout | null = null;

export function startAutoTagsAggregateCron(intervalMs = 5 * 60 * 1000): void {
  if (cronTimer) return;
  cronTimer = setInterval(() => {
    runAutoTagsAggregateBatch().catch((err) => logger.error('[autotags-dirty] cron err: %s', err));
  }, intervalMs);
  logger.info(`[autotags-dirty] cron started, interval=${intervalMs}ms`);
}

export function stopAutoTagsAggregateCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}
