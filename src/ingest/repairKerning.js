'use strict';

// pdftotext -layout, geniş harf aralıklı (kerning) fontlarda kelime içine
// boşluk sokar: "HORTUM" → "HO RTUM", "SAYIN" → "SA YIN". Aynı PDF'in
// -raw çıktısında kelimeler bütün olduğundan, -raw metni referans alınarak
// bu bölünmeler onarılır: iki komşu parça birleştirildiğinde raw metinde
// geçiyorsa VE boşluklu hali raw metinde geçmiyorsa boşluk artefakttır.
// Sözlük gerektirmez; raw'da birleşik geçmeyen hiçbir boşluğa dokunulmaz
// ("EKİ LÜX" gibi gerçek boşluklar korunur).

// Yalnız harf içeren parçalar birleştirilir — sayı/tutar parçalarının
// ("3,5" + "25" gibi) yanlışlıkla yapışması veriyi bozar.
const HARF_RE = /[A-Za-zÇĞİÖŞÜçğıöşü]/;

/**
 * Tek bir metin değerindeki artefakt boşluklarını onarır.
 * @param {string|null} value - -layout çıktısından ayrıştırılmış metin
 * @param {string} rawText - aynı PDF'in pdftotext -raw çıktısı
 * @returns {string|null}
 */
function repairSpaces(value, rawText) {
  if (!value || !rawText || !value.includes(' ')) return value;

  const tokens = value.split(' ');
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (!a || !b || !HARF_RE.test(a) || !HARF_RE.test(b)) continue;
      const merged = a + b;
      if (rawText.includes(merged) && !rawText.includes(`${a} ${b}`)) {
        tokens.splice(i, 2, merged);
        changed = true;
        break; // baştan tara: zincirleme bölünmeler ("MO TO RU") adım adım kapanır
      }
    }
  }
  return tokens.join(' ');
}

// Onarılacak başlık alanları: serbest metin taşıyanlar. Sayısal/kodsal
// alanlara (belge_no, ETTN, VKN, tarih...) dokunulmaz.
const HEADER_TEXT_FIELDS = [
  'satici_unvan', 'satici_vergi_dairesi', 'satici_adres',
  'alici_unvan', 'alici_vergi_dairesi', 'alici_adres',
  'notlar',
];

/**
 * Extractor sonucundaki tüm serbest metin alanlarını yerinde onarır.
 * @param {{header: object, items: object[]}} result
 * @param {string|null} rawText - -raw çıktısı; yoksa hiçbir şey yapılmaz
 */
function repairDocumentText(result, rawText) {
  if (!rawText) return result;
  for (const field of HEADER_TEXT_FIELDS) {
    if (result.header[field]) {
      result.header[field] = repairSpaces(result.header[field], rawText);
    }
  }
  for (const item of result.items) {
    if (item.aciklama) item.aciklama = repairSpaces(item.aciklama, rawText);
  }
  return result;
}

module.exports = { repairSpaces, repairDocumentText };
