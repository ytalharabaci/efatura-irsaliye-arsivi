'use strict';

/**
 * pdftotext -layout çıktısından kişisel verileri (KVKK) ve hassas ticari verileri
 * (TCKN, VKN, Ünvan, Adres, Telefon, E-posta, ETTN, Belge No, Tutar ve Kalem Açıklamaları)
 * maskeler. LLM'e sadece hizalama ve şablon iskeleti (layout skeleton) gönderilir.
 *
 * @param {string} text - pdftotext -layout çıktısı
 * @returns {string} - Maskelenmiş metin iskeleti
 */
function anonymizePdfText(text) {
  if (!text) return '';

  let masked = text.replace(/\r\n?/g, '\n');

  // 1. ETTN (UUID) maskeleme
  masked = masked.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    '[ETTN_UUID]'
  );

  // 2. Fatura / Belge No maskeleme (GİB formatı: 3 harf + 13 rakam veya serbest belge no)
  masked = masked.replace(
    /(Fatura No\s*:?\s*)([A-Z0-9]{16}|[A-Z0-9_-]{5,20})/gi,
    '$1[BELGE_NO]'
  );

  // 3. VKN / TCKN maskeleme
  masked = masked.replace(
    /\b(VKN|TCKN)\s*:\s*\d{10,11}\b/gi,
    '$1: [VKN_TCKN]'
  );
  masked = masked.replace(
    /\b(VKN|TCKN)\s+(\d{10,11})\b/gi,
    '$1 [VKN_TCKN]'
  );

  // 4. Vergi Dairesi maskeleme
  masked = masked.replace(
    /(Vergi Dairesi\s*:\s*)([^\n]{2,30}?)(?=[ \t]{2,}|\n|$)/gi,
    '$1[VERGI_DAIRESI]'
  );

  // 5. E-Posta maskeleme
  masked = masked.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    '[EPOSTA]'
  );

  // 6. Telefon maskeleme
  masked = masked.replace(
    /(Tel(?:efon)?\s*:\s*)(\+?\d[\d\s()-]{7,}\d)/gi,
    '$1[TELEFON]'
  );

  // 7. Tarih ve Saat maskeleme
  masked = masked.replace(
    /\b(\d{2}\s*-\s*\d{2}\s*-\s*\d{4})\b/g,
    '[DATE]'
  );
  masked = masked.replace(
    /\b(\d{2}\/\d{2}\/\d{4})\b/g,
    '[DATE]'
  );
  masked = masked.replace(
    /\b(\d{2}:\d{2}(?::\d{2})?)\b/g,
    '[TIME]'
  );

  // 8. "Yalnız: ..." tutar yazısı maskeleme
  masked = masked.replace(
    /(Yaln[ıi]z\s*:\s*)([^\n]+)/gi,
    '$1[YALNIZ_TUTAR_METNI]'
  );

  // 9. Satır kalemleri tablosundaki sayısal değerler (Miktar, Fiyat, KDV%, Tutarlar)
  // Türkçe para birimi / sayı formatları: "15.000,00 TL", "%20,00", "1 Adet", "3.000,00 TL"
  masked = masked.replace(
    /\b\d{1,3}(?:\.\d{3})*,\d{2}\s*(?:TL|TRY|USD|EUR)?\b/gi,
    '[MONEY_VAL]'
  );
  masked = masked.replace(
    /%[ \t]*\d{1,2}(?:,\d{2})?\b/g,
    '[PERCENT]'
  );

  // 10. SA YIN / SAYIN bloğu ve Ünvan / Adres maskeleme
  const lines = masked.split('\n');
  let insideSayinBlock = false;
  let sayinLineCount = 0;

  const anonymizedLines = lines.map((line) => {
    if (/SA\s?YIN/i.test(line)) {
      insideSayinBlock = true;
      sayinLineCount = 0;
      return line;
    }

    if (insideSayinBlock) {
      // Tablo başlığı veya kalem satırı geldiyse SAYIN bloğu bitmiştir
      if (
        /(Senaryo|Fatura Tipi|Fatura No|Düzenleme|ETTN|Vergi Dairesi|VKN|TCKN|Sıra|Açıklama|Malzeme|Miktar|Birim|KDV|Tutar|MONEY_VAL|PERCENT)/i.test(line)
      ) {
        insideSayinBlock = false;
        return line;
      }

      sayinLineCount++;
      if (sayinLineCount <= 3 && line.trim().length > 0) {
        const indent = line.match(/^\s*/)[0];
        return `${indent}[ALICI_UNVAN_VE_ADRES_SATIRI]`;
      }
      if (sayinLineCount > 3 || line.trim().length === 0) {
        insideSayinBlock = false;
      }
    }

    return line;
  });

  return anonymizedLines.join('\n');
}

module.exports = { anonymizePdfText };
