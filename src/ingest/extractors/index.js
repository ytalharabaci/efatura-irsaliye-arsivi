'use strict';

const fs = require('node:fs');
const path = require('node:path');
const gibStandardInvoice = require('./gibStandardInvoice');

const DYNAMIC_DIR = path.join(__dirname, 'dynamic');

// Statik extractors
const extractors = [
  { name: 'gibStandardInvoice', extractor: gibStandardInvoice, type: 'standard' },
];

/**
 * Disk üzerindeki `src/ingest/extractors/dynamic/*.js` extractor dosyalarını dinamik yükler.
 */
function loadDynamicExtractors() {
  if (!fs.existsSync(DYNAMIC_DIR)) {
    fs.mkdirSync(DYNAMIC_DIR, { recursive: true });
    return;
  }

  const files = fs.readdirSync(DYNAMIC_DIR);
  for (const file of files) {
    if (file.endsWith('.js') && !file.startsWith('.')) {
      const name = path.basename(file, '.js');
      const filePath = path.join(DYNAMIC_DIR, file);

      // Zaten eklendiyse tekrar require cache silip tazele
      delete require.cache[require.resolve(filePath)];
      try {
        const loadedModule = require(filePath);
        if (loadedModule && typeof loadedModule.extract === 'function') {
          // Eğer aynı isimde extractor önceden listede varsa güncelle, yoksa ekle
          const existingIdx = extractors.findIndex((e) => e.name === name);
          if (existingIdx >= 0) {
            extractors[existingIdx] = { name, extractor: loadedModule, type: 'dynamic', filePath };
          } else {
            extractors.push({ name, extractor: loadedModule, type: 'dynamic', filePath });
          }
        }
      } catch (err) {
        console.error(`[Extractors] Dinamik extractor yüklenemedi (${file}):`, err.message);
      }
    }
  }
}

// Başlangıçta dinamik extractor'ları tarayıp ekle
loadDynamicExtractors();

/**
 * Dinamik yeni bir JS extractor kodunu diske kaydeder ve dispatcher listesine dahil eder.
 * @param {string} name - Extractor adı (ör. dynamic_uyumsoft_variant1)
 * @param {string} codeString - JS modül kod içeriği
 * @returns {string} Saved file path
 */
function registerDynamicExtractor(name, codeString) {
  if (!fs.existsSync(DYNAMIC_DIR)) {
    fs.mkdirSync(DYNAMIC_DIR, { recursive: true });
  }

  // Geçersiz dosya adı karakterlerini temizle
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(DYNAMIC_DIR, `${safeName}.js`);

  fs.writeFileSync(filePath, codeString, 'utf8');

  // require cache temizle ve tekrar dinamik yükle
  delete require.cache[require.resolve(filePath)];
  const loadedModule = require(filePath);

  if (!loadedModule || typeof loadedModule.extract !== 'function') {
    throw new Error('Kaydedilen extractor geçerli bir extract(text) fonksiyonu ihraç etmiyor!');
  }

  const existingIdx = extractors.findIndex((e) => e.name === safeName);
  if (existingIdx >= 0) {
    extractors[existingIdx] = { name: safeName, extractor: loadedModule, type: 'dynamic', filePath };
  } else {
    extractors.push({ name: safeName, extractor: loadedModule, type: 'dynamic', filePath });
  }

  return filePath;
}

/**
 * @param {string} text - pdftotext -layout çıktısı
 * @returns {{ name: string, result: { header, items, confidence } } | null}
 */
function dispatch(text) {
  for (const { name, extractor } of extractors) {
    try {
      const result = extractor.extract(text);
      if (result !== null) {
        return { name, result };
      }
    } catch (err) {
      console.error(`[Extractors] ${name} çalışırken hata verdi:`, err.message);
    }
  }
  return null;
}

/**
 * Kayıtlı tüm extractor'ları listeler.
 */
function listExtractors() {
  return extractors.map((e) => ({
    name: e.name,
    type: e.type,
    filePath: e.filePath || null,
  }));
}

module.exports = {
  dispatch,
  loadDynamicExtractors,
  registerDynamicExtractor,
  listExtractors,
  extractors,
};
