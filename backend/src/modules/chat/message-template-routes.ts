// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * message-template-routes.ts — MẪU TIN NHẮN NHANH (AN AN 25/08/2026).
 *
 * ══ VÌ SAO CÓ FILE NÀY ══
 * Nhân viên CSKH xin "cấp quyền thêm/sửa mẫu tin nhắn". Kiểm ra thì KHÔNG PHẢI chuyện
 * quyền: `GET /api/v1/automation/templates` trả **404 — route chưa từng tồn tại**.
 * Bảng `message_templates` + `message_template_folders` đã có sẵn trong schema (thiết kế
 * đầy đủ: shortcut, contentRich, visibility, usageCount…) nhưng **chưa ai viết API**.
 * Giao diện gọi vào hư không nên popup luôn rỗng → nhân viên tưởng mình thiếu quyền.
 *
 * ══ VÌ SAO ĐÁNG LÀM TỬ TẾ (không chỉ là tiện ích nhỏ) ══
 * Đo 22/08: **98,4% tin nhắn gửi NGOÀI CRM** (`sent_via='user_native'`) → toàn bộ lớp
 * chống khoá (giãn nhịp, trần/nick) chỉ bảo vệ 1,6% lưu lượng. Nhân viên gửi ngoài vì
 * trong CRM **chậm hơn** — không có mẫu sẵn, phải gõ tay. Mẫu tin nhắn là cái móc kéo
 * lưu lượng trở lại dưới lớp bảo vệ: họ tự chuyển về khi trong CRM nhanh hơn.
 *
 * ══ LUẬT QUYỀN (cố ý giữ ĐƠN GIẢN) ══
 *  - Ai cũng tạo được mẫu, riêng tư hoặc dùng chung cả đội.
 *  - Chỉ **người tạo** hoặc **chủ/quản trị** mới sửa/xoá được — kể cả mẫu dùng chung.
 *  - Thấy được: mẫu của chính mình + mọi mẫu `public` trong org.
 * Không phát minh thêm tầng quyền mới: đội 5 người, thêm tầng chỉ đẻ ra vùng chết như
 * vụ `contact_access` (25/08) và vụ quyền nick (19/08).
 *
 * Xoá = **xoá mềm** (`archivedAt`) — mẫu lỡ tay xoá còn khôi phục được.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * Một ảnh kèm mẫu — chỉ giữ **mã ảnh trong kho media**, không nhúng bytes, không giữ URL
 * làm nguồn chân lý (URL kho có thể đổi; mã thì không).
 * Gửi đi bằng `POST /api/v1/media/:id/send` — đường SẴN CÓ, đã lo đủ: đóng dấu logo,
 * chặn nick riêng tư, chặn nick đã xoá, ghi tin vào CRM. KHÔNG viết lại phần gửi:
 * đó là chỗ dễ sinh lỗi nhất và đã có bản chạy tốt.
 */
interface AnhKem { mediaId: string; name?: string }

interface ThanMau {
  name?: string;
  content?: string;
  contentRich?: unknown;
  shortcut?: string | null;
  category?: string | null;
  tagIds?: string[];
  visibility?: string;
  attachments?: AnhKem[];
}

/** Rút text thuần từ contentRich nếu người dùng chỉ gửi bản có định dạng. */
function layNoiDungThuan(than: ThanMau): string {
  if (typeof than.content === 'string' && than.content.trim()) return than.content;
  const rich = than.contentRich as { text?: unknown } | null | undefined;
  return typeof rich?.text === 'string' ? rich.text : '';
}

/** Chuẩn hoá gõ tắt: bỏ dấu '/', thường hoá, bỏ khoảng trắng. */
function chuanHoaGoTat(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^\/+/, '').replace(/\s+/g, '').toLowerCase();
  return s || null;
}

/**
 * Lọc danh sách ảnh kèm: chỉ nhận URL http(s), tối đa 12 ảnh.
 * 12 là TRẦN CỦA ZALO cho một cụm album — gửi hơn thì SDK cắt, nên chặn ngay từ đầu
 * cho người dùng biết, thay vì để họ tưởng đã gửi đủ (send-block từng dính lỗi này).
 */
