'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Testler kurulumun gerçek data/extractors dizinine dokunmasın.
process.env.EXTRACTORS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'efatura-extractors-'));

const {
  registerDynamicExtractor,
  unregisterDynamicExtractor,
  loadDynamicExtractors,
  listExtractors,
  dispatch,
  dispatchAll,
  compileSandboxed,
  templateFingerprint,
} = require('../src/ingest/extractors/index');

const mockExtractorCode = `
'use strict';

function extract(text) {
  if (!text || !text.includes('OZEL_TEST_FATURASI')) return null;
  return {
    header: {
      belge_tipi: 'FATURA',
      belge_no: 'TEST202600000001',
      satici_unvan: 'Dinamik Test Satıcı',
      mal_hizmet_toplam_tutari: normalize.parseTrNumber('100,00'),
    },
    items: [
      { sira_no: 1, aciklama: 'Dinamik Test Kalem', miktar: 1, birim_fiyat: 100, mal_hizmet_tutari: '100,00' }
    ],
    confidence: 1.0,
  };
}

module.exports = { extract };
`;

test('Dinamik Extractor Kaydetme, Listeleme ve Ayrıştırma', () => {
  const testName = `test_variant_${Date.now()}`;
  const savedPath = registerDynamicExtractor(testName, mockExtractorCode, { fingerprint: 'abc' });

  assert.ok(fs.existsSync(savedPath), 'Dosya diske yazılmış olmalı');
  assert.ok(savedPath.startsWith(process.env.EXTRACTORS_DIR), 'EXTRACTORS_DIR altına yazılmalı');

  const found = listExtractors().find((e) => e.name === testName);
  assert.ok(found, 'Yeni extractor listelerde bulunmalı');
  assert.equal(found.type, 'dynamic');
  assert.equal(found.meta.fingerprint, 'abc');

  const result = dispatch('Bu bir OZEL_TEST_FATURASI metnidir.');
  assert.ok(result !== null, 'Dispatch null dönmemeli');
  assert.equal(result.name, testName);
  assert.equal(result.result.header.belge_no, 'TEST202600000001');
  assert.equal(result.result.header.mal_hizmet_toplam_tutari, 100, 'sandbox içindeki normalize kullanılabilmeli');
  assert.equal(result.result.items[0].mal_hizmet_tutari, 100, 'dinamik sonuç tipe zorlanmalı');

  // Silme: hem diskten hem bellekten kalkmalı
  assert.equal(unregisterDynamicExtractor(testName), true);
  assert.ok(!fs.existsSync(savedPath));
  assert.equal(dispatch('Bu bir OZEL_TEST_FATURASI metnidir.'), null, 'silinen extractor dispatch\'te görünmemeli');
  assert.ok(!listExtractors().some((e) => e.name === testName));
});

test('loadDynamicExtractors: diskten silinen dosya listeden de çıkar', () => {
  const testName = `test_reload_${Date.now()}`;
  const savedPath = registerDynamicExtractor(testName, mockExtractorCode);
  fs.unlinkSync(savedPath);
  loadDynamicExtractors();
  assert.ok(!listExtractors().some((e) => e.name === testName));
});

test('sandbox: require, process ve host nesnelerine erişim yok', () => {
  assert.throws(
    () => compileSandboxed("const fs = require('fs'); module.exports = { extract() { return null; } };", 'x.js'),
    /require\(\) kullanılamaz/
  );
  const kacis = compileSandboxed(`
    module.exports = { extract() {
      let p = null;
      try { p = typeof process; } catch (e) { p = 'hata'; }
      let f = null;
      try { f = this.constructor.constructor('return typeof process')(); } catch (e) { f = 'engellendi'; }
      return { header: { notlar: p + '|' + f }, items: [] };
    } };`, 'kacis.js');
  const r = kacis.extract('x');
  assert.match(r.header.notlar, /^undefined\|/);
  assert.ok(!r.header.notlar.endsWith('|object'), 'host process nesnesine ulaşılamamalı');
});

test('sandbox: sonsuz döngü zaman aşımına uğrar', () => {
  const sonsuz = compileSandboxed('module.exports = { extract() { while (true) {} } };', 'sonsuz.js');
  assert.throws(() => sonsuz.extract('x'), /timed out/i);
});

test('registerDynamicExtractor: extract ihraç etmeyen kod diske yazılmaz', () => {
  const testName = `test_invalid_${Date.now()}`;
  assert.throws(() => registerDynamicExtractor(testName, 'module.exports = {};'));
  assert.ok(!fs.existsSync(path.join(process.env.EXTRACTORS_DIR, `${testName}.js`)));
});

test('dispatchAll: yer tutucu döndüren dinamik parser statik parser\'ı geçemez', () => {
  const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'gib_standard_invoice_sample.txt'), 'utf8');
  const testName = `test_placeholder_${Date.now()}`;
  registerDynamicExtractor(testName, `
    module.exports = { extract(text) {
      if (!/e-fatura/i.test(text)) return null;
      return { header: { belge_no: '[BELGE_NO]', mal_hizmet_toplam_tutari: '[MONEY_VAL]' }, items: [] };
    } };`);
  try {
    const adaylar = dispatchAll(sample);
    assert.equal(adaylar[0].name, 'gibStandardInvoice');
    const dinamik = adaylar.find((a) => a.name === testName);
    assert.equal(dinamik.validation.durum, 'HATALI');
  } finally {
    unregisterDynamicExtractor(testName);
  }
});

test('templateFingerprint: aynı şablon aynı, farklı şablon farklı iz üretir', () => {
  const a = 'SAYIN\nFatura No: ABC2026000000001\nETTN: x\nMal Hizmet Toplam Tutarı 10,00 TL';
  const b = 'SAYIN\nFatura No: XYZ2026000000999\nETTN: y\nMal Hizmet Toplam Tutarı 99,00 TL';
  const c = 'SAYIN\nFatura No  ABC2026000000001\nETTN: x\nMal Hizmet Toplam Tutarı 10,00 TL';
  assert.equal(templateFingerprint(a), templateFingerprint(b));
  assert.notEqual(templateFingerprint(a), templateFingerprint(c));
});

test('cleanGeneratedCode: DeepSeek R1/V4 ve GLM düşünme bloklarını (<think>...</think>) temizlemeli', () => {
  const { cleanGeneratedCode, resolveLlmConfig } = require('../src/ingest/llmParserGenerator');

  const rawWithThink = `
<think>
Fatura metnini analiz ediyorum...
Sütun yapıları tespit edildi.
JS kütüphanesi oluşturuluyor.
</think>

\`\`\`javascript
'use strict';
function extract(text) { return null; }
module.exports = { extract };
\`\`\`
`;

  const cleaned = cleanGeneratedCode(rawWithThink);
  assert.ok(!cleaned.includes('<think>'), '<think> bloğu temizlenmiş olmalı');
  assert.ok(cleaned.startsWith("'use strict'"), 'Yalnızca JS kodu kalmalı');

  // DeepSeek provider çözümleme testi
  const dsConfig = resolveLlmConfig({ provider: 'deepseek', apiKey: 'test_ds_key' });
  assert.equal(dsConfig.provider, 'deepseek');
  assert.equal(dsConfig.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(dsConfig.model, 'deepseek-chat');

  // GLM provider çözümleme testi
  const glmConfig = resolveLlmConfig({ provider: 'glm', apiKey: 'test_glm_key' });
  assert.equal(glmConfig.provider, 'glm');
  assert.equal(glmConfig.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(glmConfig.model, 'glm-4-flash');
});
