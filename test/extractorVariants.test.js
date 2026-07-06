'use strict';

// GİB şablonunun entegratör varyasyonları için regresyon testleri:
// 1) e-Arşiv, iki noktasız etiketler, bitişik sayı-birim ("1,0Adet100,00TL"),
//    boşluklu tarih ("09 - 05 - 2026"), çok kalem — pazaryeri faturaları
// 2) Birimsiz kalem satırı, sütun taşmasıyla bölünen tutar, "Fatura Tarihi"
//    etiketi, kurumsal satıcı (VKN) + şahıs alıcı (TCKN) — telekom faturaları

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/ingest/extractors/gibStandardInvoice');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// --- Varyasyon 1: e-Arşiv, iki noktasız etiketler ---------------------------

const earsiv = extract(fixture('gib_earsiv_colonless_sample.txt'));

test('e-Arşiv (iki noktasız): tanınmalı', () => {
  assert.notEqual(earsiv, null);
});

test('e-Arşiv (iki noktasız): başlık alanları doğru', () => {
  assert.equal(earsiv.header.belge_no, 'EAR2026000009999');
  assert.equal(earsiv.header.senaryo, 'EARSIVFATURA');
  assert.equal(earsiv.header.fatura_tipi, 'SATIS');
  assert.equal(earsiv.header.duzenleme_tarihi, '2026-05-09'); // "09 - 05 - 2026"
  assert.equal(earsiv.header.ettn, '1e972c66-fee0-455d-a524-d857ebf8d82e');
});

test('e-Arşiv (iki noktasız): satıcı/alıcı konuma göre ayrılır (SAYIN öncesi/sonrası)', () => {
  assert.equal(earsiv.header.satici_unvan, 'ÖRNEK ELEKTRONİK MEHMET ÖRNEK');
  assert.equal(earsiv.header.satici_vkn_tckn, '98765432109');
  assert.equal(earsiv.header.satici_vergi_dairesi, 'Örnek Dairesi');
  assert.equal(earsiv.header.alici_unvan, 'Ali Veli DENEME');
  assert.equal(earsiv.header.alici_vkn_tckn, '1234567890');
  assert.equal(earsiv.header.alici_vergi_dairesi, 'ÖRNEKVERGİ');
});

test('e-Arşiv (iki noktasız): tutarlar TL bitişik yazımıyla doğru', () => {
  assert.equal(earsiv.header.mal_hizmet_toplam_tutari, 300);
  assert.equal(earsiv.header.hesaplanan_kdv_toplam, 60);
  assert.equal(earsiv.header.vergiler_dahil_toplam_tutar, 360);
  assert.equal(earsiv.header.odenecek_tutar, 360);
});

test('e-Arşiv (iki noktasız): bitişik "1,0Adet" iki kalem doğru ayrışır', () => {
  assert.equal(earsiv.items.length, 2);
  const [k1, k2] = earsiv.items;
  assert.equal(k1.sira_no, 1);
  assert.equal(k1.miktar, 1);
  assert.equal(k1.birim, 'Adet');
  assert.equal(k1.birim_fiyat, 100);
  assert.equal(k1.kdv_orani, 20);
  assert.equal(k1.kdv_tutari, 20);
  assert.equal(k1.mal_hizmet_tutari, 100);
  assert.match(k1.aciklama, /Örnek Ürün Bir Güç Çevirici/);
  assert.equal(k2.sira_no, 2);
  assert.equal(k2.birim_fiyat, 200);
  assert.equal(k2.mal_hizmet_tutari, 200);
  assert.match(k2.aciklama, /Örnek Ürün İki uzatma/);
});

// --- Varyasyon 2: birimsiz kalem, bölünen tutar sütunu ----------------------

const temel = extract(fixture('gib_temel_birimsiz_sample.txt'));

test('temel/birimsiz: tanınmalı', () => {
  assert.notEqual(temel, null);
});

test('temel/birimsiz: "Fatura Tarihi" etiketi tarih olarak okunur', () => {
  assert.equal(temel.header.belge_no, 'ADU2026000000001');
  assert.equal(temel.header.duzenleme_tarihi, '2026-03-20');
  assert.equal(temel.header.senaryo, 'TEMELFATURA');
});

test('temel/birimsiz: kurumsal satıcı VKN, şahıs alıcı TCKN karışmaz', () => {
  assert.equal(temel.header.satici_unvan, 'Örnek Telekom Hizmetleri A.Ş.');
  assert.equal(temel.header.satici_vkn_tckn, '1111111111');
  assert.equal(temel.header.satici_vergi_dairesi, 'Örnek Kurumlar');
  assert.equal(temel.header.alici_vkn_tckn, '22222222222');
  // Alıcının "Vergi Dairesi:" etiketi boş — sağ sütundaki "Senaryo:" değer sanılmamalı
  assert.equal(temel.header.alici_vergi_dairesi, null);
});

test('temel/birimsiz: alıcı adı iki kez basılsa da tek sefer alınır', () => {
  assert.equal(temel.header.alici_unvan, 'ALİ VELİ DENEME');
});

test('temel/birimsiz: birimsiz kalem, tutar miktar×fiyattan hesaplanır', () => {
  assert.equal(temel.items.length, 1);
  const k = temel.items[0];
  assert.equal(k.sira_no, 1);
  assert.equal(k.aciklama, 'Örnek Fiber Paket');
  assert.equal(k.miktar, 1);
  assert.equal(k.birim, null);
  assert.equal(k.birim_fiyat, 500);
  assert.equal(k.kdv_orani, 20);
  assert.equal(k.kdv_tutari, 100);
  assert.equal(k.mal_hizmet_tutari, 500); // sütun taşması: 1 × 500,0
});

test('temel/birimsiz: başlık toplamları doğru (OIV karışmaz)', () => {
  assert.equal(temel.header.mal_hizmet_toplam_tutari, 500);
  assert.equal(temel.header.hesaplanan_kdv_toplam, 100);
  assert.equal(temel.header.vergiler_dahil_toplam_tutar, 640);
  assert.equal(temel.header.odenecek_tutar, 640);
});
