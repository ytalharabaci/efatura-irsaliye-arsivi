'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const gibStandardInvoice = require('./gibStandardInvoice');
const { validateDocument } = require('../validate');
const { coerceResult } = require('../schema');
const { repairDocumentText } = require('../repairKerning');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
// LLM'in ürettiği parser'lar kurulumun verisidir, kaynak kodun parçası
// değildir: data/ altında (gitignore'da) tutulur.
const LEGACY_DYNAMIC_DIR = path.join(__dirname, 'dynamic');

function dynamicDir() {
  return process.env.EXTRACTORS_DIR || path.join(PROJECT_ROOT, 'data', 'extractors');
}

const SANDBOX_TIMEOUT_MS = 1000;
const NORMALIZE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'normalize.js'), 'utf8');

// Dinamik extractor'ın çalıştığı ortam: host realm'den hiçbir nesne
// (fonksiyon, modül) içeri verilmez — `x.constructor.constructor` ile
// host'un Function'ına ulaşıp `process`'e kaçış böylece engellenir.
// normalize yardımcıları sandbox'ın içinde kaynak koddan yeniden kurulur;
// eski üretimlerdeki `require('../../normalize')` çağrısı bu kopyaya yönlenir.
const BOOTSTRAP = `
var module = { exports: {} };
var exports = module.exports;
var normalize = (function () {
  var module = { exports: {} };
  ${NORMALIZE_SOURCE}
  return module.exports;
})();
function require(name) {
  if (/normalize(\\.js)?$/.test(String(name))) return normalize;
  throw new Error('Dinamik extractor içinde require() kullanılamaz: ' + name);
}
var console = { log: function () {}, warn: function () {}, error: function () {} };
`;

/**
 * Dinamik extractor kodunu izole bir vm bağlamında derler.
 * @returns {{ extract: (text: string) => object|null }}
 */
function compileSandboxed(code, filename) {
  const ctx = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(BOOTSTRAP, ctx, { timeout: SANDBOX_TIMEOUT_MS });
  vm.runInContext(code, ctx, { filename, timeout: SANDBOX_TIMEOUT_MS });
  const hasExtract = vm.runInContext(
    "typeof module.exports.extract === 'function'", ctx, { timeout: SANDBOX_TIMEOUT_MS }
  );
  if (!hasExtract) {
    throw new Error('Extractor geçerli bir extract(text) fonksiyonu ihraç etmiyor');
  }
  return {
    extract(text) {
      ctx.__girdi = String(text ?? '');
      // Sınırdan yalnız metin geçer: sonuç sandbox içinde JSON'a çevrilir.
      const json = vm.runInContext(
        'JSON.stringify(module.exports.extract(__girdi))', ctx, { timeout: SANDBOX_TIMEOUT_MS }
      );
      ctx.__girdi = null;
      return json === undefined ? null : JSON.parse(json);
    },
  };
}

// Statik extractors
const extractors = [
  { name: 'gibStandardInvoice', extractor: gibStandardInvoice, type: 'standard' },
];

function metaPath(name) {
  return path.join(dynamicDir(), `${name}.json`);
}

function readMeta(name) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
  } catch {
    return { name };
  }
}

function writeMeta(name, meta) {
  fs.mkdirSync(dynamicDir(), { recursive: true });
  fs.writeFileSync(metaPath(name), JSON.stringify(meta, null, 2), 'utf8');
}

/** Eski konumdaki (src/ingest/extractors/dynamic) üretimleri veri dizinine taşır. */
function migrateLegacyDir() {
  if (!fs.existsSync(LEGACY_DYNAMIC_DIR)) return;
  const files = fs.readdirSync(LEGACY_DYNAMIC_DIR).filter((f) => f.endsWith('.js'));
  if (!files.length) return;
  fs.mkdirSync(dynamicDir(), { recursive: true });
  for (const f of files) {
    const hedef = path.join(dynamicDir(), f);
    if (!fs.existsSync(hedef)) fs.renameSync(path.join(LEGACY_DYNAMIC_DIR, f), hedef);
  }
}

function upsertEntry(entry) {
  const idx = extractors.findIndex((e) => e.name === entry.name);
  if (idx >= 0) extractors[idx] = entry;
  else extractors.push(entry);
}

