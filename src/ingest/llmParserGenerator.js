'use strict';

const vm = require('node:vm');
const { maskForLlm, unmaskCode } = require('./anonymize');
const { compileSandboxed } = require('./extractors/index');
const { coerceResult, checkSchema } = require('./schema');
const { validateDocument } = require('./validate');
const { repairDocumentText } = require('./repairKerning');

/**
 * Desteklenen hazır LLM Sağlayıcı (Provider) Ayarları
 */
const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek (Chat / Reasoner)',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    fallbackModel: 'deepseek-reasoner',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envKeys: ['DEEPSEEK_API_KEY', 'LLM_API_KEY'],
  },
  glm: {
    id: 'glm',
    name: 'GLM (Zhipu AI GLM-4 / GLM-4 Flash / GLM-4 Air)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    fallbackModel: 'glm-4-plus',
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
Sen e-Fatura / e-Arşiv / e-İrsaliye PDF metinlerinden (pdftotext -layout çıktısı) yapısal veri çıkaran uzman bir JavaScript extractor yazarısın.

GİRDİ HAKKINDA:
Sana gönderilen metin SENTETİK OLARAK MASKELENMİŞTİR: sütun düzeni, etiketler ve değerlerin BİÇİMİ gerçektir;
ama unvan, adres, VKN/TCKN, belge no, ETTN, tarih, tutar ve kalem açıklamaları rastgele uydurulmuş değerlerdir.
Yazdığın kod daha sonra aynı şablondaki GERÇEK faturalarda çalıştırılacak.

KESİN KURALLAR:
1. Metinde gördüğün hiçbir DEĞERİ koda sabit yazma (unvan, adres, numara, tutar, açıklama). Değerleri regex ile oku.
2. Şablon tanımayı (extract'ın null dönüp dönmeyeceğini) yalnızca SABİT ETİKETLERLE yap
   (ör. "e-Arşiv Fatura", "Fatura No", "Mal Hizmet Toplam Tutarı", tablo başlıkları). Satıcı adı/adresi ile tanıma YAPMA.
3. Kod izole bir ortamda çalışır: require() YOKTUR (yalnız geriye dönük uyum için require('../../normalize') çalışır),
   dosya/ağ erişimi yoktur. Hazır global yardımcılar:
     normalize.parseTrNumber("15.000,00") -> 15000   (TL/USD/EUR sonekini de temizler)
     normalize.parseTrPercent("%20,00")   -> 20
     normalize.parseTrDate("30-06-2026" | "30.06.2026" | "30/06/2026" | "09 - 05 - 2026") -> "2026-06-30"
4. Sayısal alanlar JS number olmalı (normalize.parseTrNumber kullan), tarih "YYYY-AA-GG", saat "SS:DD" veya "SS:DD:ss".
   Bulunamayan alan null olmalı. Asla "[...]" biçiminde yer tutucu döndürme.
5. Kalemler: tablodaki her veri satırı TEK bir kalemdir. Birden çok satıra bölünmüş açıklamayı birleştir; bir açıklama
   satırını iki kaleme birden ekleme. Kalem tutarlarının toplamı "Mal Hizmet Toplam Tutarı" ile, KDV tutarlarının
   toplamı "Hesaplanan KDV" ile tutmalıdır.
6. Satır sonları önce normalize edilmeli: text = text.replace(/\\r\\n?/g, '\\n').
7. Yanıtında SADECE tek bir \`\`\`js ... \`\`\` kod bloğu olsun; açıklama yazma.

ÜRETİLECEK MODÜL:

\`\`\`js
'use strict';

function extract(text) {
  if (!text) return null;
  text = text.replace(/\\r\\n?/g, '\\n');
  // if (!/<sabit şablon etiketi>/.test(text)) return null;

  const header = {
    belge_tipi: 'FATURA',            // 'FATURA' | 'IRSALIYE'
    belge_no: null, ettn: null, duzenleme_tarihi: null, duzenleme_zamani: null,
    senaryo: null, fatura_tipi: null,
    satici_unvan: null, satici_vkn_tckn: null, satici_vergi_dairesi: null,
    satici_adres: null, satici_eposta: null, satici_telefon: null,
    alici_unvan: null, alici_vkn_tckn: null, alici_vergi_dairesi: null,
    alici_adres: null, alici_eposta: null, alici_telefon: null,
    mal_hizmet_toplam_tutari: null, toplam_iskonto: null, kdv_matrahi: null,
    hesaplanan_kdv_toplam: null, vergiler_dahil_toplam_tutar: null, odenecek_tutar: null,
    notlar: null,
  };
  const items = []; // { sira_no, aciklama, miktar, birim, birim_fiyat, iskonto_orani, iskonto_tutari,
                    //   net_satir_tutari, kdv_orani, kdv_tutari, mal_hizmet_tutari }

  return { header, items };
}

module.exports = { extract };
\`\`\`
`;

function envInt(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

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
  const modelExplicit = Boolean(options.model || process.env.LLM_MODEL);

  return {
    provider: preset.id,
    providerName: preset.name,
    apiKey,
    baseUrl,
    model,
    fallbackModel: modelExplicit ? null : (preset.fallbackModel || null),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 120000),
  };
}

/**
 * Uç nokta bu makinede (veya kullanıcının "yerel" ilan ettiği bir sunucuda)
 * mı? Tam (maskesiz) fatura metni yalnız yerel uç noktalara gönderilebilir.
 */
function isLocalEndpoint(config) {
  if (process.env.LLM_ENDPOINT_IS_LOCAL === 'true') return true;
  try {
    const host = new URL(config.baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** Bir anahtar yerel uç nokta için gerekmez (Ollama vb. anahtarsız çalışır). */
function hasUsableConfig(config) {
  return Boolean(config.apiKey) || (config.provider === 'custom' && isLocalEndpoint(config));
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
 * OpenAI uyumlu /chat/completions çağrısı (DeepSeek, GLM, OpenAI, Ollama).
 * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
 */
async function chatCompletion(messages, config, extra = {}) {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages, temperature: 0.1, ...extra }),
      signal: AbortSignal.timeout(config.timeoutMs || 120000),
    });
    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 500);
      return { ok: false, error: `LLM API Hatası [${config.providerName}] (${response.status}): ${errorText}` };
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: `${config.providerName} API boş yanıt döndü.` };
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `${config.providerName} API çağrısı başarısız: ${err.message}` };
  }
}

