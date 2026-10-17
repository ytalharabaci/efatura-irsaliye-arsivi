'use strict';

// LLM ile doğrudan yapısal çıkarım (kod üretmeden, JSON yanıt). Maskesiz
// fatura metni gönderildiğinden YALNIZ yerel uç noktada (Ollama vb.) ve
// açıkça etkinleştirildiğinde (LLM_DIRECT_EXTRACT=true) çalışır; bulut
// sağlayıcıya tam metin göndermek kod düzeyinde engellenir (KVKK).

const { resolveLlmConfig, isLocalEndpoint, chatCompletion, cleanGeneratedCode } = require('./llmParserGenerator');
const { RESULT_JSON_SCHEMA, coerceResult } = require('./schema');
const { validateDocument } = require('./validate');
const { repairDocumentText } = require('./repairKerning');

const SYSTEM_PROMPT = `
Sen e-Fatura / e-Arşiv / e-İrsaliye metinlerinden (pdftotext -layout çıktısı) yapısal veri çıkaran bir asistansın.
Yalnızca verilen JSON şemasına uyan TEK bir JSON nesnesi döndür; açıklama yazma.
Kurallar:
- Sayılar JSON number olmalı (Türkçe "15.000,00" → 15000). Oranlar yüzde sayısı (%20 → 20).
- Tarih "YYYY-AA-GG", saat "SS:DD" veya "SS:DD:ss". Metinde olmayan alan null.
- Satıcı bilgisi "SAYIN" bloğundan önce, alıcı bilgisi "SAYIN" bloğunda yer alır.
- Tablodaki her veri satırı bir kalemdir; çok satırlı açıklamaları birleştir, bir satırı iki kaleme ekleme.
- Değer uydurma: emin olmadığın alanı null bırak.
`;

function directExtractEnabled(options = {}) {
  if (options.directExtract === false) return false;
  return options.directExtract === true || process.env.LLM_DIRECT_EXTRACT === 'true';
}

/**
 * @param {string} text - gerçek segment metni
 * @param {object} [options]
 * @returns {Promise<{ success: boolean, result?: object, validation?: object, error?: string, model?: string }>}
 */
async function directExtract(text, { rawText = null, options = {} } = {}) {
  const config = resolveLlmConfig(options);
  if (!isLocalEndpoint(config)) {
    return {
      success: false,
      error: 'Doğrudan çıkarım yalnız yerel LLM uç noktasında çalışır (KVKK: maskesiz metin buluta gönderilmez).',
    };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `JSON şeması:\n${JSON.stringify(RESULT_JSON_SCHEMA)}\n\nFatura metni:\n${text}` },
  ];
  // Önce şema zorlamalı yanıt (destekleyen sunucularda), olmazsa json_object.
  let res = await chatCompletion(messages, config, {
    response_format: { type: 'json_schema', json_schema: { name: 'fatura', schema: RESULT_JSON_SCHEMA } },
  });
  if (!res.ok) res = await chatCompletion(messages, config, { response_format: { type: 'json_object' } });
  if (!res.ok) return { success: false, error: res.error };

  let parsed;
  try {
    parsed = JSON.parse(cleanGeneratedCode(res.content));
  } catch (err) {
    return { success: false, error: `LLM yanıtı geçerli JSON değil: ${err.message}` };
  }

  const result = coerceResult(parsed);
  if (!result || !result.header) return { success: false, error: 'LLM yanıtında header yok' };
  if (!Array.isArray(result.items)) result.items = [];
  repairDocumentText(result, rawText);
  return {
    success: true,
    result,
    validation: validateDocument(result.header, result.items),
    model: config.model,
  };
}

module.exports = { directExtract, directExtractEnabled };