/**
 * Veri dizinindeki dinamik extractor dosyalarını (yeniden) yükler. Diskten
 * silinmiş olanlar listeden de çıkarılır.
 */
function loadDynamicExtractors() {
  migrateLegacyDir();
  const dir = dynamicDir();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('.'))
    : [];
  const names = new Set(files.map((f) => path.basename(f, '.js')));

  for (let i = extractors.length - 1; i >= 0; i--) {
    if (extractors[i].type === 'dynamic' && !names.has(extractors[i].name)) extractors.splice(i, 1);
  }

  for (const file of files) {
    const name = path.basename(file, '.js');
    const filePath = path.join(dir, file);
    try {
      const extractor = compileSandboxed(fs.readFileSync(filePath, 'utf8'), filePath);
      upsertEntry({ name, extractor, type: 'dynamic', filePath, meta: readMeta(name) });
    } catch (err) {
      console.error(`[Extractors] Dinamik extractor yüklenemedi (${file}):`, err.message);
    }
  }
}

// Başlangıçta dinamik extractor'ları tarayıp ekle
loadDynamicExtractors();

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Dinamik yeni bir JS extractor kodunu diske kaydeder ve dispatcher listesine dahil eder.
 * @param {string} name - Extractor adı (ör. dynamic_uyumsoft_variant1)
 * @param {string} codeString - JS modül kod içeriği
 * @param {object} [meta] - parmak izi, sağlayıcı, model, skor vb.
 * @returns {string} Saved file path
 */
function registerDynamicExtractor(name, codeString, meta = {}) {
  const ad = safeName(name);
  // Önce derle: geçersiz kod diske hiç yazılmaz.
  const filePath = path.join(dynamicDir(), `${ad}.js`);
  const extractor = compileSandboxed(codeString, filePath);

  fs.mkdirSync(dynamicDir(), { recursive: true });
  fs.writeFileSync(filePath, codeString, 'utf8');
  const fullMeta = {
    name: ad,
    createdAt: new Date().toISOString(),
    basari: 0,
    hata: 0,
    disabled: false,
    ...meta,
  };
  writeMeta(ad, fullMeta);
  upsertEntry({ name: ad, extractor, type: 'dynamic', filePath, meta: fullMeta });
  return filePath;
}

/** Dinamik extractor'ı diskten ve listeden kaldırır. @returns {boolean} */
function unregisterDynamicExtractor(name) {
  const ad = safeName(name);
  const filePath = path.join(dynamicDir(), `${ad}.js`);
  const idx = extractors.findIndex((e) => e.name === ad && e.type === 'dynamic');
  const vardi = fs.existsSync(filePath) || idx >= 0;
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath(ad))) fs.unlinkSync(metaPath(ad));
  if (idx >= 0) extractors.splice(idx, 1);
  return vardi;
}

/**
 * Ingest sonucuna göre dinamik extractor istatistiğini günceller; sürekli
 * kötü sonuç veren parser otomatik devre dışı kalır.
 */
function recordDynamicOutcome(name, basarili) {
  const entry = extractors.find((e) => e.name === name && e.type === 'dynamic');
  if (!entry) return;
  const meta = { ...readMeta(name), ...entry.meta };
  if (basarili) meta.basari = (meta.basari || 0) + 1;
  else meta.hata = (meta.hata || 0) + 1;
  if (!meta.disabled && meta.hata >= 5 && meta.hata > 2 * (meta.basari || 0)) {
    meta.disabled = true;
    console.warn(`[Extractors] ${name} sürekli başarısız olduğu için devre dışı bırakıldı.`);
  }
  entry.meta = meta;
  try { writeMeta(name, meta); } catch { /* istatistik opsiyonel */ }
}