const TRAN_ANH_MOI_MAU = 12;
function locAnhKem(v: unknown): AnhKem[] {
  if (!Array.isArray(v)) return [];
  const ra: AnhKem[] = [];
  const daCo = new Set<string>();
  for (const it of v) {
    const mediaId = typeof it?.mediaId === 'string' ? it.mediaId.trim() : '';
    if (!mediaId || daCo.has(mediaId)) continue; // khử trùng: gửi 2 lần cùng 1 ảnh là lỗi
    daCo.add(mediaId);
    ra.push({
      mediaId,
      ...(typeof it?.name === 'string' && it.name ? { name: it.name.slice(0, 200) } : {}),
    });
    if (ra.length >= TRAN_ANH_MOI_MAU) break;
  }
  return ra;
}

function laChuHoacQuanTri(role?: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function messageTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── DANH SÁCH: mẫu của mình + mẫu dùng chung của org ─────────────────────
  app.get('/api/v1/automation/templates', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const rows = await prisma.messageTemplate.findMany({
        where: {
          orgId: user.orgId,
          archivedAt: null,
          OR: [{ ownerUserId: user.id }, { visibility: 'public' }],
        },
        orderBy: [{ usageCount: 'desc' }, { updatedAt: 'desc' }],
        take: 500,
      });
      return {
        templates: rows.map((t) => ({
          id: t.id,
          name: t.name,
          shortcut: t.shortcut,
          content: t.content,
          contentRich: t.contentRich,
          category: t.category,
          tagIds: t.tagIds,
          attachments: (t.attachments as AnhKem[] | null) ?? [],
          visibility: t.visibility,
          // Giao diện dùng cờ này để tách nhóm "Của tôi" / "Cả đội".
          isPersonal: t.ownerUserId === user.id,
          canEdit: t.createdById === user.id || t.ownerUserId === user.id || laChuHoacQuanTri(user.role),
          usageCount: t.usageCount,
        })),
      };
    } catch (err) {
      logger.error('[templates] loi lay danh sach:', err);
      return reply.status(500).send({ error: 'Không tải được mẫu tin nhắn' });
    }
  });

  // ── TẠO ───────────────────────────────────────────────────────────────────
  app.post('/api/v1/automation/templates', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const than = (request.body ?? {}) as ThanMau;
      const ten = (than.name ?? '').trim();
      const noiDung = layNoiDungThuan(than).trim();
      const anh = locAnhKem(than.attachments);
      if (!ten) return reply.status(400).send({ error: 'Chưa đặt tên mẫu' });
      // Mẫu CHỈ có ảnh (không chữ) là hợp lệ — sale hay gửi mỗi bảng giá.
      if (!noiDung && !anh.length) {
        return reply.status(400).send({ error: 'Mẫu phải có nội dung hoặc ít nhất 1 ảnh' });
      }

      const congKhai = than.visibility === 'public';
      const mau = await prisma.messageTemplate.create({
        data: {
          orgId: user.orgId,
          // Mẫu dùng chung KHÔNG gắn chủ (ownerUserId=null) để cả đội đều thấy;
          // vẫn ghi createdById để biết ai được sửa.
          ownerUserId: congKhai ? null : user.id,
          createdById: user.id,
          visibility: congKhai ? 'public' : 'private',
          name: ten,
          content: noiDung,
          contentRich: (than.contentRich as object) ?? undefined,
          shortcut: chuanHoaGoTat(than.shortcut),
          category: than.category?.trim() || null,
          tagIds: Array.isArray(than.tagIds) ? than.tagIds.filter((x) => typeof x === 'string') : [],
          attachments: anh.length ? anh : undefined,
        },
      });
      logger.info('[templates] tao mau "%s" (%s) boi user=%s', ten, mau.visibility, user.id);
      return { template: { ...mau, isPersonal: !congKhai, canEdit: true } };
    } catch (err) {
      logger.error('[templates] loi tao mau:', err);
      return reply.status(500).send({ error: 'Không tạo được mẫu' });
    }
  });

  /** Lấy mẫu + kiểm quyền sửa. Trả null nếu đã gửi lỗi cho client. */
  async function layMauChoSua(request: FastifyRequest, reply: FastifyReply) {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const mau = await prisma.messageTemplate.findFirst({
      where: { id, orgId: user.orgId, archivedAt: null },
    });
    if (!mau) {
      reply.status(404).send({ error: 'Không tìm thấy mẫu' });
      return null;
    }
    const duocSua =
      mau.createdById === user.id || mau.ownerUserId === user.id || laChuHoacQuanTri(user.role);
    if (!duocSua) {
      reply.status(403).send({
        error: 'Mẫu này do người khác tạo — nhờ họ hoặc quản trị sửa giúp',
        code: 'TEMPLATE_EDIT_FORBIDDEN',
      });
      return null;
    }
    return mau;
  }

  // ── SỬA ───────────────────────────────────────────────────────────────────
  app.put('/api/v1/automation/templates/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const mau = await layMauChoSua(request, reply);
      if (!mau) return;
      const than = (request.body ?? {}) as ThanMau;
      const ten = than.name !== undefined ? (than.name ?? '').trim() : mau.name;
      const noiDung = than.content !== undefined || than.contentRich !== undefined
        ? layNoiDungThuan(than).trim()
        : mau.content;
      const anhCu = (mau.attachments as AnhKem[] | null) ?? [];
      const anh = than.attachments !== undefined ? locAnhKem(than.attachments) : anhCu;
      if (!ten) return reply.status(400).send({ error: 'Chưa đặt tên mẫu' });
      if (!noiDung && !anh.length) {
        return reply.status(400).send({ error: 'Mẫu phải có nội dung hoặc ít nhất 1 ảnh' });
      }

      const congKhai = than.visibility !== undefined ? than.visibility === 'public' : mau.visibility === 'public';
      const capNhat = await prisma.messageTemplate.update({
        where: { id: mau.id },
        data: {
          name: ten,
          content: noiDung,
          ...(than.contentRich !== undefined ? { contentRich: (than.contentRich as object) ?? undefined } : {}),
          ...(than.shortcut !== undefined ? { shortcut: chuanHoaGoTat(than.shortcut) } : {}),
          ...(than.category !== undefined ? { category: than.category?.trim() || null } : {}),
          ...(Array.isArray(than.tagIds) ? { tagIds: than.tagIds.filter((x) => typeof x === 'string') } : {}),
          ...(than.attachments !== undefined ? { attachments: anh.length ? anh : undefined } : {}),
          ...(than.visibility !== undefined
            ? { visibility: congKhai ? 'public' : 'private', ownerUserId: congKhai ? null : request.user!.id }
            : {}),
        },
      });
      return { template: capNhat };
    } catch (err) {
      logger.error('[templates] loi sua mau:', err);
      return reply.status(500).send({ error: 'Không lưu được mẫu' });
    }
  });

  // ── XOÁ (mềm) ─────────────────────────────────────────────────────────────
  app.delete('/api/v1/automation/templates/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const mau = await layMauChoSua(request, reply);
      if (!mau) return;
      await prisma.messageTemplate.update({
        where: { id: mau.id },
        data: { archivedAt: new Date() },
      });
      logger.info('[templates] xoa mem mau "%s" boi user=%s', mau.name, request.user!.id);
      return { ok: true };
    } catch (err) {
      logger.error('[templates] loi xoa mau:', err);
      return reply.status(500).send({ error: 'Không xoá được mẫu' });
    }
  });

  // ── ĐẾM LƯỢT DÙNG (giao diện đã gọi sẵn từ trước) ────────────────────────
  app.post('/api/v1/automation/templates/:id/track-use', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      await prisma.messageTemplate.updateMany({
        where: { id, orgId: user.orgId },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      });
      return { ok: true };
    } catch {
      // Đếm lượt dùng hỏng KHÔNG được cản người ta gửi tin.
      return { ok: false };
    }
  });
}
