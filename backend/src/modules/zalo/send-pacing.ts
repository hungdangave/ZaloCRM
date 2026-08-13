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

// Chuỗi serialize per (account, category). Không cần dọn — số key nhỏ (30 số × 3 loại).
const chains = new Map<string, Promise<void>>();
const lastDoneAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chờ tới lượt gửi của mình trên (accountId, category). Trả về ngay nếu category
 * không thuộc nhóm giãn nhịp hoặc pacing bị tắt. An toàn với lỗi: lượt của caller
 * được ghi nhận cả khi thao tác sau đó fail (không kẹt chuỗi).
 */
export function awaitSendTurn(accountId: string, category: OpCategory): Promise<void> {
  if (process.env.ZALO_PACE_DISABLED === '1') return Promise.resolve();
  const rule = PACE_RULES[category];
  if (!rule) return Promise.resolve();

  const key = `${accountId}:${category}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const turn = prev.then(async () => {
    const gap = rule.minGapMs + Math.floor(Math.random() * (rule.jitterMs + 1));
    const last = lastDoneAt.get(key) ?? 0;
    const waitMs = last + gap - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastDoneAt.set(key, Date.now());
  });
  // Chuỗi không bao giờ reject (thân trên không throw) → nối tiếp an toàn.
  chains.set(key, turn);
  return turn;
}
