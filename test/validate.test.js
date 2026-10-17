'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDocument } = require('../src/ingest/validate');

const items = [
  { mal_hizmet_tutari: 15000, kdv_tutari: 3000 },
];

test('validate: tutarlar eşleşiyor → BASARILI', () => {
  const header = { mal_hizmet_toplam_tutari: 15000, hesaplanan_kdv_toplam: 3000 };
  const result = validateDocument(header, items);
  assert.equal(result.durum, 'BASARILI');
  assert.equal(result.notlar.length, 0);
});

test('validate: küçük yuvarlama farkı → BASARILI', () => {
  const header = { mal_hizmet_toplam_tutari: 15000.03, hesaplanan_kdv_toplam: 3000 };
  const result = validateDocument(header, items);
  assert.equal(result.durum, 'BASARILI');
});

test('validate: büyük fark → SUPHELI', () => {
  const header = { mal_hizmet_toplam_tutari: 16000, hesaplanan_kdv_toplam: 3000 };
  const result = validateDocument(header, items);
  assert.equal(result.durum, 'SUPHELI');
  assert.equal(result.notlar.length, 1);
});

test('validate: KDV farkı → SUPHELI', () => {
  const header = { mal_hizmet_toplam_tutari: 15000, hesaplanan_kdv_toplam: 2500 };
  const result = validateDocument(header, items);
  assert.equal(result.durum, 'SUPHELI');
});

test('validate: yer tutucu / yanlış tipte değer → HATALI, skor 0', () => {
  const header = { mal_hizmet_toplam_tutari: '[MONEY_VAL]', belge_no: '[BELGE_NO]' };
  const result = validateDocument(header, items);
  assert.equal(result.durum, 'HATALI');
  assert.equal(result.skor, 0);
  assert.ok(result.notlar.some((n) => n.includes('yer tutucu')));
});

test('validate: kalem içi aritmetik tutarsızlığı uyarı olarak raporlanır', () => {
  const header = { mal_hizmet_toplam_tutari: 15000, hesaplanan_kdv_toplam: 3000 };
  const result = validateDocument(header, [
    { miktar: 2, birim_fiyat: 100, mal_hizmet_tutari: 15000, kdv_orani: 20, kdv_tutari: 3000 },
  ]);
  assert.equal(result.durum, 'BASARILI');
  assert.ok(result.uyarilar.some((u) => u.includes('miktar × birim fiyat')));
});

test('validate: belge geneli iskontolu kalem tutarı tutarlı sayılır', () => {
  const header = { mal_hizmet_toplam_tutari: 1020, toplam_iskonto: 153, hesaplanan_kdv_toplam: 173.4 };
  const result = validateDocument(header, [
    { miktar: 12, birim_fiyat: 85, mal_hizmet_tutari: 867, kdv_orani: 20, kdv_tutari: 173.4 },
  ]);
  assert.equal(result.durum, 'BASARILI');
  assert.deepEqual(result.uyarilar.filter((u) => u.startsWith('Kalem')), []);
});

test('validate: eksik alanlar ve tutarsızlık skoru düşürür', () => {
  const tam = validateDocument({
    belge_no: 'ABC2026000000001', ettn: 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6', duzenleme_tarihi: '2026-01-01',
    satici_unvan: 'X', satici_vkn_tckn: '1234567890', alici_unvan: 'Y', alici_vkn_tckn: '10000000146',
    mal_hizmet_toplam_tutari: 15000, hesaplanan_kdv_toplam: 3000, vergiler_dahil_toplam_tutar: 18000, odenecek_tutar: 18000,
  }, [{ miktar: 1, birim_fiyat: 15000, mal_hizmet_tutari: 15000, kdv_orani: 20, kdv_tutari: 3000 }]);
  assert.equal(tam.skor, 100);
  const eksik = validateDocument({ mal_hizmet_toplam_tutari: 16000 }, items);
  assert.ok(eksik.skor < 30);
});
