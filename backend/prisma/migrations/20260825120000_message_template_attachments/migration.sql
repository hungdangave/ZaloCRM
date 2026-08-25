-- Mẫu tin nhắn: thêm ảnh kèm (AN AN 25/08/2026)
-- Danh sách URL ảnh trong kho media, dạng [{url, name?, thumbnailUrl?}].
-- Nullable + không mặc định => an toàn với dữ liệu cũ, không khoá bảng lâu.
ALTER TABLE "message_templates" ADD COLUMN IF NOT EXISTS "attachments" JSONB;
