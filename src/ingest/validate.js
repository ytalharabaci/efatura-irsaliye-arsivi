'use strict';

const { checkSchema } = require('./schema');
const { isValidVknTckn } = require('./normalize');

const TOLERANCE = 0.05;

function close(a, b, tol = TOLERANCE) {
  return Math.abs(a - b) <= tol;
}

// Alan doluluğu ağırlıkları (toplam 50): belgeyi tanımlayan ve muhasebede
// kullanılan alanlar daha ağır.
const ALAN_AGIRLIKLARI = {
  belge_no: 8,
  ettn: 8,
  duzenleme_tarihi: 6,
  satici_vkn_tckn: 5,
  satici_unvan: 4,
  alici_unvan: 3,
  alici_vkn_tckn: 3,
  mal_hizmet_toplam_tutari: 4,
  hesaplanan_kdv_toplam: 3,
  vergiler_dahil_toplam_tutar: 3,
  odenecek_tutar: 3,
};

const ZORUNLU_ALANLAR = ['belge_no', 'duzenleme_tarihi', 'ettn', 'odenecek_tutar'];

/**
 * Extractor sonucunu denetler ve 0–100 arası bir güven skoru üretir.
 *
 * - `notlar`: belgenin kendi içinde tutarsız olduğunu gösteren bulgular
 *   (kalem toplamı ≠ başlık toplamı vb.) → durum ŞÜPHELİ. Şema/tip ihlali
 *   (sayı alanında metin, yer tutucu değer) → durum HATALI.
 * - `uyarilar`: eksik alan, VKN/TCKN kontrol basamağı, kalem içi aritmetik
 *   gibi yumuşak bulgular — durumu değiştirmez, skoru düşürür.
 *
 * @returns {{ durum: 'BASARILI'|'SUPHELI'|'HATALI', notlar: string[], uyarilar: string[], skor: number }}
 */
