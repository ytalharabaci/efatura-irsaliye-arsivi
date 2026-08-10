'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { pdfToText } = require('../../ingest/pdfToText');
const { anonymizePdfText } = require('../../ingest/anonymize');
const {
  PROVIDERS,
  generateParserFromLayout,
  resolveLlmConfig,
} = require('../../ingest/llmParserGenerator');
const {
  dispatch,
  listExtractors,
  registerDynamicExtractor,
  loadDynamicExtractors,
} = require('../../ingest/extractors/index');

const router = express.Router();

/**
 * GET /api/extractors
 * Kayıtlı extractor'ların listesini ve aktif LLM konfigürasyonunu döndürür.
 */
router.get('/', (req, res) => {
  const activeConfig = resolveLlmConfig();
  res.json({
    extractors: listExtractors(),
    activeLlm: {
      provider: activeConfig.provider,
      providerName: activeConfig.providerName,
      model: activeConfig.model,
      baseUrl: activeConfig.baseUrl,
      hasApiKey: Boolean(activeConfig.apiKey),
    },
  });
});

/**
 * GET /api/extractors/providers
 * Desteklenen hazır LLM sağlayıcılarını (DeepSeek, GLM, OpenAI, Custom) listeler.
 */
router.get('/providers', (req, res) => {
  res.json({ providers: PROVIDERS });
});

/**
 * POST /api/extractors/generate
 * Tanınmayan bir fatura için yerel maskeleme + LLM ile parser üretip kaydeder.
 */
router.post('/generate', async (req, res) => {
  const { pdfPath, text, name, provider, apiKey, baseUrl, model } = req.body || {};

  let rawText = text;
  if (!rawText && pdfPath) {
    try {
      rawText = await pdfToText(pdfPath);
    } catch (err) {
      return res.status(400).json({ error: `PDF metni okunamadı: ${err.message}` });
    }
  }

  if (!rawText) {
    return res.status(400).json({ error: 'pdfPath veya text parametresi gerekli.' });
  }

  const anonymizedText = anonymizePdfText(rawText);
  const genResult = await generateParserFromLayout(anonymizedText, {
    provider,
    apiKey,
    baseUrl,
    model,
  });

  if (!genResult.success) {
    return res.status(500).json({ error: genResult.error });
  }

  const extractorName = name || `dynamic_${Date.now()}`;
  try {
    const savedPath = registerDynamicExtractor(extractorName, genResult.code);
    const dispatched = dispatch(rawText);

    return res.json({
      success: true,
      extractorName,
      savedPath,
      provider: genResult.provider,
      model: genResult.model,
      testResult: dispatched ? dispatched.result : null,
    });
  } catch (err) {
    return res.status(500).json({ error: `Extractor kaydetme hatası: ${err.message}` });
  }
});

/**
 * DELETE /api/extractors/dynamic/:name
 * Dinamik oluşturulmuş bir extractor'ı siler.
 */
router.delete('/dynamic/:name', (req, res) => {
  const { name } = req.params;
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(__dirname, '..', '..', 'ingest', 'extractors', 'dynamic', `${safeName}.js`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Dinamik extractor bulunamadı.' });
  }

  try {
    fs.unlinkSync(filePath);
    delete require.cache[require.resolve(filePath)];
    loadDynamicExtractors();
    return res.json({ success: true, message: `${safeName} extractor'ı silindi.` });
  } catch (err) {
    return res.status(500).json({ error: `Silme hatası: ${err.message}` });
  }
});

module.exports = router;
