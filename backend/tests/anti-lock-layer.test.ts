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

  it('maskProxyUrl che credential khi log', () => {
    expect(maskProxyUrl('http://user:secret@1.2.3.4:8080')).toBe('http://***:***@1.2.3.4:8080');
    expect(maskProxyUrl('socks5://1.2.3.4:1080')).toBe('socks5://1.2.3.4:1080');
  });
});

describe('send-pacing: awaitSendTurn', () => {
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

  it('2 số KHÁC nhau → song song, không chặn nhau', async () => {
    await awaitSendTurn('accB', 'message');
    const t0 = Date.now();
    await awaitSendTurn('accC', 'message'); // số khác — lượt đầu của nó
    expect(Date.now() - t0).toBeLessThan(100);
  });
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
