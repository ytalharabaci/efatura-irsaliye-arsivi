'use strict';

// Tek PDF'te art arda birden fazla e-Fatura (iskonto sütunlu ticari fatura
// şablonu) için testler:
// - splitIntoDocuments: form feed'lere göre sayfaları belgelere gruplar;
//   kimliksiz taşma sayfası (IBAN dipnotu) önceki belgeye eklenir
// - gibStandardInvoice: "SA YIN" harf aralığı, ':' ayraçlı toplamlar, birden
//   çok "Hesaplanan KDV" satırı, satırlara bölünmüş KDV/tutar hücreleri,
//   belge geneli iskonto ile doğrulama

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitIntoDocuments } = require('../src/ingest/splitDocuments');
const { extract } = require('../src/ingest/extractors/gibStandardInvoice');
const { validateDocument } = require('../src/ingest/validate');

const raw = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'gib_iskontolu_multi_sample.txt'),
  'utf8'
);

const segments = splitIntoDocuments(raw);
const results = segments.map((s) => extract(s));

test('split: 6 sayfadan 5 belge çıkar (taşma sayfası öncekine eklenir)', () => {
  assert.equal(segments.length, 5);
});

test('split: belge sırası ve fatura no eşleşmesi', () => {
  const nolar = results.map((r) => r && r.header.belge_no);
  assert.deepEqual(nolar, [
    'ORN2026000000016',
    'ORN2026000000067',
    'ORN2026000000078',
    'ORN2026000000188',
    'ORN2026000000201',
  ]);
});

test('split: kimliksiz IBAN taşma sayfası 3. belgede kalır', () => {
  // 3. faturanın dipnotu (banka/IBAN) ayrı bir sayfaya taşmıştı
  assert.match(segments[2], /IBAN: TR 0000 0000 0000 0000 0000 0001/);
  // sonraki belge kendi sayfasıyla başlar, taşma sayfasını içermez
  assert.equal(results[3].header.belge_no, 'ORN2026000000188');
});

test('split: her belgenin ETTN\'i kendine ait', () => {
  const ettnler = results.map((r) => r.header.ettn.toLowerCase());
  assert.deepEqual(ettnler, [1, 2, 3, 4, 5].map(
    (n) => `00000000-0000-4000-8000-00000000000${n}`
  ));
});

// --- 1. belge: başlık alanları ---------------------------------------------

const b1 = results[0];

test('belge 1: başlık alanları ("SA YIN", ":" ayraçlı etiketler)', () => {
  assert.equal(b1.header.senaryo, 'TICARIFATURA');
  assert.equal(b1.header.fatura_tipi, 'SATIS');
  assert.equal(b1.header.duzenleme_tarihi, '2026-01-09'); // "09- 01- 2026"
  assert.equal(b1.header.duzenleme_zamani, '10:07:32');
  assert.equal(b1.header.satici_unvan, 'ÖRNEKÇOĞLU HIR.NAL. MOB. AKS.İNŞ.SAN.VE TİC.LTD.ŞTİ.');
  assert.equal(b1.header.satici_vkn_tckn, '1111111111');
  assert.equal(b1.header.satici_vergi_dairesi, 'ÖRNEK BAŞKENT VERGİ DAİRESİ');
  assert.equal(b1.header.satici_eposta, 'ornek_tic55@example.com');
  assert.equal(b1.header.alici_unvan, 'AL-SAT GIDA TARIM ÜRÜNLERİ VE TAŞ. TİC. LTDİ ŞTİ.');
  assert.equal(b1.header.alici_vkn_tckn, '2222222220');
  assert.equal(b1.header.alici_vergi_dairesi, 'ÇANKAYA');
});

test('belge 1: toplamlar ":" ayraçlı biçimde, iskonto dahil', () => {
  assert.equal(b1.header.mal_hizmet_toplam_tutari, 38550);
  assert.equal(b1.header.toplam_iskonto, 5782.5);
  assert.equal(b1.header.hesaplanan_kdv_toplam, 6553.5);
  assert.equal(b1.header.vergiler_dahil_toplam_tutar, 39321);
  assert.equal(b1.header.odenecek_tutar, 39321);
});

