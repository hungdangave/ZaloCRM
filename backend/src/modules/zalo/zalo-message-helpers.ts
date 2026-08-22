// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * zalo-message-helpers.ts — utilities for processing incoming Zalo messages.
 * Detects content type from msgType and updates contact avatars fire-and-forget.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

// Well-known msgType keyword patterns — used to suppress noise logging
const KNOWN_MSG_TYPE_PATTERNS = [
  'photo', 'image', 'sticker', 'video', 'voice',
  'gif', 'link', 'location', 'file', 'doc',
  'recommended', 'card', 'bank', 'transfer',
  'call', 'voip', 'qr', 'remind', 'todo',
  'poll', 'vote', 'note', 'forward',
];

/**
 * Map zca-js msgType string to a normalized content type label.
 * Falls back to 'text' for unrecognised types or plain-string content.
 */
export function detectContentType(msgType: string | undefined, content: any): string {
  if (!msgType) return 'text';

  // ── FIX 2026-05-21: action-based dispatch PHẢI chạy trước msgType keyword check ──
  // Zalo wrap call/bank/qr trong cùng family "recommended.*" → nếu để keyword check
  // "recommended/card" ăn trước, call message sẽ bị classify nhầm thành 'contact_card'
  // (KH gọi 39s lúc 12:10 = content_type='contact_card' thay vì 'call' → bị bỏ qua
  // trong engagement call_count). Lưu ý: Zalo có typo "recommened" (thiếu chữ 'd') —
  // match cả 2 để safe.
  if (typeof content === 'object' && content !== null) {
    const action = typeof content.action === 'string' ? content.action : '';
    if (action.includes('calltime') || action.includes('misscall')) return 'call';
    if (action === 'zinstant.bankcard') return 'bank_transfer';
    if (typeof content.description === 'string' && content.description.includes('qrCodeUrl')) {
      return 'qr_code';
    }
    // FIX G1 2026-05-21: action="recommened.link" / "recommended.link" = KH share link
    // có preview (FB reel, Maps, YouTube...) — lẽ ra phải là 'link', không phải 'contact_card'.
    // 635 row cũ bị classify sai vì rơi vào keyword check "recommended/card" ở dưới.
    // Yêu cầu thêm href hợp lệ để tránh false-positive với link rỗng.
    if (
      (action === 'recommened.link' || action === 'recommended.link') &&
      typeof content.href === 'string' && content.href.startsWith('http')
    ) {
      return 'link';
    }
    // Fallback shape detection cho call (1 số SDK version dùng key khác)
    if (content.callDuration !== undefined || content.callType !== undefined) return 'call';
  }

  if (msgType.includes('photo') || msgType.includes('image')) return 'image';
  if (msgType.includes('sticker')) return 'sticker';
  if (msgType.includes('video')) return 'video';
  if (msgType.includes('voice')) return 'voice';
  if (msgType.includes('gif')) return 'gif';
  if (msgType.includes('link')) return 'link';
  if (msgType.includes('location')) return 'location';
  if (msgType.includes('file') || msgType.includes('doc')) return 'file';
  if (msgType.includes('recommended') || msgType.includes('card')) return 'contact_card';

  // Special message types
  if (msgType.includes('bank') || msgType.includes('transfer')) return 'bank_transfer';
  if (msgType.includes('call') || msgType.includes('voip')) return 'call';
  if (msgType.includes('qr')) return 'qr_code';
  if (msgType.includes('remind') || msgType.includes('todo')) return 'reminder';
  if (msgType.includes('poll') || msgType.includes('vote')) return 'poll';
  if (msgType.includes('note')) return 'note';
  if (msgType.includes('forward')) return 'forwarded';

  // Check content object shape for action-based messages
  if (typeof content === 'object' && content !== null) {
    const action = typeof content.action === 'string' ? content.action : '';
    // Zalo dùng action "recommened.calltime" (gọi thành công) / "recommened.misscall" (nhỡ)
    // Lưu ý typo "recommened" thay vì "recommended" — match cả 2.
    if (action.includes('calltime') || action.includes('misscall')) return 'call';
    if (action === 'msginfo.actionlist' || action === 'rtf') {
      // rtf = rich-text-format (bot Smax/Zalo gửi) — vẫn rich
      if (action === 'msginfo.actionlist') return 'reminder';
    }
    // QR Code (VietQR/bank): description chứa JSON string với key qrCodeUrl
    // Zalo lưu dưới contact_card variant — detect bằng content shape thay vì msgType
    if (typeof content.description === 'string' && content.description.includes('qrCodeUrl')) {
      return 'qr_code';
    }
    // Bank account card (zinstant variant): action='zinstant.bankcard', title/href trống,
    // bank info ở params.item.data_url (zinstant HTML render URL).
    if (action === 'zinstant.bankcard' || (typeof content.params === 'string' && content.params.includes('zinstant.bankcard'))) {
      return 'bank_transfer';
    }
    if (content.bankCode || content.bankName) return 'bank_transfer';
    if (content.callDuration !== undefined || content.callType) return 'call';
    // Link auto-unfurl: có thumb + href + action rỗng (không phải reminder/call/bank)
    // Zalo msgType cho link đôi khi chỉ là 'webchat' hoặc rỗng → detect bằng shape
    if (
      typeof content.href === 'string' && content.href.startsWith('http') &&
      (typeof content.thumb === 'string' || typeof content.title === 'string') &&
      !action
    ) {
      return 'link';
    }

    // Log unknown types for analysis before returning rich
    if (!KNOWN_MSG_TYPE_PATTERNS.some((p) => msgType.includes(p))) {
      logger.info(`[zalo:msgType] Unknown object type: "${msgType}" action="${action}"`, {
        contentKeys: Object.keys(content),
      });
    }
    return 'rich';
  }

  // Log unknown string-content types for discovery
  if (!KNOWN_MSG_TYPE_PATTERNS.some((p) => msgType.includes(p))) {
    logger.info(`[zalo:msgType] Unknown string type: "${msgType}"`, {
      contentPreview: typeof content === 'string' ? content.slice(0, 100) : undefined,
    });
  }

  return 'text';
}