/**
 * Tek bir kod üretim çağrısı (doğrulama döngüsü olmadan).
 * @param {string} maskedText - maskelenmiş pdftotext -layout çıktısı
 * @returns {Promise<{ success: boolean, code?: string, error?: string, provider?: string, model?: string }>}
 */
async function generateParserFromLayout(maskedText, options = {}) {
  const config = resolveLlmConfig(options);
  if (!hasUsableConfig(config)) {
    return {
      success: false,
      error: `LLM API Anahtarı bulunamadı (${config.providerName} için LLM_API_KEY veya ilgili sağlayıcı key'i tanımlamalısınız).`,
    };
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(maskedText) },
  ];
  let res = await chatCompletion(messages, config);
  if (!res.ok && config.fallbackModel) {
    res = await chatCompletion(messages, { ...config, model: config.fallbackModel });
  }
  if (!res.ok) return { success: false, error: res.error };
  const code = cleanGeneratedCode(res.content);
  const syntax = validateJsSyntax(code);
  if (!syntax.valid) return { success: false, error: `Üretilen koda JS sözdizim hatası var: ${syntax.error}` };
  return { success: true, code, provider: config.provider, model: config.model };
}

function userPrompt(maskedText) {
  return `Aşağıdaki maskelenmiş fatura metni için extractor yaz:\n\n${maskedText}`;
}

