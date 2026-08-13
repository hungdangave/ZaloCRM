# Lớp chống khoá 30 số — AN AN (2026-08-13)

> Bổ sung trên nền ZaloCRM v3.4, branch `anan/anti-lock-layer`.
> Nguyên tắc: **proxy + rate limit phải sống TRƯỚC khi đăng nhập nhiều số.**

## Đã có gì / sửa gì

| Lớp (mục 6 brief) | Trạng thái | Ghi chú |
|---|---|---|
| 6.1 Proxy VN riêng per-account | **SỬA GỐC** | Bản cũ set env `HTTP_PROXY` quanh login = **no-op** (zca-js dùng undici fetch + ws, không đọc env). Bản mới truyền `agent` + `polyfill: node-fetch` vào `new Zalo({...})` → **mọi** traffic (login, gửi tin, WS keep-alive) đi qua proxy riêng của từng số. Kèm fix: 4/6 đường reconnect quên truyền proxyUrl → giờ reconnect/loginQR tự đọc từ DB. Proxy hỏng → **fail-fast không login** (thà đứng còn hơn lộ IP thật). |
| 6.2 Rate limit + delay giống người | CÓ SẴN + **BỔ SUNG** | Trần daily/burst per-nick per-category đã có (SdkLimit, cấu hình trên UI). Bổ sung `send-pacing.ts` **2 tầng**: (a) per-account — 2 tin cùng số cách ≥1,5s + jitter 0–2,5s, kết bạn 20–45s; (b) **per-NHÓM IP** (13/08, khi CEO chốt gộp 4 số/proxy) — các số cùng `proxyUrl` xếp chung hàng đợi, giữ TỔNG tải mỗi IP ~24–40 tin/phút thay vì 4×40=160. Số không proxy chung nhóm `direct`. Tra proxy lỗi → số đó đứng nhóm riêng (không nới cho ai). Env: `ZALO_PACE_*`, `ZALO_PACE_GROUP_MIN/JITTER`; tắt bằng `ZALO_PACE_DISABLED=1` (khi đó PHẢI hạ xuống 2 số/proxy). |
| 6.3 Session persistence + cảnh báo | CÓ SẴN + **BỔ SUNG** | Cookie + auto re-login + circuit breaker (5 rớt/5phút → dừng) đã có. Bổ sung: số chuyển `qr_pending/auth_failed/expired` → **bắn Telegram** (Integration type `telegram`, dedup 30 phút). |
| 6.4 Warm-up số mới | **MỚI** | Trần hiệu lực × hệ số tuổi nick: ngày 0-2 ×0.2, 3-6 ×0.5, 7-13 ×0.8, ≥14 full. Tắt: `ZALO_WARMUP_DISABLED=1` (chỉ khi migrate số cũ đã chạy lâu bên Salework). |
| 6.5 Giám sát sức khoẻ phiên | CÓ SẴN | Status log + uptime + dashboard "Vận hành Nick Zalo" + báo cáo. |

## Checklist vận hành (LÀM THEO THỨ TỰ)

1. Mua proxy **residential VN, sticky** (IP không xoay). **4 nick dùng chung 1 proxy** (CEO chốt
   13/08) → 30 nick chỉ cần **8 proxy**. 4 là trần an toàn, đừng nâng tiếp.
2. Điền proxy cho **từng** nick trong UI Quản lý tài khoản Zalo (dạng `http://user:pass@ip:port` hoặc
   `socks5://...`) — **trước khi quét QR**. 4 nick chung 1 proxy thì điền y hệt chuỗi đó cho cả 4.
3. Cấu hình Integration Telegram (botToken + chatId) để nhận alert rớt phiên.
4. Đăng nhập QR **rải** — mỗi ngày 3-5 số, không dồn 30 số một buổi.
5. Số mới để warm-up tự chạy (đừng tắt trừ khi số đã "già" bên Salework).
6. Theo dõi báo cáo "Vận hành Nick Zalo"; số nào rớt lặp → tách proxy/nghỉ vài ngày.

## File thay đổi

- `backend/src/modules/zalo/proxy-util.ts` — viết lại (agent per-account thật).
- `backend/src/modules/zalo/zalo-pool.ts` — dùng agent/polyfill; reconnect/loginQR tự đọc proxyUrl DB; Telegram alert khi cần quét lại QR.
- `backend/src/modules/zalo/send-pacing.ts` — MỚI: giãn nhịp giống người.
- `backend/src/shared/zalo-operations.ts` — gọi pacing trong `exec()`.
- `backend/src/modules/zalo/sdk-limit-service.ts` — warm-up factor.
- `backend/src/modules/integrations/providers/telegram-bot.ts` — `sendTelegramOpsAlert()`.
- `backend/tests/anti-lock-layer.test.ts` — 14 test khoá hành vi.
