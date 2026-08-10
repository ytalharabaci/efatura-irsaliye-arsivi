'use strict';

const vm = require('node:vm');

/**
 * Desteklenen hazır LLM Sağlayıcı (Provider) Ayarları
 */
const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek (V4 Flash / V4 Pro)',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    envKeys: ['DEEPSEEK_API_KEY', 'LLM_API_KEY'],
  },
  glm: {
    id: 'glm',
    name: 'GLM (Zhipu AI GLM-4 / GLM-4 Flash / GLM-4 Air)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4', 'glm-4-air', 'glm-4-plus'],
    envKeys: ['GLM_API_KEY', 'ZHIPU_API_KEY', 'LLM_API_KEY'],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI (GPT-4o / GPT-4o-mini)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    envKeys: ['OPENAI_API_KEY', 'LLM_API_KEY'],
  },
  custom: {
    id: 'custom',
    name: 'Diğer / Özel (Custom / Ollama / Local LLM)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder',
    models: ['qwen2.5-coder', 'llama3', 'custom'],
    envKeys: ['LLM_API_KEY'],
  },
};

const SYSTEM_PROMPT = `
Sen e-Fatura / e-İrsaliye PDF metinlerinden (pdftotext -layout çıktısı) yapısal veri çıkaran uzman bir Node.js regex/extractor yazarı yapay zekasın.
Sana gönderilen metin, kişisel verileri maskelenmiş bir fatura şablonu iskeletidir.

GÖREVİN:
Bu düzen iskeletini (layout skeleton) inceleyerek, metinden aşağıdaki alanları çıkaran tam bir JavaScript CommonJS modülü üretmek.

ÜRETİLECEK MODÜL YAPISI (Aynen uyulmalıdır):

\`\`\`javascript
'use strict';

const { parseTrNumber, parseTrPercent, parseTrDate } = require('../../normalize');

function extract(text) {
  if (!text) return null;
  text = text.replace(/\\r\\n?/g, '\\n');

  // Şablon tanıma kontrolü (Bu şablon değilse null dönmeli)
  // Örnek: if (!/e-fatura|e-ar[şs][ıiİI]v\\s+fatura/i.test(text)) return null;

  const header = {
    belge_tipi: 'FATURA',
    belge_no: null,
    ettn: null,
    duzenleme_tarihi: null,
    duzenleme_zamani: null,
    senaryo: null,
    fatura_tipi: null,
    satici_unvan: null,
    satici_vkn_tckn: null,
    satici_vergi_dairesi: null,
    satici_adres: null,
    satici_eposta: null,
    satici_telefon: null,
    alici_unvan: null,
    alici_vkn_tckn: null,
    alici_vergi_dairesi: null,
    alici_adres: null,
    alici_eposta: null,
    alici_telefon: null,
    mal_hizmet_toplam_tutari: null,
    toplam_iskonto: null,
    hesaplanan_kdv_toplam: null,
    vergiler_dahil_toplam_tutar: null,
    odenecek_tutar: null,
    notlar: null,
  };

  const items = [];

  // Regex ve ayıklama mantığını buraya yaz:
  // parseTrNumber("15.000,00") -> 15000.0
  // parseTrDate("30-06-2026") -> "2026-06-30"

  return { header, items, confidence: 0.9 };
}

module.exports = { extract };
\`\`\`

KURALLAR:
1. Yanıtında SADECE ve SADECE çalışan JavaScript kodunu ver. Düşünme zinciri veya markdown açıklaması EKLEME. Kod bloğu \`\`\`js ... \`\`\` dışında hiçbir şey yazma.
2. Koddaki regex'ler Türkçe karakter toleranslı olmalı (örn: \`d[uü]zenleme\`).
3. Kalem satırlarında \`sira_no\`, \`aciklama\`, \`miktar\`, \`birim\`, \`birim_fiyat\`, \`kdv_orani\`, \`kdv_tutari\`, \`mal_hizmet_tutari\` alanlarını çıkar.
`;