// Geri bildirimde LLM'e gösterilecek maskeli satırları bulmak için alan → etiket
const ALAN_ETIKETLERI = {
  belge_no: /Fatura No|Belge No|İrsaliye No/i,
  ettn: /ETTN/i,
  duzenleme_tarihi: /Tarih/i,
  satici_vkn_tckn: /VKN|TCKN/,
  alici_vkn_tckn: /VKN|TCKN/,
  mal_hizmet_toplam_tutari: /Mal\s*\/?\s*Hizmet Toplam/i,
  hesaplanan_kdv_toplam: /Hesaplanan KDV/i,
  vergiler_dahil_toplam_tutar: /Vergiler Dahil/i,
  odenecek_tutar: /denecek/i,
};

/**
 * Doğrulama sonucunu LLM'e gönderilecek, GERÇEK DEĞER İÇERMEYEN bir geri
 * bildirime çevirir: yalnız kural/alan adları ve maskeli metindeki ilgili
 * satırlar kullanılır (validate notlarındaki gerçek tutarlar gönderilmez).
 */
function buildFeedback(result, validation, maskedText, runError) {
  const satirlar = [];
  if (runError) {
    satirlar.push(`Kod gerçek faturada çalışırken hata verdi: ${String(runError).replace(/\d/g, '#').slice(0, 200)}`);
  } else if (!result) {
    satirlar.push('extract() aynı şablondaki gerçek faturada null döndü: şablon tanıma koşulun fazla dar ya da değerlere bağlı. Yalnız sabit etiketlerle tanı.');
  } else {
    const header = result.header || {};
    const items = result.items || [];
    const sema = checkSchema(result).map((h) => h.replace(/\(.*\)$/, '').trim());
    if (sema.length) satirlar.push(`Tip/şema hataları: ${[...new Set(sema)].slice(0, 8).join('; ')}`);
    const eksik = Object.keys(ALAN_ETIKETLERI).filter((k) => header[k] == null || header[k] === '');
    if (eksik.length) {
      satirlar.push(`Bulunamayan alanlar: ${eksik.join(', ')}. İlgili maskeli satırlar:`);
      const ml = maskedText.split('\n');
      for (const alan of eksik) {
        const satir = ml.find((l) => ALAN_ETIKETLERI[alan].test(l));
        if (satir) satirlar.push(`  [${alan}] ${satir.trim()}`);
      }
    }
    if (items.length === 0) satirlar.push('Hiç kalem çıkarılamadı; kalem tablosu satırlarını yakalayan regex eşleşmiyor.');
    for (const not of validation?.notlar || []) {
      if (/Kalem toplamı/.test(not)) satirlar.push(`Kalem tutarlarının toplamı başlıktaki "Mal Hizmet Toplam Tutarı" ile tutmuyor (${items.length} kalem çıkarıldı): eksik/fazla kalem veya yanlış sütun.`);
      else if (/KDV toplamı/.test(not)) satirlar.push('Kalem KDV tutarlarının toplamı "Hesaplanan KDV" ile tutmuyor: KDV sütunu yanlış okunuyor olabilir.');
    }
    const kalemUyari = (validation?.uyarilar || []).filter((u) => /^Kalem/.test(u)).length;
    if (kalemUyari) satirlar.push(`${kalemUyari} kalemde miktar × birim fiyat veya KDV aritmetiği tutmuyor: sütunlar karışıyor olabilir.`);
  }
  return `Yazdığın extractor aynı şablondaki gerçek faturada yerel olarak test edildi ve yetersiz kaldı:\n${satirlar.join('\n')}\n\nKodu düzeltip TAMAMINI tek bir \`\`\`js bloğu olarak yeniden ver.`;
}

/**
 * Doğrulamalı parser üretimi: maskeli metinden kod üretir, kodu sandbox'ta
 * GERÇEK metin üzerinde çalıştırıp doğrular; yetersizse PII'siz geri
 * bildirimle en fazla `LLM_MAX_ATTEMPTS` tur düzeltme ister. Son turda
 * (varsa) daha güçlü yedek modele geçer.
 *
 * @param {object} args
 * @param {string} args.text - gerçek segment metni (yalnız yerelde kullanılır)
 * @param {string|null} [args.rawText] - kerning onarımı için -raw metin
 * @param {number} [args.baselineSkor] - geçilmesi gereken mevcut en iyi skor
 * @param {object} [args.options] - provider/model/apiKey/baseUrl
 * @param {Function} [args.log]
 * @returns {Promise<{ success: boolean, code?: string, result?: object, validation?: object, attempts: number, error?: string, provider?: string, model?: string }>}
 */
