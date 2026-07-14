'use strict';

// Kerning onarımı: -layout çıktısının kelime içine soktuğu boşluklar,
// -raw çıktısı referans alınarak birleştirilir; gerçek boşluklar korunur.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { repairSpaces, repairDocumentText } = require('../src/ingest/repairKerning');

const raw = [
  'SAYIN',
  '3 MLX1211 HORTUM EKİ LÜX 1/2 60 Adet',
  '10 MLX1304 HORTUM SİLİKONLU 5/8 100 M',
  '6 KAMABYT52 KAMA BENZİNLİ TIRPAN YAN 3 Adet',
  '5 MLX6092 SİLİKON FİX ALL HIGH TACK SEALANT SLIMFLEX',
  'KAMA AĞAÇ KESME MOTORU SETİ 46CC',
  '# Yalnız OtuzDokuzBinÜçYüzYirmiBir TL #',
].join('\n');

test('repairSpaces: bölünmüş kelime birleşir ("HO RTUM")', () => {
  assert.equal(repairSpaces('HO RTUM EKİ LÜX 1/2', raw), 'HORTUM EKİ LÜX 1/2');
});

test('repairSpaces: gerçek boşluk korunur ("EKİ LÜX" birleşmez)', () => {
  assert.equal(repairSpaces('EKİ LÜX', raw), 'EKİ LÜX');
});

test('repairSpaces: zincirleme bölünme adım adım kapanır ("MO TO RU")', () => {
  assert.equal(repairSpaces('KESME MO TO RU SETİ', raw), 'KESME MOTORU SETİ');
});

test('repairSpaces: raw\'da boşluklu hali de geçen çift birleşmez', () => {
  // "KAMA BENZİNLİ" raw'da boşluklu geçiyor; "KAMABENZİNLİ" diye bir
  // birleşim olsa bile (burada yok) boşluklu kanıt öncelikli.
  assert.equal(repairSpaces('KAMA BENZİNLİ TIRPAN', raw), 'KAMA BENZİNLİ TIRPAN');
});

test('repairSpaces: sayısal parçalar asla birleştirilmez', () => {
  // raw "5/8 100" bitişik içermiyor ama içerseydi bile sayı+sayı korunmalı
  assert.equal(repairSpaces('SİLİKO NLU 5/8 100', raw), 'SİLİKONLU 5/8 100');
});

test('repairSpaces: raw yoksa/boşsa değer aynen döner', () => {
  assert.equal(repairSpaces('HO RTUM', ''), 'HO RTUM');
  assert.equal(repairSpaces(null, raw), null);
});

test('repairDocumentText: başlık metin alanları ve kalem açıklamaları onarılır', () => {
  const result = {
    header: {
      satici_unvan: 'SİLİKO N SANAYİ', // raw'da "SİLİKON" var → birleşir
      alici_unvan: 'EKİ LÜX LTD',      // gerçek boşluk → kalır
      belge_no: 'ABC2026000000001',    // metin alanı değil → dokunulmaz
      notlar: 'Yalnız: O tuzDok uzBinÜçYüzYirm iBir TL',
    },
    items: [{ aciklama: 'HO RTUM SİLİKO NLU 5/8' }, { aciklama: null }],
  };
  repairDocumentText(result, raw);
  assert.equal(result.header.satici_unvan, 'SİLİKON SANAYİ');
  assert.equal(result.header.alici_unvan, 'EKİ LÜX LTD');
  assert.equal(result.header.belge_no, 'ABC2026000000001');
  assert.equal(result.header.notlar, 'Yalnız: OtuzDokuzBinÜçYüzYirmiBir TL');
  assert.equal(result.items[0].aciklama, 'HORTUM SİLİKONLU 5/8');
  assert.equal(result.items[1].aciklama, null);
});