export interface AlbumInfo {
  albumKey: string | null;
  albumIndex: number | null;
  albumTotal: number | null;
}

/**
 * Extract multi-image album metadata from Zalo content payload.
 * Zalo tags each photo in an album with a shared group_layout_id and position.
 */
export function extractAlbumInfo(contentType: string, rawContent: unknown): AlbumInfo {
  const empty: AlbumInfo = { albumKey: null, albumIndex: null, albumTotal: null };
  if (contentType !== 'image' || typeof rawContent !== 'object' || rawContent === null) return empty;
  const paramsRaw = (rawContent as Record<string, unknown>).params;
  let params: Record<string, unknown> | null = null;
  try {
    params = typeof paramsRaw === 'string' ? JSON.parse(paramsRaw) : (paramsRaw as Record<string, unknown> | null);
  } catch {
    return empty;
  }
  if (!params || !params.is_group_layout || !params.group_layout_id) return empty;
  const idx = Number(params.id_in_group);
  const total = Number(params.total_item_in_group);
  return {
    albumKey: String(params.group_layout_id),
    albumIndex: Number.isFinite(idx) ? idx : null,
    albumTotal: Number.isFinite(total) ? total : null,
  };
}

/**
 * Fire-and-forget: fill in a missing avatarUrl on a Contact row.
 * Only updates rows where avatarUrl is currently null.
 */
export function updateContactAvatar(zaloUid: string, avatarUrl: string): void {
  prisma.contact
    .updateMany({
      where: { zaloUid, avatarUrl: null },
      data: { avatarUrl },
    })
    .catch(() => {});
}

/**
 * Rút SỐ ĐIỆN THOẠI khách chia sẻ qua danh thiếp Zalo (AN AN 22/08/2026).
 *
 * BỆNH: khách gửi số qua danh thiếp → hệ chỉ lưu ảnh QR, KHÔNG lấy số. Nhân viên phải
 * nhắn ngược "phần mềm bên em không hiện số, chị gọi cho em một cuộc để em lấy số"
 * (đọc được nguyên văn trong hội thoại thật). Trong khi số NẰM SẴN trong dữ liệu:
 *   content.description = '{"phone":"0705594993","caption":"0705594993","qrCodeUrl":"..."}'
 * — một chuỗi JSON LỒNG bên trong, nên nhìn lướt tưởng chỉ có ảnh QR.
 *
 * Trả '' nếu không tìm thấy số hợp lệ. KHÔNG đoán bừa: chỉ nhận 9-12 chữ số.
 */
