// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * export-guard.ts — KHOÁ + GHI SỔ mọi lối XUẤT TỆP dữ liệu khách (AN AN 20/08/2026).
 *
 * ══ VÌ SAO CÓ FILE NÀY ══
 * CEO chốt mở quyền cho 5 bạn CSKH dùng chung cả 36 nick (gỡ 11,4% ca tắc). Đổi lại,
 * mỗi người sẽ NHÌN THẤY toàn bộ ~56.000 khách thay vì phần của mình. Rủi ro đi kèm
 * không phải "xem" — mà là **mang cả tệp khách ra ngoài**.
 *
 * ══ RÀ SOÁT TÌM ĐƯỢC 3 LỐI XUẤT ══
 *   1. `/api/v1/reports/export` (xlsx: tin nhắn / KHÁCH HÀNG / lịch hẹn)
 *      → đã có rào `gateReportAccess`: member thường bị 403. **Đang an toàn.**
 *   2. `/api/v1/timeline/export` (CSV lịch sử 1 khách)
 *      → **KHÔNG có rào nào** — ai đăng nhập cũng xuất được. Lỗ thật.
 *   3. 2 nút "Xuất CSV" ở màn Bạn bè → chỉ là nút giả, chưa nối gì (console.log).
 *
 * ⚠️ Và điều nguy hiểm nhất: **KHÔNG lối nào ghi lại dấu vết**. Người xuất xong, không
 * ai biết. Trong khi mọi tin nhắn / thao tác khác đều có nhật ký (92.758 dòng).
 * → Nghĩa là trước đây "khoá nick" chặn được người tò mò, nhưng KHÔNG chặn được người
 *   thật sự muốn lấy tệp — mà lại còn không để lại vết để truy.
 *
 * ══ FILE NÀY LÀM 2 VIỆC ══
 *   `chanXuatTep()` — chỉ chủ tài khoản / quản trị mới được xuất. Nhân viên → 403.
 *   `ghiSoXuatTep()` — ghi nhật ký MỌI lần xuất (ai, xuất gì, bao nhiêu dòng, lúc nào),
 *                      kể cả lần bị từ chối, để còn biết ai đang thử.
 *
 * 📌 Ghi sổ chạy "best-effort": nhật ký hỏng thì KHÔNG được làm hỏng việc xuất của sếp.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../database/prisma-client.js';
import { logger } from '../utils/logger.js';

const VAI_TRO_DUOC_XUAT = new Set(['owner', 'admin']);

/**
 * Chặn nhân viên xuất tệp dữ liệu khách.
 * Trả true nếu được phép đi tiếp; nếu không, đã gửi 403 và trả false.
 */
export async function chanXuatTep(
  request: FastifyRequest,
  reply: FastifyReply,
  loaiTep: string,
): Promise<boolean> {
  const user = request.user!;
  if (VAI_TRO_DUOC_XUAT.has(user.role)) return true;

  await ghiSoXuatTep(request, loaiTep, { tuChoi: true });
  reply.status(403).send({
    error: 'Chỉ chủ tài khoản hoặc quản trị mới được xuất dữ liệu khách hàng.',
    code: 'export_forbidden',
  });
  return false;
}

/** Ghi nhật ký một lần xuất tệp (hoặc một lần bị từ chối). */
export async function ghiSoXuatTep(
  request: FastifyRequest,
  loaiTep: string,
  thongTin: { soDong?: number; tuChoi?: boolean; chiTiet?: Record<string, unknown> } = {},
): Promise<void> {
  const user = request.user!;
  try {
    await prisma.activityLog.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        actorType: 'user',
        category: 'security',
        action: thongTin.tuChoi ? 'export_denied' : 'export_data',
        entityType: 'export',
        entityId: loaiTep,
        details: {
          loaiTep,
          soDong: thongTin.soDong ?? null,
          tuChoi: !!thongTin.tuChoi,
          vaiTro: user.role,
          ip: request.ip,
          ...(thongTin.chiTiet ?? {}),
        },
      },
    });
  } catch (err) {
    // Không được làm hỏng việc xuất chỉ vì ghi sổ lỗi — nhưng phải kêu to trong log.
    logger.error(`[export-guard] KHÔNG ghi được nhật ký xuất tệp "${loaiTep}":`, err);
  }
}