function validateDocument(header, items) {
  const notlar = [];
  const uyarilar = [];
  items = Array.isArray(items) ? items : [];

  const semaHatalari = checkSchema({ header, items });
  if (semaHatalari.length) {
    return {
      durum: 'HATALI',
      notlar: semaHatalari.slice(0, 10).map((h) => `Şema: ${h}`),
      uyarilar,
      skor: 0,
    };
  }

  let skor = 0;
  for (const [alan, agirlik] of Object.entries(ALAN_AGIRLIKLARI)) {
    if (header[alan] != null && header[alan] !== '') skor += agirlik;
  }
  if (items.length > 0) skor += 10;

  const itemTotal = items.reduce((sum, it) => sum + (it.mal_hizmet_tutari || 0), 0);
  const itemKdv = items.reduce((sum, it) => sum + (it.kdv_tutari || 0), 0);
  const iskonto = header.toplam_iskonto || 0;

  // --- Belge geneli tutarlılık (40 puan) ---
  if (header.mal_hizmet_toplam_tutari != null) {
    // Belge geneli iskonto varsa bazı şablonlar kalem tutarlarını iskontolu,
    // başlık toplamını iskontosuz yazar — iki yorum da tutarlı sayılır.
    const diff = Math.min(
      Math.abs(itemTotal - header.mal_hizmet_toplam_tutari),
      Math.abs(itemTotal - (header.mal_hizmet_toplam_tutari - iskonto))
    );
    if (diff > TOLERANCE) {
      notlar.push(
        `Kalem toplamı (${itemTotal.toFixed(2)}) ≠ header mal_hizmet_toplam_tutari (${header.mal_hizmet_toplam_tutari.toFixed(2)}), fark: ${diff.toFixed(2)} TL`
      );
    } else if (items.length > 0) {
      skor += 15;
    }
  }

  if (header.hesaplanan_kdv_toplam != null && items.length > 0) {
    const diff = Math.abs(itemKdv - header.hesaplanan_kdv_toplam);
    if (diff > TOLERANCE) {
      notlar.push(
        `Kalem KDV toplamı (${itemKdv.toFixed(2)}) ≠ header hesaplanan_kdv_toplam (${header.hesaplanan_kdv_toplam.toFixed(2)}), fark: ${diff.toFixed(2)} TL`
      );
    } else {
      skor += 10;
    }
  }

  // Vergiler dahil = matrah + KDV (+ ÖİV/ÖTV gibi diğer vergiler). Diğer
  // vergiler ayrıca çıkarılmadığından yalnız "eksik kalma" yönü denetlenir.
  if (header.vergiler_dahil_toplam_tutar != null && header.mal_hizmet_toplam_tutari != null) {
    const matrah = header.kdv_matrahi ?? (header.mal_hizmet_toplam_tutari - iskonto);
    const beklenen = matrah + (header.hesaplanan_kdv_toplam || 0);
    if (header.vergiler_dahil_toplam_tutar + TOLERANCE < beklenen) {
      uyarilar.push(
        `Vergiler dahil toplam (${header.vergiler_dahil_toplam_tutar.toFixed(2)}) < matrah + KDV (${beklenen.toFixed(2)})`
      );
    } else {
      skor += 5;
    }
  }

  if (header.odenecek_tutar != null && header.vergiler_dahil_toplam_tutar != null
      && !close(header.odenecek_tutar, header.vergiler_dahil_toplam_tutar, 1)) {
    // Tevkifatlı faturalarda ödenecek tutar düşük olabilir — yalnız uyarı.
    uyarilar.push(
      `Ödenecek tutar (${header.odenecek_tutar.toFixed(2)}) ≠ vergiler dahil toplam (${header.vergiler_dahil_toplam_tutar.toFixed(2)})`
    );
  }

  // --- Kalem içi aritmetik (10 puan, tutarlı kalem oranında) ---
  // Kalem tutarı ya miktar × fiyat − kalem iskontosu ya da (belge geneli
  // iskontolu şablonlarda) bunun (1 − iskonto oranı) katıdır.
  const belgeIskontoOrani = header.mal_hizmet_toplam_tutari && iskonto
    ? iskonto / header.mal_hizmet_toplam_tutari
    : 0;
  let denetlenen = 0;
  let tutarli = 0;
  items.forEach((it, i) => {
    const etiket = `Kalem ${it.sira_no ?? i + 1}`;
    let kalemTutarli = true;
    let denetlendi = false;
    if (it.miktar != null && it.birim_fiyat != null && it.mal_hizmet_tutari != null) {
      denetlendi = true;
      const brut = it.miktar * it.birim_fiyat - (it.iskonto_tutari || 0);
      const tol = Math.max(TOLERANCE, Math.abs(brut) * 0.001);
      if (!close(it.mal_hizmet_tutari, brut, tol)
          && !(belgeIskontoOrani && close(it.mal_hizmet_tutari, brut * (1 - belgeIskontoOrani), tol + 0.01))) {
        kalemTutarli = false;
        uyarilar.push(`${etiket}: miktar × birim fiyat (${brut.toFixed(2)}) ≠ tutar (${it.mal_hizmet_tutari.toFixed(2)})`);
      }
    }
    if (it.mal_hizmet_tutari != null && it.kdv_orani != null && it.kdv_tutari != null) {
      denetlendi = true;
      const beklenenKdv = it.mal_hizmet_tutari * it.kdv_orani / 100;
      if (!close(it.kdv_tutari, beklenenKdv, Math.max(TOLERANCE, beklenenKdv * 0.001) + 0.01)) {
        kalemTutarli = false;
        uyarilar.push(`${etiket}: tutar × KDV oranı (${beklenenKdv.toFixed(2)}) ≠ KDV (${it.kdv_tutari.toFixed(2)})`);
      }
    }
    if (denetlendi) {
      denetlenen++;
      if (kalemTutarli) tutarli++;
    }
  });
  if (denetlenen > 0) skor += Math.round((10 * tutarli) / denetlenen);

  // --- Zorunlu alanlar ve kimlik numarası doğrulaması ---
  for (const alan of ZORUNLU_ALANLAR) {
    if (header[alan] == null || header[alan] === '') uyarilar.push(`Eksik alan: ${alan}`);
  }
  for (const alan of ['satici_vkn_tckn', 'alici_vkn_tckn']) {
    if (header[alan] && !isValidVknTckn(header[alan])) {
      uyarilar.push(`${alan} kontrol basamağı geçersiz (${header[alan]})`);
      skor -= 3;
    }
  }

  skor = Math.max(0, Math.min(100, skor - notlar.length * 10));

  return {
    durum: notlar.length === 0 ? 'BASARILI' : 'SUPHELI',
    notlar,
    uyarilar,
    skor,
  };
}

module.exports = { validateDocument };