export function rutSoDienThoaiTuDanhThiep(rawContent: unknown): string {
  if (typeof rawContent !== 'object' || rawContent === null) return '';
  const c = rawContent as Record<string, unknown>;
  let goc: Record<string, unknown> = {};
  if (typeof c.description === 'string') {
    try { goc = JSON.parse(c.description) ?? {}; } catch { return ''; }
  } else if (c.description && typeof c.description === 'object') {
    goc = c.description as Record<string, unknown>;
  }
  for (const khoa of ['phone', 'caption']) {
    const v = goc[khoa];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const so = String(v).replace(/[^\d]/g, '');
    if (so.length >= 9 && so.length <= 12) return String(v).trim();
  }
  return '';
}

/**
 * Rút SỐ ĐIỆN THOẠI khách tự gõ trong tin nhắn text (AN AN 22/08/2026).
 *
 * Chỉ 176/56.226 hồ sơ khách có SĐT (0,3%) — trong khi khách VẪN gửi số, chỉ là hệ không
 * giữ lại. Không có SĐT thì không lên đơn được, nên đây là nút thắt của cả lộ trình tự động.
 *
 * ⚠️ NHẶT SỐ TRONG VĂN BẢN TỰ DO RẤT DỄ SAI. Soi 110 ca thật trong CSDL thấy 3 kiểu bẫy:
 *   1. **Mã số thuế** — "MST: 0317182253" cũng là 10 số bắt đầu bằng 0, khớp y hệt SĐT.
 *   2. **Hotline của DOANH NGHIỆP KHÁC** — tin tự động "TravelJet xin chào… Hotline: 09…",
 *      "Em Thu Hiền Vinfast xin chào…". Số đó KHÔNG phải của khách.
 *   3. **Tin rao/quảng cáo** gửi vào — "BÁN CĂN HỘ… 88m²… 09…", "TRIỂN LÃM…".
 * Ghi nhầm một số vào hồ sơ khách còn TỆ HƠN bỏ sót: gọi nhầm người, giao nhầm hàng.
 * Nên ở đây ưu tiên CHÍNH XÁC hơn là bắt được nhiều.
 *
 * LUẬT:
 *  - Chỉ nhận tin CỦA KHÁCH (không nhận tin nhân viên tự gửi).
 *  - Loại khi có dấu hiệu doanh nghiệp/tự động/rao vặt/mã số thuế.
 *  - Chỉ nhận khi khách đang ĐƯA thông tin của mình (có "sđt/số điện thoại/địa chỉ/gửi/gọi…")
 *    hoặc tin gần như chỉ có mỗi con số.
 *  - Chuẩn hoá 84…/+84… → 0…; chỉ nhận đúng 10 số, đầu số di động VN hợp lệ (3/5/7/8/9).
 *  - Loại số của CHÍNH MÌNH (hotline + nick) — caller truyền vào qua soCuaMinh.
 */
const DAU_HIEU_LOAI = [
  /mst|mã số thuế|ma so thue/,
  /hotline|tổng đài|tong dai/,
  /xin chào|cảm ơn (bạn|anh\/chị|quý)|website|https?:\/\//,
  /bán căn hộ|cho thuê|chính chủ|m²|xuất hóa đơn|triển lãm|diễn đàn/,
];
const DAU_HIEU_NHAN = /sđt|sdt|số điện thoại|so dien thoai|số đt|liên hệ|gọi|giao|địa chỉ|đc:|dc:|gửi|nhận/;

export function rutSoDienThoaiTuTinNhan(
  noiDung: unknown,
  opts: { cuaKhach: boolean; soCuaMinh?: Set<string> } = { cuaKhach: false },
): string {
  if (!opts.cuaKhach || typeof noiDung !== 'string' || !noiDung.trim()) return '';
  const thuong = noiDung.toLowerCase();
  if (DAU_HIEU_LOAI.some((re) => re.test(thuong))) return '';

  const gon = noiDung.replace(/[\s.\-()]/g, '');
  const khop = gon.match(/(?:\+?84|0)(?:3|5|7|8|9)[0-9]{8}/);
  if (!khop) return '';

  let so = khop[0];
  if (so.startsWith('+84')) so = '0' + so.slice(3);
  else if (so.startsWith('84')) so = '0' + so.slice(2);
  if (so.length !== 10) return '';
  if (opts.soCuaMinh?.has(so)) return '';

  // Khách phải đang ĐƯA số của mình — hoặc tin ngắn tới mức gần như chỉ có con số.
  if (!DAU_HIEU_NHAN.test(thuong) && gon.length > 20) return '';
  return so;
}
