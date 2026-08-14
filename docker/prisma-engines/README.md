# Máy nhị phân Prisma tải sẵn (chỉ cần khi máy chủ mạng kém)

**Khi nào cần:** `prisma generate` trong Docker báo
`Error: request to https://binaries.prisma.sh/... failed`.
Nghĩa là Node bên trong BuildKit không ra được internet, dù chính máy chủ thì tải bình thường.

**Cách lấy** (chạy trên máy chủ, KHÔNG chạy trong Docker):

```bash
# Lấy mã commit + nền tảng từ chính dòng lỗi ở trên
H=280c870be64f457428992c43c1f6d557fab6e29e
P=linux-musl-openssl-3.0.x        # alpine dùng musl; Debian thì là debian-openssl-3.0.x
cd docker/prisma-engines
curl -fsSL "https://binaries.prisma.sh/all_commits/$H/$P/schema-engine.gz" -o schema-engine.gz
gunzip -f schema-engine.gz && chmod +x schema-engine
```

Dockerfile tự nhận file này và đặt `PRISMA_SCHEMA_ENGINE_BINARY`. **Không có file cũng build
được bình thường** (ở nơi mạng tốt) — bước đó chỉ đặt biến khi thấy file.

⚠️ Mã commit ĐỔI theo phiên bản Prisma. Nâng Prisma thì tải lại file mới, lấy mã từ dòng lỗi.

⚠️ File nhị phân ~22MB nên **không commit lên git** (xem `.gitignore` cạnh đây).