async function generateValidatedParser({ text, rawText = null, baselineSkor = 0, options = {}, log = console.log }) {
  const config = resolveLlmConfig(options);
  if (!hasUsableConfig(config)) {
    return { success: false, attempts: 0, error: `LLM API Anahtarı bulunamadı (${config.providerName}).` };
  }

  let masked;
  let harita;
  try {
    ({ masked, harita } = maskForLlm(text));
  } catch (err) {
    return { success: false, attempts: 0, error: err.message };
  }

  const maxAttempts = options.maxAttempts || envInt('LLM_MAX_ATTEMPTS', 3);
  const minSkor = options.minSkor || envInt('LLM_MIN_SKOR', 70);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(masked) },
  ];

  let best = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useFallback = attempt === maxAttempts && attempt > 1 && config.fallbackModel;
    const cfg = useFallback ? { ...config, model: config.fallbackModel } : config;
    log(`[LLM Parser] Deneme ${attempt}/${maxAttempts} (${cfg.provider}/${cfg.model})`);

    const res = await chatCompletion(messages, cfg);
    if (!res.ok) {
      lastError = res.error;
      // Ağ/kimlik hatasında aynı istemi tekrarlamak yerine yedek modeli dene
      if (config.fallbackModel && cfg.model !== config.fallbackModel) {
        const res2 = await chatCompletion(messages, { ...config, model: config.fallbackModel });
        if (!res2.ok) break;
        res.ok = true;
        res.content = res2.content;
      } else {
        break;
      }
    }

    // LLM maskeli etiketlerle yazdı; yerelde çalışacak kod gerçek etiketleri kullanmalı.
    const code = unmaskCode(cleanGeneratedCode(res.content), harita);
    messages.push({ role: 'assistant', content: res.content });

    let result = null;
    let validation = null;
    let runError = null;
    try {
      const extractor = compileSandboxed(code, 'llm-uretimi.js');
      result = extractor.extract(text);
      if (result && result.header) {
        result = coerceResult(result);
        if (!Array.isArray(result.items)) result.items = [];
        repairDocumentText(result, rawText);
        validation = validateDocument(result.header, result.items);
      } else {
        result = null;
      }
    } catch (err) {
      runError = err.message;
    }

    if (validation) {
      log(`[LLM Parser] Deneme ${attempt}: ${validation.durum}, skor ${validation.skor} (eşik ${minSkor}, mevcut ${baselineSkor})`);
      if (!best || validation.skor > best.validation.skor) {
        best = { code, result, validation, model: cfg.model };
      }
      if (validation.durum !== 'HATALI' && validation.skor >= minSkor && validation.skor > baselineSkor) {
        return {
          success: true, code, result, validation, attempts: attempt,
          provider: cfg.provider, model: cfg.model,
        };
      }
    } else {
      log(`[LLM Parser] Deneme ${attempt}: ${runError ? `çalışma hatası (${runError})` : 'şablon tanınmadı'}`);
    }

    messages.push({ role: 'user', content: buildFeedback(result, validation, masked, runError) });
  }

  return {
    success: false,
    attempts: maxAttempts,
    error: lastError || `Üretilen parser eşik skorunu (${minSkor}) veya mevcut sonucu (${baselineSkor}) geçemedi`,
    best,
  };
}

module.exports = {
  PROVIDERS,
  SYSTEM_PROMPT,
  resolveLlmConfig,
  isLocalEndpoint,
  hasUsableConfig,
  chatCompletion,
  generateParserFromLayout,
  generateValidatedParser,
  buildFeedback,
  cleanGeneratedCode,
  validateJsSyntax,
};
