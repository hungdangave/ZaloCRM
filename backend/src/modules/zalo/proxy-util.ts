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

/**
 * Bật GIỮ NHỊP TCP trên mọi socket do agent proxy tạo ra (AN AN 17/08/2026).
 *
 * BỆNH: 7 nick Zalo rớt kết nối **106 lần trong 60 phút**, mã 1006 (đứt đột ngột).
 * Máy chủ chỉ tải 1.78/4 nhân, mạng 0% mất gói → không phải máy yếu cũng không phải mạng.
 * Đọc nhật ký thấy quy luật cứng: mỗi phiên sống **đúng ~2 phút** rồi đứt, lặp lại chính xác
 * trên MỌI nick, kể cả các nick đi qua cổng proxy khác nhau.
 *
 * GỐC RỄ: cả 9 proxy đều qua CÙNG một máy chủ cổng `ip.mproxy.vn` (chỉ khác số cổng), và
 * cổng đó **đóng đường hầm khi không có dữ liệu ~2 phút**. Trong khi đó zca-js chỉ gửi
 * tín hiệu giữ nhịp theo chu kỳ `settings.features.socket.ping_interval` do CHÍNH ZALO quy
 * định (thường ~3 phút) → đường hầm chết TRƯỚC khi nhịp đầu tiên kịp gửi. Với tài khoản mới,
 * chưa có tin nhắn nào chạy qua, WebSocket im lặng hoàn toàn → luôn chạm ngưỡng đó.
 *
 * VÁ: bật giữ nhịp ở TẦNG TCP — hệ điều hành tự gửi gói thăm dò mỗi 30 giây, sớm hơn ngưỡng
 * 2 phút của proxy. Đường hầm không bao giờ bị coi là "im lặng". Cách này độc lập hoàn toàn
 * với chu kỳ ping của zca-js/Zalo nên không sợ Zalo đổi cấu hình.
 * Kèm `setNoDelay` để tin nhắn nhỏ đi ngay, không nằm chờ gom gói.
 */
function giuNhipTCP<T>(agent: T): T {
  const goc = (agent as any).connect;
  if (typeof goc !== 'function') return agent;
  (agent as any).connect = async function (...args: unknown[]) {
    const socket: any = await goc.apply(this, args);
    try {
      socket?.setKeepAlive?.(true, 30_000);
      socket?.setNoDelay?.(true);
    } catch {
      /* socket lạ không hỗ trợ — bỏ qua, không được làm hỏng kết nối vì việc phụ này */
    }
    return socket;
  };
  return agent;
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
  // Không proxy → vẫn PHẢI trả polyfill có thử-lại (xem fetchThuLai): đường mạng từ máy chủ
  // tới chat.zalo.me thỉnh thoảng rơi vào hố đen, mà zca-js không thử lại lần nào.
  if (!proxyUrl || !proxyUrl.trim()) return { polyfill: fetchThuLai as unknown };

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
    agent = giuNhipTCP(new HttpsProxyAgent(trimmed));
  } else if (proto === 'socks' || proto === 'socks4' || proto === 'socks5' || proto === 'socks5h') {
    agent = giuNhipTCP(new SocksProxyAgent(trimmed));
  } else {
    throw new Error(`Proxy scheme "${proto}" không hỗ trợ (account ${accountId ?? '?'}) — dùng http/https/socks5`);
  }

  logger.info(`[proxy:${accountId ?? '?'}] dùng proxy ${maskProxyUrl(trimmed)} (agent per-account, áp cho cả fetch + WebSocket)`);
  // node-fetch tôn trọng options.agent mà zca-js truyền vào từng request.
  return { agent, polyfill: fetchGiuCookie as unknown };
}

/**
 * fetch CÓ THỬ LẠI khi kết nối rơi vào hố đen (AN AN 17/08/2026).
 *
 * ══ BỆNH ══
 * Sau khi vá IPv4 (xem shared/net/ep-ipv4.ts), lỗi đăng nhập ĐỔI HÌNH DẠNG — bằng chứng
 * bản vá đó có tác dụng — nhưng vẫn hỏng:
 *   ConnectTimeoutError (attempted address: chat.zalo.me:443, timeout: 10000ms)
 *
 * ══ ĐO ĐƯỢC GÌ ══
 * Đường mạng từ máy chủ tới Zalo về cơ bản RẤT TỐT: ping 0% mất gói, độ trễ ~1,1ms
 * (cùng hạ tầng trong nước), bắt tay TCP trung bình ~104ms. NHƯNG **một tỉ lệ nhỏ kết nối
 * rơi vào hố đen** — không bị từ chối, không báo lỗi, chỉ im lặng tới khi hết giờ 10 giây:
 *   49.213.95.230 (id.zalo.me)   20/20 tốt
 *   49.213.95.122 (chat.zalo.me) 18/20 tốt  ← 2 lần treo
 * Ping 0% mất gói mà TCP vẫn treo → nghẽn/lọc ở tầng TCP, không phải đứt đường.
 *
 * ══ VÌ SAO MỘT LẦN TREO LÀM HỎNG CẢ LẦN ĐĂNG NHẬP ══
 * `checkSession` đi qua CHUỖI CHUYỂN HƯỚNG 3-4 chặng, và **zca-js không thử lại lần nào**:
 * chỉ cần 1 chặng treo là toàn bộ lần quét QR đổ, người dùng phải quét lại từ đầu.
 * Với ~10% mỗi chặng, xác suất hỏng cả lượt lên tới ~30-40% — khớp với việc "lúc được lúc không".
 *
 * ══ VÁ ══
 * Thử lại tối đa 3 lần, chỉ khi lỗi ở TẦNG KẾT NỐI (chưa hề nhận được phản hồi từ máy chủ).
 * An toàn kể cả với POST: yêu cầu chưa bao giờ tới nơi thì không thể gây tác dụng phụ trùng lặp.
 * TUYỆT ĐỐI không thử lại khi máy chủ ĐÃ trả lời (dù là lỗi 4xx/5xx) — lúc đó thử lại
 * có thể gửi trùng tin nhắn.
 */