/**
 * Sağlayıcı ve Ortam Değişkenlerine göre nihai konfigürasyonu çözer.
 */
function resolveLlmConfig(options = {}) {
  const providerKey = (
    options.provider ||
    process.env.LLM_PROVIDER ||
    (process.env.DEEPSEEK_API_KEY ? 'deepseek' : '') ||
    (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY ? 'glm' : '') ||
    (process.env.OPENAI_API_KEY ? 'openai' : '') ||
    'openai'
  ).toLowerCase();

  const preset = PROVIDERS[providerKey] || PROVIDERS.custom;

  let apiKey = options.apiKey;
  if (!apiKey) {
    for (const key of preset.envKeys) {
      if (process.env[key]) {
        apiKey = process.env[key];
        break;
      }
    }
  }

  const baseUrl = options.baseUrl || process.env.LLM_BASE_URL || preset.baseUrl;
  const model = options.model || process.env.LLM_MODEL || preset.defaultModel;

  return {
    provider: preset.id,
    providerName: preset.name,
    apiKey,
    baseUrl,
    model,
  };
}

/**
 * DeepSeek R1 / GLM gibi modellerin <think>...</think> bloklarını ve markdown kod bloklarını temizler.
 */
function cleanGeneratedCode(rawText) {
  if (!rawText) return '';
  let code = rawText.trim();

  // DeepSeek R1 / GLM reasoning bloklarını (<think>...</think>) temizle
  code = code.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Markdown kod çitlerini (```javascript ... ```) temizle
  if (code.includes('```')) {
    const match = code.match(/```(?:javascript|js)?\s*([\s\S]*?)\s*```/i);
    if (match) {
      code = match[1].trim();
    }
  }
  return code;
}

/**
 * Validates that the generated code is valid JS syntax.
 */
function validateJsSyntax(code) {
  try {
    new vm.Script(code);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Calls OpenAI-compatible API to generate a JS parser from layout text.
 * DeepSeek (V3/V4/R1), GLM (GLM-4) ve OpenAI modellerini otomatik destekler.
 *
 * @param {string} anonymizedText - Anonymized pdftotext -layout output
 * @param {object} [options]
 * @param {string} [options.provider] - 'deepseek' | 'glm' | 'openai' | 'custom'
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @returns {Promise<{ success: boolean, code?: string, error?: string, provider?: string, model?: string }>}
 */
async function generateParserFromLayout(anonymizedText, options = {}) {
  const config = resolveLlmConfig(options);

  if (!config.apiKey) {
    return {
      success: false,
      error: `LLM API Anahtarı bulunamadı (${config.providerName} için LLM_API_KEY veya ilgili sağlayıcı key'i tanımlamalısınız).`,
    };
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Aşağıdaki maskelenmiş e-fatura/e-irsaliye şablon iskeletinden veri çıkaran bir JS extractor yaz:\n\n${anonymizedText}`,
      },
    ],
    temperature: 0.1,
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `LLM API Hatası [${config.providerName}] (${response.status}): ${errorText}` };
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return { success: false, error: `${config.providerName} API boş yanıt döndü.` };
    }

    const code = cleanGeneratedCode(rawContent);
    const syntaxCheck = validateJsSyntax(code);

    if (!syntaxCheck.valid) {
      return { success: false, error: `Üretilen koda JS sözdizim hatası var: ${syntaxCheck.error}` };
    }

    return {
      success: true,
      code,
      provider: config.provider,
      model: config.model,
    };
  } catch (err) {
    return { success: false, error: `${config.providerName} API çağrısı başarısız: ${err.message}` };
  }
}

module.exports = {
  PROVIDERS,
  resolveLlmConfig,
  generateParserFromLayout,
  cleanGeneratedCode,
  validateJsSyntax,
};
