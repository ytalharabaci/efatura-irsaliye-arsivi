'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { syntheticMask, maskForLlm, findLeaks } = require('../src/ingest/anonymize');
const { extract } = require('../src/ingest/extractors/gibStandardInvoice');
const { splitIntoDocuments } = require('../src/ingest/splitDocuments');

const sample = `
                                                               E-Fatura

Ahmet Yılmaz Danışmanlık
Bağdat Cad. No:12 Kadıköy
Vergi Dairesi: Kadıköy Vergi Dairesi
TCKN: 12345678901
VKN: 9876543210
Fatura No: GIB2026000000001
ETTN: 12345678-1234-1234-1234-123456789012
E-Posta: ahmet@example.com
Tel: +90 212 555 0000
Düzenleme Tarihi: 30-06-2026

SAYIN
Örnek Teknoloji A.Ş.
Atatürk Mah. Ihlamur Sok. No:5 Kadıköy Istanbul

1                                 Siber Güvenlik Hizmeti Bedeli       1 Adet       15.000,00 TL         %20,00         3.000,00 TL             15.000,00 TL
                                                                                Hesaplanan KDV(%20)            3.000,00 TL
`;

test('syntheticMask: kişisel/ticari değerler maskelenir', () => {
  const m = syntheticMask(sample);
  for (const gizli of [
    '12345678901', '9876543210', 'GIB2026000000001', '12345678-1234-1234-1234-123456789012',
    'ahmet@example.com', '212 555 0000', '30-06-2026', '15.000,00', 'Ahmet', 'Yılmaz', 'Bağdat',
    'Kadıköy', 'Atatürk', 'Ihlamur', 'Siber', 'Güvenlik',
  ]) {
    assert.ok(!m.includes(gizli), `${gizli} maskelenmeli`);
  }
});

test('syntheticMask: etiketler, oranlar ve sütun düzeni korunur', () => {
  const m = syntheticMask(sample);
  const a = sample.split('\n');
  const b = m.split('\n');
  assert.equal(b.length, a.length);
  a.forEach((satir, i) => assert.equal(b[i].length, satir.length, `satır ${i} uzunluğu korunmalı`));
  for (const etiket of ['Fatura No:', 'ETTN:', 'VKN:', 'TCKN:', 'Vergi Dairesi:', 'SAYIN', '%20,00', 'KDV(%20)', 'Adet', 'TL']) {
    assert.ok(m.includes(etiket), `${etiket} korunmalı`);
  }
  // Biçim korunur: GİB belge no deseni, UUID, tarih, Türkçe tutar
  assert.match(m, /Fatura No: [A-Z]{3}\d{13}/);
  assert.match(m, /ETTN: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.match(m, /Düzenleme Tarihi: \d{2}-\d{2}-\d{4}/);
  assert.match(m, /\d{2}\.\d{3},\d{2} TL/);
  // Eski yer tutucular kullanılmaz
  assert.ok(!/\[[A-Z_]+\]/.test(m));
});

test('syntheticMask: maskeli metin de aynı extractor ile ayrıştırılabilir (şablon korunur)', () => {
  const t = fs.readFileSync(path.join(__dirname, 'fixtures', 'gib_iskontolu_multi_sample.txt'), 'utf8');
  for (const seg of splitIntoDocuments(t)) {
    const orijinal = extract(seg);
    const maskeli = extract(syntheticMask(seg));
    assert.ok(maskeli, 'maskeli metin tanınmalı');
    assert.equal(maskeli.items.length, orijinal.items.length, 'kalem sayısı aynı kalmalı');
    assert.notEqual(maskeli.header.belge_no, orijinal.header.belge_no);
  }
});

test('findLeaks / maskForLlm: fixture\'larda sızıntı yok', () => {
  for (const f of fs.readdirSync(path.join(__dirname, 'fixtures')).filter((x) => x.endsWith('.txt'))) {
    const t = fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
    const { masked: m } = maskForLlm(t);
    assert.deepEqual(findLeaks(t, m), [], f);
  }
  assert.deepEqual(findLeaks('Ahmet 12345678901', 'Ahmet 99999999999'), ['Ahmet']);
});

test('maskWithMap / unmaskCode: sözlük dışı etiket tutarlı takma adla gider, kodda gerçeğine döner', () => {
  const { maskWithMap, unmaskCode } = require('../src/ingest/anonymize');
  const metin = 'Kargo Takip: ABC2026000000001\nKargo Takip tekrar\nMüşteri Adı: Zeynep Kaya';
  const { masked, harita } = maskWithMap(metin);
  assert.ok(!masked.includes('Kargo') && !masked.includes('Takip'));
  const [, s1, s2] = masked.match(/^(\S+) (\S+):/);
  assert.deepEqual(masked.split('\n')[1].split(' ').slice(0, 2), [s1, s2], 'aynı kelime aynı takma adı almalı');
  const llmKodu = `const m = text.match(/${s1} ${s2}:\\s*(\\S+)/); const data = 1;`;
  const yerel = unmaskCode(llmKodu, harita);
  assert.ok(yerel.includes('/Kargo Takip:'), yerel);
  assert.ok(yerel.includes('const data = 1'), 'koddaki tanımlayıcılar bozulmamalı');
});