const SO_LAN_THU = 3;
const MA_LOI_KET_NOI = new Set([
  'UND_ERR_CONNECT_TIMEOUT', // undici: bắt tay không xong trong 10s (hố đen)
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',               // DNS tạm thời không trả lời
  'ENOTFOUND',
  'EPIPE',
]);

function laLoiKetNoi(err: unknown): boolean {
  const nguyenNhan = (err as { cause?: { code?: string } })?.cause;
  const ma = nguyenNhan?.code ?? (err as { code?: string })?.code;
  return typeof ma === 'string' && MA_LOI_KET_NOI.has(ma);
}

function nghi(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function thuLai<T>(goi: () => Promise<T>, nhan: string): Promise<T> {
  let loiCuoi: unknown;
  for (let lan = 1; lan <= SO_LAN_THU; lan++) {
    try {
      return await goi();
    } catch (err) {
      loiCuoi = err;
      if (!laLoiKetNoi(err) || lan === SO_LAN_THU) throw err;
      const cho = 300 * lan; // 300ms, 600ms — đủ để hố đen trôi qua, không làm người dùng chờ lâu
      logger.warn(
        `[net] kết nối tới ${nhan.slice(0, 60)} hỏng ở tầng kết nối (lần ${lan}/${SO_LAN_THU}), thử lại sau ${cho}ms`,
      );
      await nghi(cho);
    }
  }
  throw loiCuoi;
}

/** fetch gốc (không proxy) + vòng thử lại. Dùng khi chạy thẳng IP máy chủ. */
async function fetchThuLai(url: unknown, init?: unknown): Promise<unknown> {
  return thuLai(() => fetch(url as string, init as RequestInit), String(url));
}

/**
 * node-fetch KÈM `getSetCookie()` — vá lỗi ĐĂNG NHẬP QR (AN AN 16/08/2026).
 *
 * BỆNH: sau khi ta đổi sang node-fetch (bắt buộc, vì fetch gốc bỏ qua `options.agent`
 * nên không đi proxy được), mọi lần quét QR đều chết ở bước cuối với `Can't login`.
 * Quét ✅ xác nhận trên máy ✅ nhưng `getUserInfo` trả `logged: false`.
 *
 * GỐC RỄ: zca-js đọc cookie bằng
 *     if (typeof response.headers.getSetCookie === "function") { ... } else { split(", ") }
 * `Headers` của node-fetch 3.3.2 KHÔNG có `getSetCookie()` (fetch gốc/undici thì CÓ),
 * nên rơi vào nhánh dự phòng cắt chuỗi bằng dấu phẩy. Chính chú thích trong zca-js cảnh báo:
 * cách đó làm vỡ cookie chứa ngày hết hạn (`Expires=Wed, 18 Mar 2026...`) → **mất `zpsid`
 * và `zpw_sek`**, đúng 2 cookie quyết định phiên đăng nhập QR.
 *
 * CÁCH VÁ: bọc node-fetch, gắn thêm `getSetCookie()` lấy từ `headers.raw()['set-cookie']`
 * (node-fetch giữ nguyên MẢNG set-cookie ở đó, không hề mất mát). zca-js thấy hàm này thì
 * đi nhánh đúng, cookie nguyên vẹn.
 *
 * Bài học: đổi tầng mạng bên dưới một thư viện là đổi cả những hành vi nó ngầm dựa vào —
 * ở đây là một hàm chỉ có trên Headers chuẩn WHATWG.
 */
async function fetchGiuCookie(url: unknown, init?: unknown): Promise<unknown> {
  // Đường qua proxy cũng có thể treo → dùng chung vòng thử lại (xem fetchThuLai).
  const res: any = await thuLai(() => (nodeFetch as any)(url, init), String(url));
  if (res?.headers && typeof res.headers.getSetCookie !== 'function') {
    res.headers.getSetCookie = () => {
      try {
        return res.headers.raw()['set-cookie'] ?? [];
      } catch {
        return [];
      }
    };
  }
  return res;
}
