'use strict';

// Bir PDF dosyasında birden fazla belge (art arda eklenmiş e-Faturalar)
// olabilir. pdftotext çıktısındaki form feed (\f) sayfa ayraçlarını kullanarak
// metni belge segmentlerine ayırır: her sayfanın kimliği (ETTN veya Fatura No)
// çıkarılır; kimliği önceki sayfadan FARKLI olan sayfa yeni bir belge başlatır.
// Kimliksiz sayfalar (çok sayfalı faturanın devamı, taşan dipnot sayfası vb.)
// içinde bulundukları belgeye eklenir.

const ETTN_RE = /ETTN\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const FATURA_NO_RE = /Fatura No\s*:\s*(\S+)|Fatura No\s+([A-Z]{3}\d{13})\b/;

/** Sayfanın belge kimliği: ETTN varsa o, yoksa Fatura No, yoksa null. */
function pageIdentity(pageText) {
  const ettn = pageText.match(ETTN_RE);
  if (ettn) return `ettn:${ettn[1].toLowerCase()}`;
  const no = pageText.match(FATURA_NO_RE);
  if (no) return `no:${no[1] || no[2]}`;
  return null;
}

/**
 * @param {string} text - pdftotext -layout çıktısı (\f sayfa ayraçlı)
 * @returns {string[]} - belge başına bir metin segmenti (en az 1 eleman)
 */
function splitIntoDocuments(text) {
  if (!text) return [text];

  const pages = text.split('\f').filter((p) => p.trim().length > 0);
  if (pages.length <= 1) return [text];

  const segments = [];
  let current = null; // { id: string|null, pages: string[] }

  for (const page of pages) {
    const id = pageIdentity(page);
    // Yeni belge: kimlikli bir sayfa ve mevcut segmentin kimliğinden farklı.
    // (Aynı kimlik = çok sayfalı faturanın her sayfasında yinelenen başlık;
    //  kimliksiz sayfa = önceki belgenin devamı.)
    if (current === null || (id !== null && current.id !== null && id !== current.id)) {
      current = { id, pages: [] };
      segments.push(current);
    }
    if (id !== null && current.id === null) current.id = id;
    current.pages.push(page);
  }

  return segments.map((s) => s.pages.join('\n'));
}

module.exports = { splitIntoDocuments, pageIdentity };
