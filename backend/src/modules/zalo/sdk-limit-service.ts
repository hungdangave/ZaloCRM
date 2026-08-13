// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * sdk-limit-service.ts — 2026-06-06 (Anh chốt).
 * Nguồn TRẦN SDK Zalo (thay CATEGORY_LIMITS hardcode). Cấu hình tại màn "Quản lý
 * tài khoản Zalo". Quy tắc đọc (Anh chốt):
 *   ưu tiên trần GHI ĐÈ của nick → org DEFAULT → fallback hằng số code.
 * Mọi nơi gọi SDK (zalo-rate-limiter) + UI đọc qua service này.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import type { OpCategory } from '../../shared/zalo-operations.js';

export interface CategoryLimit {
  daily: number;
  burst: number;
  burstWindowMs: number;
}

// Fallback CUỐI CÙNG nếu DB chưa cấu hình (= giá trị hardcode lịch sử). KHÔNG còn là
// nguồn chính — chỉ dùng khi org chưa có hàng sdk_limits cho category đó.
export const DEFAULT_SDK_LIMITS: Record<OpCategory, CategoryLimit> = {
  message:       { daily: 200,  burst: 20, burstWindowMs: 30_000 },
  reaction:      { daily: 300,  burst: 10, burstWindowMs: 30_000 },
  chat_action:   { daily: 500,  burst: 15, burstWindowMs: 30_000 },
  group_admin:   { daily: 50,   burst: 5,  burstWindowMs: 60_000 },
  group_read:    { daily: 1000, burst: 20, burstWindowMs: 30_000 },
  friend_action: { daily: 30,   burst: 8,  burstWindowMs: 60_000 },
  friend_read:   { daily: 500,  burst: 10, burstWindowMs: 30_000 }, // online/recommend/sent-req còn lại
  profile:       { daily: 10,   burst: 3,  burstWindowMs: 60_000 },
  query:         { daily: 2000, burst: 30, burstWindowMs: 30_000 },
  // 2026-06-06 (Anh chốt) — tách findUser + đồng bộ danh bạ ra khỏi friend_read.
  // friend_lookup CAO (tìm SĐT→UID là việc chính của chiến dịch, cần nhiều).
  // contact_sync THẤP (đồng bộ danh bạ nền chỉ vài lần/ngày khi reconnect).
  friend_lookup: { daily: 1000, burst: 15, burstWindowMs: 30_000 },
  contact_sync:  { daily: 100,  burst: 5,  burstWindowMs: 60_000 },
};

export const ALL_CATEGORIES = Object.keys(DEFAULT_SDK_LIMITS) as OpCategory[];

