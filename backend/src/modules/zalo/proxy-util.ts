// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * proxy-util.ts — per-account proxy THẬT cho zca-js (AN AN anti-lock 2026-08-13).
 *
 * VÌ SAO VIẾT LẠI: bản cũ set HTTP_PROXY/HTTPS_PROXY env quanh lời gọi login.
 * zca-js v2 dùng native fetch (undici) + ws — CẢ HAI đều KHÔNG đọc env proxy đó,
 * nên proxy per-account trên UI thực tế là NO-OP: 30 số vẫn chung 1 IP server,
 * và mọi traffic SAU login (gửi tin, WS keep-alive) càng không qua proxy.
 *
 * Cách đúng (zca-js hỗ trợ sẵn): truyền vào constructor `new Zalo({...})`:
 *   - `agent`   — http.Agent; zca-js gắn vào từng request fetch VÀ WebSocket listener.
 *   - `polyfill`— fetch thay thế; native undici fetch BỎ QUA `options.agent`,
 *                 node-fetch thì tôn trọng nó (đúng khuyến nghị trong docs zca-js:
 *                 "If using proxy, `node-fetch` is highly recommended").
 *
 * → Mỗi số Zalo giữ agent proxy RIÊNG suốt vòng đời phiên: login, gửi tin,
 *   keep-alive đều đi qua đúng proxy của số đó.
 */
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import nodeFetch from 'node-fetch';
import { logger } from '../../shared/utils/logger.js';

export interface ZaloNetworkOptions {
  agent?: unknown;      // http.Agent — zca-js type nhận Agent, pool require() nên dùng loose type
  polyfill?: unknown;   // fetch implementation
}

/** Che credential trong proxy URL khi ghi log: user:pass@host → ***@host */
export function maskProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) return `${u.protocol}//***:***@${u.host}`;
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(proxy URL không hợp lệ)';
  }
}

/**
 * Dựng {agent, polyfill} cho 1 số Zalo từ proxyUrl đã cấu hình.
 * - http:// https://          → HttpsProxyAgent (CONNECT tunnel).
 * - socks:// socks4:// socks5:// → SocksProxyAgent.
 * - null/rỗng                 → {} (kết nối thẳng, giữ native fetch).
 * - URL hỏng                  → THROW. Chủ đích fail-fast: thà số này không login
 *   còn hơn ÂM THẦM chạy IP thật của server (chính là rủi ro khoá cả cụm 30 số).
 */
export function buildZaloNetworkOptions(proxyUrl: string | null | undefined, accountId?: string): ZaloNetworkOptions {
  if (!proxyUrl || !proxyUrl.trim()) return {};

  const trimmed = proxyUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Proxy URL không hợp lệ cho account ${accountId ?? '?'} — kiểm tra lại cấu hình (dạng http://user:pass@host:port hoặc socks5://...)`);
  }

  const proto = parsed.protocol.replace(':', '').toLowerCase();
  let agent: unknown;
  if (proto === 'http' || proto === 'https') {
    agent = new HttpsProxyAgent(trimmed);
  } else if (proto === 'socks' || proto === 'socks4' || proto === 'socks5' || proto === 'socks5h') {
    agent = new SocksProxyAgent(trimmed);
  } else {
    throw new Error(`Proxy scheme "${proto}" không hỗ trợ (account ${accountId ?? '?'}) — dùng http/https/socks5`);
  }

  logger.info(`[proxy:${accountId ?? '?'}] dùng proxy ${maskProxyUrl(trimmed)} (agent per-account, áp cho cả fetch + WebSocket)`);
  // node-fetch tôn trọng options.agent mà zca-js truyền vào từng request.
  return { agent, polyfill: nodeFetch as unknown };
}
