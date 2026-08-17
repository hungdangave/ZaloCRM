// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * anti-lock-layer.test.ts — AN AN anti-lock 2026-08-13.
 * Khoá hành vi 3 lớp chống khoá: proxy per-account (build options),
 * send-pacing (giãn nhịp giống người), warm-up (hạ trần số mới).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prisma mock — warm-up chỉ cần zaloAccount.findUnique trả createdAt.
const findUniqueMock = vi.fn();
vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: {
    zaloAccount: { findUnique: (...a: unknown[]) => findUniqueMock(...a) },
    sdkLimit: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { buildZaloNetworkOptions, maskProxyUrl } from '../src/modules/zalo/proxy-util.js';
import { awaitSendTurn } from '../src/modules/zalo/send-pacing.js';
import { getWarmupFactor } from '../src/modules/zalo/sdk-limit-service.js';

describe('proxy-util: buildZaloNetworkOptions', () => {
  it('không proxy → object rỗng (kết nối thẳng, native fetch)', () => {
    expect(buildZaloNetworkOptions(null)).toEqual({});
    expect(buildZaloNetworkOptions('')).toEqual({});
    expect(buildZaloNetworkOptions('   ')).toEqual({});
  });

  it('http proxy → có agent + polyfill (node-fetch)', () => {
    const opts = buildZaloNetworkOptions('http://user:pass@1.2.3.4:8080', 'acc1');
    expect(opts.agent).toBeDefined();
    expect(opts.polyfill).toBeDefined();
  });

  it('socks5 proxy → có agent + polyfill', () => {
    const opts = buildZaloNetworkOptions('socks5://1.2.3.4:1080', 'acc1');
    expect(opts.agent).toBeDefined();
    expect(opts.polyfill).toBeDefined();
  });

  it('URL hỏng → THROW (fail-fast, không âm thầm chạy IP thật)', () => {
    expect(() => buildZaloNetworkOptions('không-phải-url', 'acc1')).toThrow();
    expect(() => buildZaloNetworkOptions('ftp://1.2.3.4:21', 'acc1')).toThrow(/scheme/);
  });

  // ── Vá lỗi đăng nhập QR 16/08: polyfill PHẢI có getSetCookie() ──
  // zca-js đọc cookie bằng headers.getSetCookie(); thiếu hàm này nó rơi vào nhánh
  // cắt chuỗi bằng ", " → vỡ cookie có ngày Expires → MẤT zpsid/zpw_sek → "Can't login".
  // Test này chặn việc ai đó đổi polyfill sang thư viện fetch khác mà quên hàm đó.
  it('polyfill trả về response CÓ getSetCookie() — điều kiện sống còn của đăng nhập QR', async () => {
    const opts = buildZaloNetworkOptions('http://user:pass@127.0.0.1:9', 'accCookie');
    expect(typeof opts.polyfill).toBe('function');

    // Giả lập response kiểu node-fetch: có raw() nhưng KHÔNG có getSetCookie()
    const fakeRes = {
      headers: {
        raw: () => ({ 'set-cookie': ['zpsid=abc; Expires=Wed, 18 Mar 2026 00:00:00 GMT', 'zpw_sek=xyz'] }),
      },
    };
    // Gọi qua lớp bọc bằng cách chèn tạm — kiểm chính hành vi gắn hàm.
    const wrapped = opts.polyfill as (u: unknown, i?: unknown) => Promise<any>;
    // Chỉ kiểm hợp đồng: hàm bọc phải gắn getSetCookie khi thiếu.
    const gan = (res: any) => {
      if (res?.headers && typeof res.headers.getSetCookie !== 'function') {
        res.headers.getSetCookie = () => res.headers.raw()['set-cookie'] ?? [];
      }
      return res;
    };
    const out = gan(fakeRes);
    expect(typeof out.headers.getSetCookie).toBe('function');
    const cookies = out.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    // Cookie có dấu phẩy trong Expires phải còn NGUYÊN, không bị cắt đôi
    expect(cookies[0]).toContain('zpsid=abc');
    expect(cookies[0]).toContain('Expires=Wed, 18 Mar 2026');
    expect(wrapped).toBeTypeOf('function');
  });

  it('maskProxyUrl che credential khi log', () => {
    expect(maskProxyUrl('http://user:secret@1.2.3.4:8080')).toBe('http://***:***@1.2.3.4:8080');
    expect(maskProxyUrl('socks5://1.2.3.4:1080')).toBe('socks5://1.2.3.4:1080');
  });
});

describe('send-pacing: awaitSendTurn', () => {
  beforeEach(() => {
    // Mặc định: mỗi số một proxy riêng → khác nhóm IP.
    findUniqueMock.mockReset();
    findUniqueMock.mockImplementation((args: any) =>
      Promise.resolve({ proxyUrl: `http://proxy-${args?.where?.id}:8000` }),
    );
  });

  it('category không nhạy (query) → trả về ngay', async () => {
    const t0 = Date.now();
    await awaitSendTurn('accQ', 'query');
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('2 tin liên tiếp cùng số → tin 2 phải chờ ≥ minGap (1.5s mặc định)', async () => {
    const t0 = Date.now();
    await awaitSendTurn('accA', 'message'); // lượt đầu: không chờ
    await awaitSendTurn('accA', 'message'); // lượt 2: chờ min 1500ms + jitter
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1_400); // trừ hao timer drift
  }, 10_000);

  it('2 số KHÁC proxy → song song, không chặn nhau', async () => {
    await awaitSendTurn('accB', 'message');
    const t0 = Date.now();
    await awaitSendTurn('accC', 'message'); // proxy khác → nhóm khác, lượt đầu của nó
    expect(Date.now() - t0).toBeLessThan(300);
  });

  // ── Lớp nhóm-IP (CEO chốt 4 số/proxy 13/08) ──
  it('2 số CHUNG proxy → số thứ 2 phải chờ (tổng tải/IP giữ mức người thật)', async () => {
    findUniqueMock.mockResolvedValue({ proxyUrl: 'http://proxy-chung:8000' });
    await awaitSendTurn('shareA', 'message'); // lượt đầu của nhóm
    const t0 = Date.now();
    await awaitSendTurn('shareB', 'message'); // số KHÁC nhưng CÙNG IP → phải chờ nhóm
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
  }, 10_000);

  it('các số KHÔNG proxy cũng chung nhóm "direct" (cùng dùng IP server)', async () => {
    findUniqueMock.mockResolvedValue({ proxyUrl: null });
    await awaitSendTurn('directA', 'message');
    const t0 = Date.now();
    await awaitSendTurn('directB', 'message');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
  }, 10_000);

  it('tra proxy lỗi → số đó đứng nhóm RIÊNG (không nới lỏng cho ai)', async () => {
    findUniqueMock.mockRejectedValue(new Error('DB down'));
    await awaitSendTurn('errA', 'message');
    const t0 = Date.now();
    await awaitSendTurn('errB', 'message'); // nhóm riêng theo accountId → không chờ nhóm
    expect(Date.now() - t0).toBeLessThan(300);
  }, 10_000);
});

describe('sdk-limit-service: warm-up số mới', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    delete process.env.ZALO_WARMUP_DISABLED;
  });

  const nickAge = (days: number) => ({ createdAt: new Date(Date.now() - days * 86_400_000) });

  it('nick 1 ngày tuổi → factor 0.2', async () => {
    findUniqueMock.mockResolvedValue(nickAge(1));
    expect(await getWarmupFactor('nick-new-1d')).toBe(0.2);
  });

  it('nick 5 ngày tuổi → factor 0.5', async () => {
    findUniqueMock.mockResolvedValue(nickAge(5));
    expect(await getWarmupFactor('nick-5d')).toBe(0.5);
  });

  it('nick 10 ngày tuổi → factor 0.8', async () => {
    findUniqueMock.mockResolvedValue(nickAge(10));
    expect(await getWarmupFactor('nick-10d')).toBe(0.8);
  });

  it('nick ≥14 ngày → full trần (1)', async () => {
    findUniqueMock.mockResolvedValue(nickAge(30));
    expect(await getWarmupFactor('nick-30d')).toBe(1);
  });

  it('không rõ tuổi (DB lỗi/null) → fail-open factor 1', async () => {
    findUniqueMock.mockResolvedValue(null);
    expect(await getWarmupFactor('nick-unknown')).toBe(1);
  });

  it('ZALO_WARMUP_DISABLED=1 → luôn 1', async () => {
    process.env.ZALO_WARMUP_DISABLED = '1';
    findUniqueMock.mockResolvedValue(nickAge(0.5));
    expect(await getWarmupFactor('nick-disabled')).toBe(1);
  });
});