// ── Cache: key = `${orgId}:${nickId||'_'}:${category}` → 60s TTL ───────────────
interface CacheEntry { limit: CategoryLimit; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
// nick → orgId (đỡ query lại mỗi lần). TTL dài hơn vì hiếm đổi.
const nickOrgCache = new Map<string, { orgId: string | null; expiresAt: number }>();
const NICK_ORG_TTL_MS = 5 * 60_000;

function cacheKey(orgId: string, nickId: string | null, cat: string): string {
  return `${orgId}:${nickId ?? '_'}:${cat}`;
}

async function resolveOrgId(nickId: string): Promise<string | null> {
  const hit = nickOrgCache.get(nickId);
  if (hit && hit.expiresAt > Date.now()) return hit.orgId;
  let orgId: string | null = null;
  try {
    const nick = await prisma.zaloAccount.findUnique({ where: { id: nickId }, select: { orgId: true } });
    orgId = nick?.orgId ?? null;
  } catch (err) {
    logger.warn(`[sdk-limit] resolveOrgId failed nick=${nickId}:`, err);
  }
  nickOrgCache.set(nickId, { orgId, expiresAt: Date.now() + NICK_ORG_TTL_MS });
  return orgId;
}

// ── AN AN anti-lock 2026-08-13: WARM-UP số mới ────────────────────────────────
// Số mới thêm vào hệ (record ZaloAccount mới) KHÔNG được chạy full trần ngay —
// bơm tải dần theo tuổi nick (mục 6.4 brief). Trần hiệu lực = trần cấu hình × factor.
//   ngày 0-2:  ×0.2   (200 tin/ngày → 40)
//   ngày 3-6:  ×0.5
//   ngày 7-13: ×0.8
//   từ ngày 14: ×1.0 (full)
// Tắt bằng env ZALO_WARMUP_DISABLED=1 (chỉ nên khi migrate số cũ đã chạy lâu ở nơi khác).
const WARMUP_STEPS: Array<{ maxAgeDays: number; factor: number }> = [
  { maxAgeDays: 3, factor: 0.2 },
  { maxAgeDays: 7, factor: 0.5 },
  { maxAgeDays: 14, factor: 0.8 },
];

const warmupCache = new Map<string, { createdAt: Date | null; expiresAt: number }>();
const WARMUP_CACHE_TTL_MS = 5 * 60_000;

async function getNickCreatedAt(nickId: string): Promise<Date | null> {
  const hit = warmupCache.get(nickId);
  if (hit && hit.expiresAt > Date.now()) return hit.createdAt;
  let createdAt: Date | null = null;
  try {
    const nick = await prisma.zaloAccount.findUnique({ where: { id: nickId }, select: { createdAt: true } });
    createdAt = nick?.createdAt ?? null;
  } catch (err) {
    logger.warn(`[sdk-limit] getNickCreatedAt failed nick=${nickId}:`, err);
  }
  warmupCache.set(nickId, { createdAt, expiresAt: Date.now() + WARMUP_CACHE_TTL_MS });
  return createdAt;
}

/** Hệ số warm-up hiện tại của nick (1 = full trần). Public cho dashboard/UI đọc. */
export async function getWarmupFactor(nickId: string): Promise<number> {
  if (process.env.ZALO_WARMUP_DISABLED === '1') return 1;
  const createdAt = await getNickCreatedAt(nickId);
  if (!createdAt) return 1; // không rõ tuổi → không phạt (fail-open như limiter)
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  for (const step of WARMUP_STEPS) {
    if (ageDays < step.maxAgeDays) return step.factor;
  }
  return 1;
}

function applyWarmup(limit: CategoryLimit, factor: number): CategoryLimit {
  if (factor >= 1) return limit;
  return {
    daily: Math.max(1, Math.floor(limit.daily * factor)),
    burst: Math.max(1, Math.floor(limit.burst * factor)),
    burstWindowMs: limit.burstWindowMs,
  };
}

/**
 * Trần hiệu lực cho 1 nick + category: (nick override → org default → fallback hằng số)
 * × hệ số warm-up theo tuổi nick (AN AN anti-lock 2026-08-13).
 */
export async function getEffectiveLimit(nickId: string, category: OpCategory): Promise<CategoryLimit> {
  const fallback = DEFAULT_SDK_LIMITS[category] ?? DEFAULT_SDK_LIMITS.message;
  const warmupFactor = await getWarmupFactor(nickId);
  try {
    const orgId = await resolveOrgId(nickId);
    if (!orgId) return applyWarmup(fallback, warmupFactor);

    const ck = cacheKey(orgId, nickId, category);
    const hit = cache.get(ck);
    if (hit && hit.expiresAt > Date.now()) return applyWarmup(hit.limit, warmupFactor);

    // 1 query lấy cả override (nick) + default (org) cho category này.
    const rows = await prisma.sdkLimit.findMany({
      where: {
        orgId,
        category,
        OR: [{ zaloAccountId: nickId }, { zaloAccountId: null }],
      },
      select: { zaloAccountId: true, dailyLimit: true, burstLimit: true, burstWindowMs: true },
    });
    const nickRow = rows.find((r) => r.zaloAccountId === nickId);
    const orgRow = rows.find((r) => r.zaloAccountId === null);
    const chosen = nickRow ?? orgRow; // ưu tiên nick, backup org
    const limit: CategoryLimit = chosen
      ? { daily: chosen.dailyLimit, burst: chosen.burstLimit, burstWindowMs: chosen.burstWindowMs }
      : fallback;

    // Cache trần GỐC (chưa nhân warm-up) — factor đổi theo ngày, áp lúc đọc.
    cache.set(ck, { limit, expiresAt: Date.now() + CACHE_TTL_MS });
    return applyWarmup(limit, warmupFactor);
  } catch (err) {
    logger.warn(`[sdk-limit] getEffectiveLimit failed nick=${nickId} cat=${category}:`, err);
    return applyWarmup(fallback, warmupFactor);
  }
}

/** Xoá cache (gọi khi admin edit trần). null = xoá tất cả. */
export function invalidateLimitCache(orgId?: string): void {
  if (!orgId) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.startsWith(`${orgId}:`)) cache.delete(k);
}