// Şablon parmak izinde aranan etiketler: değerlerden bağımsız, düzeni
// (entegratör şablonunu) tanımlayan sabit metinler.
const PARMAK_IZI_ETIKETLERI = [
  'e-Fatura', 'e-Arşiv', 'e-İrsaliye', 'SAYIN', 'SA YIN', 'Özelleştirme No', 'Senaryo', 'Fatura Tipi',
  'Fatura No', 'Fatura Tarihi', 'Düzenleme Tarihi', 'Düzenleme Zamanı', 'İrsaliye No', 'ETTN',
  'Mersis', 'Ticaret Sicil', 'Web Sitesi', 'E-Posta', 'E-posta', 'Tel', 'Fax', 'Vergi Dairesi', 'VKN', 'TCKN',
  'Sıra', 'Stok Kodu', 'Malzeme', 'Mal Hizmet', 'Miktar', 'Birim Fiyat', 'İskonto', 'KDV Oranı',
  'KDV Tutarı', 'Diğer Vergiler', 'Mal Hizmet Toplam', 'Toplam İskonto', 'Hesaplanan KDV',
  'Vergiler Dahil', 'Ödenecek Tutar', 'Yuvarlama', 'Yalnız', 'IBAN',
];

/**
 * Metnin şablon parmak izi: hangi etiketlerin, hangi sırayla ve "etiket:"
 * biçiminde mi geçtiği. Aynı entegratör şablonundaki farklı faturalar
 * aynı parmak izini üretir.
 */
function templateFingerprint(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const izler = [];
  for (const etiket of PARMAK_IZI_ETIKETLERI) {
    const idx = t.indexOf(etiket);
    if (idx === -1) continue;
    const sonrasi = t.slice(idx + etiket.length, idx + etiket.length + 25);
    izler.push({ idx, iz: `${etiket}${/^\s*:/.test(sonrasi) ? ':' : ''}` });
  }
  izler.sort((a, b) => a.idx - b.idx);
  return crypto.createHash('sha1').update(izler.map((x) => x.iz).join('|')).digest('hex').slice(0, 16);
}

function findByFingerprint(fingerprint) {
  return extractors.find((e) => e.type === 'dynamic' && e.meta && e.meta.fingerprint === fingerprint) || null;
}

/** Tek bir extractor'ı çalıştırıp sonucu doğrular; tanımazsa null. */
function runOne(entry, text, rawText) {
  let result;
  try {
    result = entry.extractor.extract(text);
  } catch (err) {
    console.error(`[Extractors] ${entry.name} çalışırken hata verdi:`, err.message);
    return null;
  }
  if (result == null || typeof result !== 'object' || !result.header) return null;
  if (entry.type === 'dynamic') result = coerceResult(result);
  if (!Array.isArray(result.items)) result.items = [];
  repairDocumentText(result, rawText);
  return {
    name: entry.name,
    type: entry.type,
    result,
    validation: validateDocument(result.header, result.items),
  };
}

/**
 * Metni tanıyan TÜM (etkin) extractor'ları çalıştırır, sonuçları doğrular
 * ve en yüksek skordan düşüğe sıralar. Eşit skorda statik extractor önce
 * gelir (insan tarafından yazılmış ve test edilmiştir).
 * @param {string} text - pdftotext -layout çıktısı
 * @param {{ rawText?: string|null, only?: string }} [opts]
 * @returns {Array<{ name, type, result, validation }>}
 */
function dispatchAll(text, opts = {}) {
  const adaylar = [];
  for (const entry of extractors) {
    if (opts.only && entry.name !== opts.only) continue;
    if (!opts.only && entry.meta && entry.meta.disabled) continue;
    const c = runOne(entry, text, opts.rawText ?? null);
    if (c) adaylar.push(c);
  }
  adaylar.sort((a, b) => (b.validation.skor - a.validation.skor)
    || ((a.type === 'dynamic') - (b.type === 'dynamic')));
  return adaylar;
}

/**
 * Geriye dönük uyumlu tekil dispatch: en iyi adayı döndürür.
 * @returns {{ name: string, result: { header, items } } | null}
 */
function dispatch(text, opts = {}) {
  const [best] = dispatchAll(text, opts);
  return best ? { name: best.name, result: best.result, validation: best.validation } : null;
}

/**
 * Kayıtlı tüm extractor'ları listeler.
 */
function listExtractors() {
  return extractors.map((e) => ({
    name: e.name,
    type: e.type,
    filePath: e.filePath || null,
    meta: e.type === 'dynamic' ? (e.meta || null) : null,
  }));
}

module.exports = {
  dispatch,
  dispatchAll,
  loadDynamicExtractors,
  registerDynamicExtractor,
  unregisterDynamicExtractor,
  recordDynamicOutcome,
  compileSandboxed,
  templateFingerprint,
  findByFingerprint,
  listExtractors,
  dynamicDir,
  extractors,
};
