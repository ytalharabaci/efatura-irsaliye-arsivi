'use strict';

const TOLERANCE = 0.05;

/**
 * Kalemlerin mal_hizmet_tutari toplamını header toplamıyla karşılaştırır.
 * Aynı şekilde KDV toplamını da kontrol eder.
 * Sonuç: { durum: 'BASARILI'|'SUPHELI', notlar: string[] }
 */
function validateDocument(header, items) {
  const notlar = [];

  const itemTotal = items.reduce((sum, it) => sum + (it.mal_hizmet_tutari || 0), 0);
  const itemKdv = items.reduce((sum, it) => sum + (it.kdv_tutari || 0), 0);

  if (header.mal_hizmet_toplam_tutari != null) {
    // Belge geneli iskonto varsa bazı şablonlar kalem tutarlarını iskontolu,
    // başlık toplamını iskontosuz yazar — iki yorum da tutarlı sayılır.
    const iskonto = header.toplam_iskonto || 0;
    const diff = Math.min(
      Math.abs(itemTotal - header.mal_hizmet_toplam_tutari),
      Math.abs(itemTotal - (header.mal_hizmet_toplam_tutari - iskonto))
    );
    if (diff > TOLERANCE) {
      notlar.push(
        `Kalem toplamı (${itemTotal.toFixed(2)}) ≠ header mal_hizmet_toplam_tutari (${header.mal_hizmet_toplam_tutari.toFixed(2)}), fark: ${diff.toFixed(2)} TL`
      );
    }
  }

  if (header.hesaplanan_kdv_toplam != null && items.length > 0) {
    const diff = Math.abs(itemKdv - header.hesaplanan_kdv_toplam);
    if (diff > TOLERANCE) {
      notlar.push(
        `Kalem KDV toplamı (${itemKdv.toFixed(2)}) ≠ header hesaplanan_kdv_toplam (${header.hesaplanan_kdv_toplam.toFixed(2)}), fark: ${diff.toFixed(2)} TL`
      );
    }
  }

  return {
    durum: notlar.length === 0 ? 'BASARILI' : 'SUPHELI',
    notlar,
  };
}

module.exports = { validateDocument };
