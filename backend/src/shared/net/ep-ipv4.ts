// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * ep-ipv4.ts — ÉP TOÀN BỘ KẾT NỐI RA ĐI BẰNG IPv4 (AN AN 17/08/2026).
 *
 * ══ BỆNH ══
 * Quét QR xong, xác nhận trên điện thoại xong, rồi chết ở bước cuối:
 *   `ZcaApiError: Cannot get session, login failed`
 * Lỗi gốc (chỉ thấy được sau khi bật ZALO_SDK_LOGGING=1):
 *   TypeError: fetch failed  ←  AggregateError [ETIMEDOUT] (4 địa chỉ, hỏng cả 4)
 *   tại checkSession() → request() → request() → request()   (chuỗi chuyển hướng)
 *
 * ══ GỐC RỄ ══
 * Máy chủ này **KHÔNG có đường ra IPv6** (`ip -6 route` rỗng, 0 địa chỉ IPv6 global).
 * Nhưng Node ≥20 bật sẵn `autoSelectFamily` (Happy Eyeballs, RFC 8305) — nó ƯU TIÊN thử
 * IPv6 trước. Các máy chủ Zalo dùng cho phiên chat CÓ bản ghi AAAA thật:
 *   chat.zalo.me      → 2 IPv4 + 2 IPv6  (đúng 4 địa chỉ = khớp "4 lỗi" trong AggregateError)
 *   wpa.chat.zalo.me  → 2 IPv4 + 2 IPv6
 * → mọi kết nối tới các máy chủ đó treo ở IPv6 rồi hết giờ.
 *
 * `id.zalo.me` KHÔNG có AAAA thật (chỉ là IPv4 khoác áo `::ffff:`) nên luôn chạy tốt —
 * đó là lý do QR **sinh ra được** (qua id.zalo.me) nhưng **lấy phiên thì hỏng** (qua chat.zalo.me).
 * Một triệu chứng "lúc được lúc không" hoàn toàn giải thích được, không hề ngẫu nhiên.
 *
 * ══ ĐO ĐỐI CHỨNG (cùng máy, cùng lúc, chỉ đổi 1 biến) ══
 *   mặc định : chat.zalo.me 0/10 · wpa.chat.zalo.me 0/10 · id.zalo.me 10/10
 *   ép IPv4  : chat.zalo.me 10/10 · wpa.chat.zalo.me 10/10 · id.zalo.me 10/10
 *
 * ══ VÁ ══
 * Tắt Happy Eyeballs + xếp IPv4 lên trước. Không đụng gì tới hệ điều hành, không cần
 * proxy, và tự vô hại nếu sau này máy chủ có IPv6 thật (chỉ việc đặt ZALO_ALLOW_IPV6=1).
 *
 * ⚠️ PHẢI được import ĐẦU TIÊN trong app.ts — trước mọi module có thể mở kết nối.
 *   Cụ thể: `import './shared/net/ep-ipv4.js';` đặt trên cùng danh sách import.
 *   Module này tự chạy khi được nạp (side-effect). KHÔNG gọi hàm ở thân app.ts, vì
 *   JavaScript nâng (hoist) TOÀN BỘ lệnh import lên trước mọi câu lệnh — gọi hàm ở thân
 *   sẽ chạy SAU khi mọi module khác đã nạp xong, tức là quá muộn.
 *
 * 📌 Bài học: "mạng vẫn tốt" là kết luận SAI nếu chỉ thử một địa chỉ. Máy chủ gọi được
 * id.zalo.me nên tôi tưởng mạng lành; thật ra nó gãy đúng ở nhóm địa chỉ có IPv6.
 * Khi đo mạng, phải đo ĐÚNG địa chỉ mà mã nguồn thật sự gọi tới.
 */
import dns from 'node:dns';
import net from 'node:net';
import { logger } from '../utils/logger.js';

export function epKetNoiIPv4(): void {
  if (process.env.ZALO_ALLOW_IPV6 === '1') {
    logger.info('[net] ZALO_ALLOW_IPV6=1 → giữ nguyên hành vi mặc định của Node (có thử IPv6)');
    return;
  }

  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch (err) {
    logger.warn('[net] không đặt được thứ tự DNS ưu tiên IPv4:', err);
  }

  try {
    // Có từ Node 18.13/20. Tắt hẳn Happy Eyeballs → chỉ dùng họ địa chỉ đầu tiên (IPv4).
    net.setDefaultAutoSelectFamily?.(false);
  } catch (err) {
    logger.warn('[net] không tắt được autoSelectFamily:', err);
  }

  logger.info('[net] đã ép mọi kết nối ra đi bằng IPv4 (máy chủ không có đường ra IPv6)');
}

// Chạy ngay lúc nạp module — xem giải thích "hoist" ở đầu file.
epKetNoiIPv4();