test('belge 1: 7 kalem; bölünmüş KDV hücreleri tamamlanır', () => {
  assert.equal(b1.items.length, 7);
  const k1 = b1.items[0];
  assert.equal(k1.sira_no, 1);
  assert.equal(k1.miktar, 12);
  assert.equal(k1.birim, 'Adet');
  assert.equal(k1.birim_fiyat, 85);
  assert.equal(k1.kdv_orani, 20);
  assert.equal(k1.kdv_tutari, 173.4);   // satırda TL'siz duran hücre
  assert.equal(k1.mal_hizmet_tutari, 867);
  assert.match(k1.aciklama, /BAĞ TESTERESİ/);
  // KDV hücresi komşu satıra kaymış kalem: tutar × oran ile tamamlanır
  const k3 = b1.items[2];
  assert.equal(k3.mal_hizmet_tutari, 3442.5);
  assert.equal(k3.kdv_tutari, 688.5);
});

test('belge 1: kalem tutarları iskontolu, doğrulama yine BASARILI', () => {
  const v = validateDocument(b1.header, b1.items);
  assert.equal(v.durum, 'BASARILI', v.notlar.join('; '));
});

// --- Diğer belgeler: kalem sayıları ve uçtan uca tutarlılık -----------------

test('belge 2: 6 kalem, çok oranlı KDV toplamı (10% + 20%) toplanır', () => {
  const b2 = results[1];
  assert.equal(b2.items.length, 6);
  assert.equal(b2.header.hesaplanan_kdv_toplam, 14206.56); // 795,60 + 13.410,96
  assert.equal(b2.items[5].kdv_orani, 10);
  assert.equal(validateDocument(b2.header, b2.items).durum, 'BASARILI');
});

test('belge 3: 19 kalem, tümü tutarlı', () => {
  const b3 = results[2];
  assert.equal(b3.items.length, 19);
  assert.equal(validateDocument(b3.header, b3.items).durum, 'BASARILI');
});

test('belge 4: 17 kalem; tutarı alt satıra taşan kalem tamamlanır', () => {
  const b4 = results[3];
  assert.equal(b4.items.length, 17);
  // "50 Adet 37,5000 TL %20,00 318,75" + alt satırda "TL 1.593,75 TL"
  const k13 = b4.items.find((k) => k.sira_no === 13);
  assert.equal(k13.kdv_tutari, 318.75);
  assert.equal(k13.mal_hizmet_tutari, 1593.75);
  assert.equal(validateDocument(b4.header, b4.items).durum, 'BASARILI');
});

test('belge 5: 11 kalem; birimi alt satıra taşan "80.000 Adet" kalemi', () => {
  const b5 = results[4];
  assert.equal(b5.items.length, 11);
  const k11 = b5.items.find((k) => k.sira_no === 11);
  assert.equal(k11.miktar, 80000);
  assert.equal(k11.birim_fiyat, 0.21);
  assert.equal(k11.kdv_tutari, 2856);
  assert.equal(k11.mal_hizmet_tutari, 14280);
  // "40 Takım" birimi tanınır
  const b4items = results[3].items;
  assert.equal(b4items.find((k) => k.sira_no === 8).birim, 'Takım');
  assert.equal(validateDocument(b5.header, b5.items).durum, 'BASARILI');
});

// --- Tek belgeli/kimliksiz metinler bölünmez --------------------------------

test('split: form feed içermeyen metin tek segment döner', () => {
  const tek = 'e-Fatura\nFatura No: ABC2026000000001\nETTN: 00000000-0000-4000-8000-0000000000ff';
  assert.deepEqual(splitIntoDocuments(tek), [tek]);
});

test('split: aynı faturanın çok sayfası tek belgede kalır', () => {
  const s1 = 'e-Fatura\nFatura No : XYZ2026000000001\nsayfa 1';
  const s2 = 'e-Fatura\nFatura No : XYZ2026000000001\nsayfa 2 devam';
  const out = splitIntoDocuments(`${s1}\f${s2}`);
  assert.equal(out.length, 1);
  assert.match(out[0], /sayfa 1/);
  assert.match(out[0], /sayfa 2 devam/);
});
