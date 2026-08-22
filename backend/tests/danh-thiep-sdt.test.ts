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

// ── Rút SĐT khách tự gõ trong tin text (AN AN 22/08/2026) ──────────────────
// Mọi ca dưới đây lấy từ tin nhắn THẬT trong CSDL. Nhóm "phải LOẠI" quan trọng hơn
// nhóm "phải NHẬN": ghi nhầm số vào hồ sơ khách = gọi nhầm người, giao nhầm hàng.
import { rutSoDienThoaiTuTinNhan } from '../src/modules/zalo/zalo-message-helpers.js';

const cuaKhach = { cuaKhach: true };

describe('rutSoDienThoaiTuTinNhan — phải NHẬN', () => {
  it('khách cho địa chỉ giao hàng kèm SĐT', () => {
    expect(rutSoDienThoaiTuTinNhan('Đc: 763 Bùi Văn Hoà- Long Bình -Đồng Nai\nSđt: 0988738897', cuaKhach)).toBe('0988738897');
  });
  it('tin chỉ có mỗi con số', () => {
    expect(rutSoDienThoaiTuTinNhan('0778736368.', cuaKhach)).toBe('0778736368');
    expect(rutSoDienThoaiTuTinNhan('0836226279 ạ', cuaKhach)).toBe('0836226279');
  });
  it('số viết có dấu cách', () => {
    expect(rutSoDienThoaiTuTinNhan('086 2526888', cuaKhach)).toBe('0862526888');
  });
  it('dạng 84… và +84… đều đưa về 0…', () => {
    expect(rutSoDienThoaiTuTinNhan('sđt 84962536224', cuaKhach)).toBe('0962536224');
    expect(rutSoDienThoaiTuTinNhan('liên hệ +84 962 536 224', cuaKhach)).toBe('0962536224');
  });
});

describe('rutSoDienThoaiTuTinNhan — phải LOẠI (quan trọng hơn)', () => {
  it('MÃ SỐ THUẾ trông y hệt SĐT', () => {
    expect(rutSoDienThoaiTuTinNhan('THÔNG TIN XUẤT HÓA ĐƠN\nCÔNG TY TNHH PHÚC ĐIỀN\nMST: 0317182253', cuaKhach)).toBe('');
  });
  it('hotline tự động của DOANH NGHIỆP KHÁC', () => {
    expect(rutSoDienThoaiTuTinNhan('TravelJet xin chào anh/chị ✈️ Cảm ơn anh/chị đã liên hệ – Hotline: 0989583474', cuaKhach)).toBe('');
    expect(rutSoDienThoaiTuTinNhan('Em Thu Hiền Vinfast xin chào ❤️ A/c cần tư vấn gọi 0901513993', cuaKhach)).toBe('');
  });
  it('tin rao vặt / quảng cáo gửi vào', () => {
    expect(rutSoDienThoaiTuTinNhan('🔔BÁN CĂN HỘ Usilk : 88 m² – HÀ ĐÔNG. LH 0963525985', cuaKhach)).toBe('');
    expect(rutSoDienThoaiTuTinNhan('🌏 TRIỂN LÃM VIỆT NAM – CAMPUCHIA 2026, đăng ký 0878296268', cuaKhach)).toBe('');
  });
  it('tin do NHÂN VIÊN gửi → không lấy (số trong đó là của shop)', () => {
    expect(rutSoDienThoaiTuTinNhan('Chị liên hệ 0912345678 giúp em', { cuaKhach: false })).toBe('');
  });
  it('số của chính mình (hotline / nick) → loại', () => {
    expect(rutSoDienThoaiTuTinNhan('gọi 0363336333 nhé', { cuaKhach: true, soCuaMinh: new Set(['0363336333']) })).toBe('');
  });
  it('đầu số không hợp lệ / không đủ 10 số → loại', () => {
    expect(rutSoDienThoaiTuTinNhan('mã đơn 0123456789 nhé', cuaKhach)).toBe('');
    expect(rutSoDienThoaiTuTinNhan('sđt 09123456', cuaKhach)).toBe('');
  });
  it('văn bản dài không có dấu hiệu khách đưa số → loại (tránh nhặt số vu vơ)', () => {
    const dai = 'Hôm qua mình thấy ai đó đăng lên nhóm con số 0912345678 mà chẳng hiểu để làm gì cả nhỉ bạn';
    expect(rutSoDienThoaiTuTinNhan(dai, cuaKhach)).toBe('');
  });
  it('rỗng / không phải chuỗi → trả rỗng, không ném lỗi', () => {
    expect(rutSoDienThoaiTuTinNhan('', cuaKhach)).toBe('');
    expect(rutSoDienThoaiTuTinNhan(null, cuaKhach)).toBe('');
  });
});
