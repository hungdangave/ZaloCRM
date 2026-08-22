// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * danh-thiep-sdt.test.ts — khoá hành vi rút SĐT từ danh thiếp Zalo (AN AN 22/08/2026).
 *
 * Vì sao đáng test: SĐT nằm trong một chuỗi JSON LỒNG bên trong `description`, nên rất
 * dễ bị bỏ sót khi đọc lướt — chính bug này đã khiến nhân viên phải nhắn ngược cho khách
 * "phần mềm bên em không hiện số, chị gọi cho em một cuộc để em lấy số".
 */
import { describe, it, expect } from 'vitest';
import { rutSoDienThoaiTuDanhThiep } from '../src/modules/zalo/zalo-message-helpers.js';

const danhThiep = (desc: unknown) => ({ title: 'Nguyen Thi Tep', description: desc });

describe('rutSoDienThoaiTuDanhThiep', () => {
  it('lấy được SĐT trong chuỗi JSON lồng (đúng dạng Zalo gửi thật)', () => {
    const that = '{"phone":"0705594993","caption":"0705594993","qrCodeUrl":"https://qr-talk.zdn.vn/1/x.jpg"}';
    expect(rutSoDienThoaiTuDanhThiep(danhThiep(that))).toBe('0705594993');
  });

  it('có gUid xen giữa vẫn lấy đúng (ca thật 22/08)', () => {
    const that = '{"gUid":"VJ7V8JGK6I22S5JF96M4BQVAAMJ022G0","phone":"0345610265","qrCodeUrl":"https://a.jpg","caption":"0345610265"}';
    expect(rutSoDienThoaiTuDanhThiep(danhThiep(that))).toBe('0345610265');
  });

  it('thiếu "phone" thì lấy tạm "caption" nếu caption là số', () => {
    expect(rutSoDienThoaiTuDanhThiep(danhThiep('{"caption":"0912835268","qrCodeUrl":"x"}'))).toBe('0912835268');
  });

  it('caption là CHỮ (không phải số) → KHÔNG bịa ra số', () => {
    expect(rutSoDienThoaiTuDanhThiep(danhThiep('{"caption":"Kết bạn với mình nhé","qrCodeUrl":"x"}'))).toBe('');
  });

  it('chuỗi quá ngắn / quá dài → loại (tránh nhặt nhầm mã đơn, năm sinh)', () => {
    expect(rutSoDienThoaiTuDanhThiep(danhThiep('{"phone":"12345"}'))).toBe('');
    expect(rutSoDienThoaiTuDanhThiep(danhThiep('{"phone":"012345678901234"}'))).toBe('');
  });

  it('description hỏng / không phải JSON → trả rỗng, không ném lỗi', () => {
    expect(rutSoDienThoaiTuDanhThiep(danhThiep('không phải json'))).toBe('');
    expect(rutSoDienThoaiTuDanhThiep(danhThiep(undefined))).toBe('');
    expect(rutSoDienThoaiTuDanhThiep(null)).toBe('');
    expect(rutSoDienThoaiTuDanhThiep('chuỗi thường')).toBe('');
  });

  it('description đã là object (không phải chuỗi) vẫn đọc được', () => {
    expect(rutSoDienThoaiTuDanhThiep(danhThiep({ phone: '0964773482' }))).toBe('0964773482');
  });
});
