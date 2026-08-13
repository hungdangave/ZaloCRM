// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * telegram-bot.ts — Send CRM notifications via Telegram Bot API.
 * Config shape: { botToken: string, chatId: string }
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';

interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

export async function sendTelegramNotification(
  orgId: string,
  config: TelegramConfig,
): Promise<{ direction: 'export'; recordCount: number; status: 'success' | 'failed'; errorMessage?: string }> {
  const { botToken, chatId } = config;

  if (!botToken || !chatId) {
    return { direction: 'export', recordCount: 0, status: 'failed', errorMessage: 'Missing botToken or chatId' };
  }

  // Build daily summary
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [newContacts, todayMessages, pendingAppointments] = await Promise.all([
    prisma.contact.count({ where: { orgId, createdAt: { gte: today } } }),
    prisma.message.count({
      where: { conversation: { orgId }, createdAt: { gte: today } },
    }),
    prisma.appointment.count({
      where: { orgId, status: 'scheduled', appointmentDate: { gte: today } },
    }),
  ]);

  const text = [
    '📊 *ZaloCRM — Tóm tắt hôm nay*',
    '',
    `👤 Khách hàng mới: ${newContacts}`,
    `💬 Tin nhắn: ${todayMessages}`,
    `📅 Lịch hẹn chờ: ${pendingAppointments}`,
    '',
    `🕐 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
  ].join('\n');

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error('[telegram-bot] API error:', body);
      return { direction: 'export', recordCount: 0, status: 'failed', errorMessage: `Telegram API ${response.status}: ${body.slice(0, 200)}` };
    }

    logger.info(`[telegram-bot] Sent daily summary to chat ${chatId}`);
    return { direction: 'export', recordCount: 1, status: 'success' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { direction: 'export', recordCount: 0, status: 'failed', errorMessage: msg };
  }
}

// ── AN AN anti-lock 2026-08-13: cảnh báo VẬN HÀNH tức thời qua Telegram ────────
// Khác daily summary ở trên (chạy theo lịch sync-engine), helper này để các module
// nền (zalo-pool) bắn alert NGAY khi 1 số Zalo cần người can thiệp: rớt phiên phải
// quét lại QR, circuit breaker ngắt. Đọc config từ Integration type='telegram'
// enabled của org (cache 5 phút). Fire-and-forget — lỗi chỉ log, không throw.

const opsAlertConfigCache = new Map<string, { cfg: { botToken: string; chatId: string } | null; expiresAt: number }>();
const OPS_ALERT_CACHE_TTL_MS = 5 * 60_000;
// Chống spam: cùng 1 key alert chỉ bắn lại sau 30 phút.
const opsAlertLastSent = new Map<string, number>();
const OPS_ALERT_DEDUP_MS = 30 * 60_000;

async function getTelegramConfig(orgId: string): Promise<{ botToken: string; chatId: string } | null> {
  const hit = opsAlertConfigCache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.cfg;
  let cfg: { botToken: string; chatId: string } | null = null;
  try {
    const integ = await prisma.integration.findFirst({
      where: { orgId, type: 'telegram', enabled: true },
      select: { config: true },
    });
    const c = integ?.config as { botToken?: string; chatId?: string } | null;
    if (c?.botToken && c?.chatId) cfg = { botToken: c.botToken, chatId: c.chatId };
  } catch (err) {
    logger.warn('[telegram-ops] đọc Integration telegram lỗi:', err);
  }
  opsAlertConfigCache.set(orgId, { cfg, expiresAt: Date.now() + OPS_ALERT_CACHE_TTL_MS });
  return cfg;
}

/**
 * Bắn 1 alert vận hành tới nhóm Telegram của org. `dedupKey` (vd `qr:<accountId>`)
 * chặn lặp trong 30 phút. Trả về true nếu đã gửi.
 */
export async function sendTelegramOpsAlert(orgId: string, text: string, dedupKey?: string): Promise<boolean> {
  if (dedupKey) {
    const last = opsAlertLastSent.get(dedupKey) ?? 0;
    if (Date.now() - last < OPS_ALERT_DEDUP_MS) return false;
  }
  const cfg = await getTelegramConfig(orgId);
  if (!cfg) return false; // org chưa cấu hình Telegram — im lặng (không phải lỗi)
  try {
    const response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.error(`[telegram-ops] API ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return false;
    }
    if (dedupKey) opsAlertLastSent.set(dedupKey, Date.now());
    return true;
  } catch (err) {
    logger.warn('[telegram-ops] gửi alert lỗi:', err);
    return false;
  }
}
