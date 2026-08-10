'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  registerDynamicExtractor,
  loadDynamicExtractors,
  listExtractors,
  dispatch,
} = require('../src/ingest/extractors/index');

test('Dinamik Extractor Kaydetme, Listeleme ve Ayrıştırma', () => {
  const mockExtractorCode = `
'use strict';

function extract(text) {
  if (!text || !text.includes('OZEL_TEST_FATURASI')) return null;
  return {
    header: {
      belge_tipi: 'FATURA',
      belge_no: 'TEST202600000001',
      satici_unvan: 'Dinamik Test Satıcı',
    },
    items: [
      { sira_no: 1, aciklama: 'Dinamik Test Kalem', miktar: 1, birim_fiyat: 100 }
    ],
    confidence: 1.0,
  };
}

module.exports = { extract };
`;

  const testName = `test_variant_${Date.now()}`;
  const savedPath = registerDynamicExtractor(testName, mockExtractorCode);

  assert.ok(fs.existsSync(savedPath), 'Dosya diske yazılmış olmalı');

  // Listeleme kontrolü
  const allExtractors = listExtractors();
  const found = allExtractors.find((e) => e.name === testName);
  assert.ok(found, 'Yeni extractor listelerde bulunmalı');
  assert.equal(found.type, 'dynamic');

  // Dispatch testi
  const sampleText = 'Bu bir OZEL_TEST_FATURASI metnidir.';
  const result = dispatch(sampleText);

  assert.ok(result !== null, 'Dispatch null dönmemeli');
  assert.equal(result.name, testName);
  assert.equal(result.result.header.belge_no, 'TEST202600000001');
  assert.equal(result.result.items.length, 1);

  // Temizlik
  if (fs.existsSync(savedPath)) {
    fs.unlinkSync(savedPath);
  }
  loadDynamicExtractors();
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
  assert.equal(dsConfig.baseUrl, 'https://api.deepseek.com');
  assert.equal(dsConfig.model, 'deepseek-chat');

  // GLM provider çözümleme testi
  const glmConfig = resolveLlmConfig({ provider: 'glm', apiKey: 'test_glm_key' });
  assert.equal(glmConfig.provider, 'glm');
  assert.equal(glmConfig.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(glmConfig.model, 'glm-4-flash');
});
