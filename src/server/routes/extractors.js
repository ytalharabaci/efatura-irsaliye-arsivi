'use strict';

const express = require('express');
const path = require('node:path');
const { pdfToText, pdfToTextRaw } = require('../../ingest/pdfToText');
const { splitIntoDocuments } = require('../../ingest/splitDocuments');
const {
  PROVIDERS,
  generateValidatedParser,
  resolveLlmConfig,
  hasUsableConfig,
} = require('../../ingest/llmParserGenerator');
const {
  dispatchAll,
  listExtractors,
  registerDynamicExtractor,
  unregisterDynamicExtractor,
  templateFingerprint,
  findByFingerprint,
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
      usable: hasUsableConfig(activeConfig),
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
 * Bir fatura için maskeli metinden LLM ile parser üretir, gerçek metin
 * üzerinde yerel olarak doğrular ve yalnız eşiği geçerse kaydeder.
 *
 * Güvenlik: API anahtarı ve uç nokta (baseUrl) yalnız sunucu ortamından
 * okunur — istemci başka bir sunucuya istek yönlendiremez ya da anahtar
 * enjekte edemez. provider/model yalnız beyaz listeden seçilebilir.
 */
router.post('/generate', async (req, res) => {
  const { pdfPath, text, name, provider, model } = req.body || {};

  if (provider != null && !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    return res.status(400).json({ error: `Geçersiz provider. Seçenekler: ${Object.keys(PROVIDERS).join(', ')}` });
  }
  const preset = PROVIDERS[provider || resolveLlmConfig().provider];
  if (model != null && !(preset && preset.models.includes(model))) {
    return res.status(400).json({ error: `Geçersiz model. Seçenekler: ${preset ? preset.models.join(', ') : '-'}` });
  }
  if (name != null && !/^[a-zA-Z0-9_-]{1,64}$/.test(String(name))) {
    return res.status(400).json({ error: 'Geçersiz extractor adı (harf, rakam, _ ve - kullanılabilir).' });
  }

  let metin = typeof text === 'string' ? text : null;
  let rawText = null;
  if (!metin && pdfPath) {
    // Güvenlik: path traversal saldırısını önle.
    // İstemciden gelen yolu resolve edip proje kökü içinde olup olmadığını ve
    // .pdf uzantısını doğrula. Dışarı çıkan ya da .pdf olmayan yollar reddedilir.
    const PROJECT_ROOT = path.resolve(path.join(__dirname, '..', '..', '..'));
    const resolved = path.resolve(pdfPath);
    if (
      !resolved.startsWith(PROJECT_ROOT + path.sep) ||
      !resolved.toLowerCase().endsWith('.pdf')
    ) {
      return res.status(400).json({
        error: 'Geçersiz pdfPath: yalnızca proje dizini içindeki .pdf dosyaları kabul edilir.',
      });
    }
    try {
      metin = await pdfToText(resolved);
      rawText = await pdfToTextRaw(resolved).catch(() => null);
    } catch (err) {
      return res.status(400).json({ error: `PDF metni okunamadı: ${err.message}` });
    }
  }

  if (!metin) {
    return res.status(400).json({ error: 'pdfPath veya text parametresi gerekli.' });
  }

  // Çok faturalı PDF'te ilk belge şablonu temsil eder.
  const segment = splitIntoDocuments(metin)[0];
  const options = { provider, model, force: true };
  if (!hasUsableConfig(resolveLlmConfig(options))) {
    return res.status(400).json({ error: 'LLM yapılandırılmamış: sunucuda API anahtarı (veya yerel LLM) tanımlı değil.' });
  }

  const [mevcutEnIyi] = dispatchAll(segment, { rawText });
  const gen = await generateValidatedParser({
    text: segment,
    rawText,
    baselineSkor: 0, // elle tetiklenen üretimde mevcut sonuçla yarışma şartı yok; yalnız eşik
    options,
  });

  if (!gen.success) {
    return res.status(422).json({
      error: gen.error,
      attempts: gen.attempts,
      bestSkor: gen.best ? gen.best.validation.skor : null,
      mevcutSkor: mevcutEnIyi ? mevcutEnIyi.validation.skor : null,
    });
  }

  const fingerprint = templateFingerprint(segment);
  const extractorName = name || findByFingerprint(fingerprint)?.name || `dynamic_${fingerprint}`;
  try {
    const savedPath = registerDynamicExtractor(extractorName, gen.code, {
      fingerprint, provider: gen.provider, model: gen.model,
      skor: gen.validation.skor, denemeSayisi: gen.attempts,
    });
    return res.json({
      success: true,
      extractorName,
      savedPath,
      provider: gen.provider,
      model: gen.model,
      attempts: gen.attempts,
      durum: gen.validation.durum,
      skor: gen.validation.skor,
      mevcutSkor: mevcutEnIyi ? mevcutEnIyi.validation.skor : null,
      testResult: gen.result,
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
  try {
    if (!unregisterDynamicExtractor(name)) {
      return res.status(404).json({ error: 'Dinamik extractor bulunamadı.' });
    }
    return res.json({ success: true, message: `${name} extractor'ı silindi.` });
  } catch (err) {
    return res.status(500).json({ error: `Silme hatası: ${err.message}` });
  }
});

module.exports = router;
