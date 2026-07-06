'use strict';

const { parseTrNumber, parseTrPercent, parseTrDate } = require('../normalize');

// "-layout" çıktısında iki sütunlu satırlarda etiketin değeri ile sağdaki
// başka bir sütunun metni aynı fiziksel satıra düşebilir (örn. "Vergi Dairesi: X
// Örnek Dairesi                    10:09:13"). Değeri, tek boşlukla ayrılmış
// kelimeler olarak alıp 2+ boşluk (bir sonraki sütuna geçiş) veya satır sonunda
// durdur. İki noktadan sonra en fazla TEK boşluk kabul edilir: etiket boşsa
// ("Vergi Dairesi:" + geniş boşluk + sağ sütun) sağ sütun değer sanılmasın.
const VERGI_DAIRESI_RE = /Vergi Dairesi\s*:[ \t]?(\S+(?:[ \t]\S+)*?)(?:[ \t]{2,}|\n|$)/;

/**
 * GİB standart e-Fatura / e-Arşiv Fatura PDF formatını (pdftotext -layout
 * çıktısı) parse eder. Birden fazla entegratör bu formatı küçük
 * varyasyonlarla kullanır (Logo, Mikro, Foriba, FaturaMix, eLogo vb.):
 * başlık "e-FATURA" veya "e-Arşiv Fatura" olabilir, etiketlerde iki nokta
 * üst üste olmayabilir ("Fatura No  EAR2026..."), tarih "GG - AA - YYYY"
 * gibi boşluklu gelebilir, sayı-birim bitişik olabilir ("1,0Adet183,21TL").
 *
 * @param {string} text - pdftotext -layout çıktısı
 * @returns {{ header: object, items: object[], confidence: number } | null}
 */
function extract(text) {
  if (!text) return null;

  // CRLF gelirse (Windows pdftotext, CRLF'li fixture dosyaları) regex'lerdeki
  // \n / satır-sonu varsayımları bozulur — girişte normalize et.
  text = text.replace(/\r\n?/g, '\n');

  // Temel tanıma: "e-Fatura" / "e-Arşiv Fatura" başlığı ve bir "Fatura No"
  // etiketi (bazı şablonlarda iki nokta üst üste yok) içermeli.
  if (!/e-fatura|e-ar[şs][ıiİI]v\s+fatura/i.test(text)) return null;
  if (!/Fatura No\s*:?\s*\S/.test(text)) return null;

  const lines = text.split('\n');

  const header = {};
  header.belge_tipi = 'FATURA';

  // --- Tek satır anchor regex'leri ---
  // Önce iki noktalı biçim; yoksa iki noktasız etiket için GİB belge no
  // deseniyle (3 harf + 13 rakam) sıkı eşleşme — serbest \S+ kullanmak
  // iki noktasız şablonlarda yanlış kelime yakalayabilirdi.
  header.belge_no = matchField(text, /Fatura No\s*:\s*(\S+)/)
    || matchField(text, /Fatura No\s+([A-Z]{3}\d{13})\b/);
  header.ettn = matchField(text, /ETTN\s*:\s*([0-9a-f-]{36})/i);
  header.senaryo = matchField(text, /Senaryo\s*:?\s*([A-ZÇĞİÖŞÜ]+)/);
  header.fatura_tipi = matchField(text, /Fatura Tipi\s*:?\s*([A-ZÇĞİÖŞÜ]+)/);

  // Tarih: "Düzenleme Tarihi:" veya "Fatura Tarihi:" — bazı şablonlar
  // "09 - 05 - 2026" gibi boşluklu yazar, önce boşlukları temizle.
  const tarihRaw = matchField(
    text,
    /(?:D[uü]zenleme|Fatura) Tarihi\s*:?\s*(\d{2}\s*-\s*\d{2}\s*-\s*\d{4})/
  );
  header.duzenleme_tarihi = parseTrDate(tarihRaw ? tarihRaw.replace(/\s+/g, '') : null);

  // Zaman: "HH:MM:SS" — "Düzenleme" etiketi ve "Zamanı" etiketiyle çevrili olabilir,
  // aralarında başka satırlar (adres vb.) olabilir; geniş arama kullan.
  // Bazı şablonlar zamanı fatura tarihinin devamına "HH:MM" olarak yazar.
  const zamanM = text.match(/D[uü]zenleme[\s\S]{0,500}?(\d{2}:\d{2}:\d{2})/)
    || text.match(/Fatura Tarihi\s*:?[^\n]*?(\d{2}:\d{2}(?::\d{2})?)/);
  header.duzenleme_zamani = zamanM ? zamanM[1] : null;

  // --- Satıcı / Alıcı ---
  // Konum esaslı ayrım: satıcı bloğu sayfanın üstünde, "SAYIN" satırından
  // ÖNCE gelir; alıcı bloğu "SAYIN" satırından SONRA gelir. VKN/TCKN,
  // vergi dairesi ve e-posta bu iki bölgede ayrı ayrı aranır — sayaç/etiket
  // sıralamasına dayalı eski sezgisel, satıcısı VKN'li alıcısı TCKN'li
  // faturalarda (ör. kurumsal satıcı → şahıs alıcı) tersine dönüyordu.
  const sayinIdx = lines.findIndex((l) => /SAYIN/.test(l));
  const oncesi = sayinIdx > 0 ? lines.slice(0, sayinIdx).join('\n') : '';
  const sonrasi = sayinIdx >= 0 ? lines.slice(sayinIdx).join('\n') : '';

  const ID_RE = /\b(?:VKN|TCKN)\s*:\s*(\d{10,11})/;

  header.satici_unvan = extractSaticiUnvan(lines);
  if (sayinIdx > 0) {
    header.satici_vkn_tckn = matchField(oncesi, ID_RE);
    header.satici_vergi_dairesi = matchField(oncesi, VERGI_DAIRESI_RE);
  } else {
    // SAYIN bulunamadı — eski sezgisel: ilk TCKN satıcıya ait say
    header.satici_vkn_tckn = matchField(text, /TCKN\s*:\s*(\d+)/);
    header.satici_vergi_dairesi = matchField(text, VERGI_DAIRESI_RE);
  }
  header.satici_telefon = matchField(text, /Tel\s*:\s*(\+?\d[\d\s]+)/);

  header.alici_unvan = extractAliciUnvan(lines);
  header.alici_vkn_tckn = sonrasi ? matchField(sonrasi, ID_RE) : null;
  header.alici_vergi_dairesi = extractAliciVergiDairesi(lines);
  header.alici_eposta = sonrasi ? matchField(sonrasi, /E-Posta\s*:\s*(\S+@\S+)/i) : null;

  // --- Tutarlar ---
  // Bazı şablonlar "Mal / Hizmet Toplam Tutarı" (bölü işaretli) yazar,
  // bazıları tutarı TL'ye bitişik ("505,66TL") basar.
  header.mal_hizmet_toplam_tutari = parseTrNumber(
    matchField(text, /Mal\s*\/?\s*Hizmet Toplam Tut[aA]r[ıi]\s+([\d.,]+)\s*TL/)
  );
  header.hesaplanan_kdv_toplam = parseTrNumber(
    matchField(text, /Hesaplanan KDV\s*\([^)]+\)\s+([\d.,]+)\s*TL/)
  );
  header.vergiler_dahil_toplam_tutar = parseTrNumber(
    matchField(text, /Vergiler Dahil Toplam Tutar\s+([\d.,]+)\s*TL/)
  );
  header.odenecek_tutar = parseTrNumber(
    matchField(text, /[ÖO]denecek Tutar\s+([\d.,]+)\s*TL/)
  );

  // --- Notlar (Yalnız + İrsaliye yerine geçer vb.) ---
  const notlarParts = [];
  const yalnizM = text.match(/Yaln[ıi]z\s*:\s*(.+)/);
  if (yalnizM) notlarParts.push(`Yalnız: ${yalnizM[1].trim()}`);
  if (/[İI]rsaliye yerine ge[çc]er/i.test(text)) notlarParts.push('İrsaliye yerine geçer.');
  header.notlar = notlarParts.length ? notlarParts.join(' ') : null;

  // --- Kalemler ---
  const items = extractItems(lines);

  const confidence = computeConfidence(header, items);

  return { header, items, confidence };
}

// ---------------------------------------------------------------------------
// Yardımcı fonksiyonlar
// ---------------------------------------------------------------------------

function matchField(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Satıcı unvanı: sayfanın en üstündeki metin bloğu, "SAYIN" kelimesinden önce.
 * pdftotext -layout çıktısında satıcı sol üst köşede, alıcı "SAYIN" altında yer alır.
 * İlk boş-olmayan satırı alıyoruz (genellikle ad-soyad veya şirket unvanı).
 */
function extractSaticiUnvan(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^E-Fatura$/i.test(t)) continue;
    if (/^Page \d+ of \d+$/i.test(t)) continue; // bazı şablonlar sayfa no basar
    return t;
  }
  return null;
}

/**
 * Alıcı unvanı: "SAYIN" satırından sonraki ilk anlamlı metin satırı.
 */
function extractAliciUnvan(lines) {
  let sayinIdx = lines.findIndex((l) => /^\s*SAYIN\s*$/.test(l));
  if (sayinIdx === -1) sayinIdx = lines.findIndex((l) => /SAYIN/.test(l));
  if (sayinIdx === -1) return null;

  for (let i = sayinIdx + 1; i < lines.length; i++) {
    // Unvan satırının sağına başka bir sütun ("Fatura Tipi: SATIS" gibi)
    // düşmüş olabilir — yalnızca 2+ boşluktan önceki sol sütunu al.
    const t = lines[i].trim().split(/[ \t]{2,}/)[0].trim();
    if (!t) continue;
    // Alıcı unvanı çok satırlı olabilir (ör. "Örnek Sistem... A.Ş.")
    // İlk anlamlı satırı al, sonraki kısa devam satırlarını da ekle
    let unvan = t;
    // Sonraki satır, sağdaki başka bir sütunla ("Özelleştirme No: ..." gibi)
    // aynı fiziksel satırda gelebilir — sadece 2+ boşluktan önceki sol sütun
    // parçasına (ör. "A.Ş.") bakılmalı, satırın tamamına değil.
    if (i + 1 < lines.length) {
      const nextLeftCol = lines[i + 1].split(/[ \t]{2,}/)[0].trim();
      if (nextLeftCol && nextLeftCol !== unvan && nextLeftCol.length < 20
          && /^[A-ZÇĞİÖŞÜa-zçğışöşü.\s]+$/.test(nextLeftCol) && !/:\s/.test(nextLeftCol)) {
        // Bazı şablonlar alıcı adını iki kez basar — birebir aynıysa ekleme.
        unvan += ' ' + nextLeftCol;
      }
    }
    return unvan;
  }
  return null;
}

/**
 * Alıcı vergi dairesi: "SAYIN" bloğu içindeki "Vergi Dairesi:" satırı.
 * Satıcı Vergi Dairesi de var, bu yüzden SAYIN bloğundan sonrasını arıyoruz.
 */
function extractAliciVergiDairesi(lines) {
  let sayinIdx = lines.findIndex((l) => /SAYIN/.test(l));
  if (sayinIdx === -1) return null;
  for (let i = sayinIdx; i < Math.min(sayinIdx + 30, lines.length); i++) {
    const m = lines[i].match(VERGI_DAIRESI_RE);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Kalem satırlarını çıkarır.
 * Gerçek kalem satırı pattern'i: bir satırda miktar+birim+birim fiyat+KDV%+KDV tutarı+mal hizmet tutarı.
 *
 * Örnek satır (tek satırda):
 *   "1                                                     1 Adet       15.000 TL         %20,00         3.000,00 TL             15.000,00 TL"
 *
 * Sıra no ("1") bu satırın en başında, itemLineRe'nin eşleştiği kısımdan önce
 * duruyor — ayrı bir satır olarak gelmiyor. Açıklama ("Siber Güvenlik
 * Danışmanlığı Hizmet Bedeli") ise kalem satırının hem ÖNCESİNE hem SONRASINA
 * bölünmüş halde yayılabiliyor. Bu yüzden açıklama, kalem satırından önceki
 * düz metin satırları ile hemen sonraki düz metin satırları birleştirilerek
 * oluşturuluyor.
 *
 * Not: Aynı anda birden fazla kalem varsa ve aralarında bağımsız bir sıra no
 * satırı yoksa (her kalemin sıra no'su da kendi veri satırının başında ise),
 * bir kalemin son açıklama satırı ile bir sonrakinin ilk açıklama satırını
 * ayırt etmenin güvenilir bir yolu yok — bu durumda açıklama her iki kaleme de
 * (fazladan) eklenebilir. Şimdiye kadar gözlemlenen tüm gerçek örnekler tek
 * kalemli olduğu için bu kenar durumu netleşmedi; çok kalemli gerçek bir örnek
 * geldiğinde tekrar gözden geçirilmeli.
 */
function extractItems(lines) {
  const items = [];

  // Kalem veri satırı regex'i — tüm sayısal alanları tek seferde yakalar.
  // Bazı şablonlar değerleri bitişik basar ("1,0Adet 183,2083TL ... %20,00
  // 36,64TL 183,21TL") ya da yüzdeyi boşluklu yazar ("% 20,00") — bu yüzden
  // sayı-birim ve %-sayı arasında boşluk opsiyonel.
  // Gruplar: [miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari]
  const itemLineRe = /(\d[\d.,]*)\s*(Adet|Kg|KG|Litre|Lt|m²|m2|Metre|Ton|Paket|Kutu|Hizmet|Saat)\s+([\d.,]+)\s*TL\s+%?\s*([\d.,]+)\s+([\d.,]+)\s*TL\s+([\d.,]+)\s*TL/i;

  // Birimsiz varyasyon (ör. telekom faturası): "1   546,4 TL ... %20,00  109,28 TL".
  // Mal hizmet tutarı sütunu satır taşması yüzünden başka satırlara
  // bölünebildiğinden yakalanmaz; miktar × birim fiyattan hesaplanır.
  // Gruplar: [miktar, birim_fiyat, kdv_orani, kdv_tutari]
  const itemLineNoUnitRe = /(\d[\d.,]*)\s+([\d.,]+)\s*TL\s+%\s*([\d.,]+)\s+([\d.,]+)\s*TL/;

  // Sıra no satırı (sadece rakam, opsiyonel boşluk) — bazı şablonlarda ayrı satırda gelebilir
  const siraNoRe = /^\s*(\d+)\s*$/;

  // Tablo başlığı satırlarını atlamak için ("Sıra" / "No" iki satıra bölünmüş
  // olabilir; kimi şablonda "Stok Kodu", "İskonto/Arttırım", "Diğer Vergiler"
  // sütunları ve tek başına "Tutarı"/"Oranı"/"No" parça satırları bulunur)
  // Dikkat: "^No" sonrası boşluk/satır sonu şart — adres satırlarındaki
  // "No:74" gibi ifadeler tablo başlığı sanılmasın.
  const headerLineRe = /Sıra|^No(?:\s|$)|Malzeme|Açıklama|Miktar|Birim Fiyat|KDV Oranı|KDV Tutarı|Mal\s*\/?\s*Hizmet|Stok Kodu|[ÜU]r[üu]n Kodu|[İI]skonto|Di[ğg]er Vergiler|^Tutar[ıi]$|^Oran[ıi](?:\s|$)/;

  const totalsLineRe = /Toplam Tutar|Toplam [İI]skonto|Hesaplanan\s+\S*[KO][DI]V|Vergiler Dahil|[ÖO]denecek Tutar|Yuvarlama Fark[ıi]|Yaln[ıi]z|[İI]rsaliye yerine/i;

  // Tablo sütun taşması artıkları: tek başına kalan tutar parçası ("546,40",
  // "TL") — açıklamaya karışmasın.
  const kalintiRe = /^(?:[\d.,]+(?:\s*TL)?|TL)$/;

  let leadingLines = [];   // sıradaki kalemden önce biriken açıklama satırları
  let pendingSiraNo = null; // bağımsız bir sıra no satırı görüldüyse
  let lastItem = null;      // az önce eklenen kalem — devam satırlarını buna ekle
  let inTable = false;      // kalem tablosu başlığı görülmeden hiçbir satır açıklama sayılmaz

  for (const line of lines) {
    const stripped = line.trim();

    if (headerLineRe.test(stripped)) {
      inTable = true;
      continue;
    }

    if (!stripped || !inTable) {
      continue;
    }

    if (totalsLineRe.test(stripped)) {
      // Kalem tablosu bitti, açık kalan her şeyi kapat
      leadingLines = [];
      pendingSiraNo = null;
      lastItem = null;
      continue;
    }

    let itemMatch = line.match(itemLineRe);
    let birimYok = false;
    if (!itemMatch) {
      itemMatch = line.match(itemLineNoUnitRe);
      birimYok = itemMatch != null;
    }
    if (itemMatch) {
      let miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari;
      if (birimYok) {
        [, miktar, birim_fiyat, kdv_orani, kdv_tutari] = itemMatch;
        birim = null;
        mal_hizmet_tutari = null;
      } else {
        [, miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari] = itemMatch;
      }

      // Eşleşmeden önceki kısım (satır başı): tek başına rakamsa sıra no;
      // "1  Açıklama..." biçimindeyse sıra no + satır içi açıklama; hiç rakamla
      // başlamıyorsa (ör. "124.04.0009 CODEGEN ...") tamamı satır içi açıklama.
      let siraNo = pendingSiraNo;
      let inlineDesc = null;
      const prefix = line.slice(0, itemMatch.index).trim();
      if (prefix) {
        const pm = prefix.match(/^(\d{1,3})(?:\s+(.+))?$/);
        if (pm) {
          if (siraNo == null) siraNo = pm[1];
          inlineDesc = pm[2] ? pm[2].trim() : null;
        } else {
          inlineDesc = prefix;
        }
      }

      const aciklamaParts = leadingLines.slice();
      if (inlineDesc) aciklamaParts.push(inlineDesc);
      const aciklama = aciklamaParts.join(' ').replace(/\s+/g, ' ').trim();

      const miktarNum = parseTrNumber(miktar);
      const birimFiyatNum = parseTrNumber(birim_fiyat);
      // Birimsiz şablonda tutar sütunu satır taşmasına kurban gidiyor —
      // miktar × birim fiyat ile hesapla (iskonto yoksa birebir aynı değer).
      const tutarNum = mal_hizmet_tutari != null
        ? parseTrNumber(mal_hizmet_tutari)
        : (miktarNum != null && birimFiyatNum != null
          ? Math.round(miktarNum * birimFiyatNum * 100) / 100
          : null);

      const item = {
        sira_no: siraNo != null ? parseInt(siraNo, 10) : items.length + 1,
        aciklama: aciklama || null,
        miktar: miktarNum,
        birim: birim ? birim.trim() : null,
        birim_fiyat: birimFiyatNum,
        kdv_orani: parseTrPercent(kdv_orani),
        kdv_tutari: parseTrNumber(kdv_tutari),
        mal_hizmet_tutari: tutarNum,
      };
      items.push(item);

      leadingLines = [];
      pendingSiraNo = null;
      lastItem = item;
      continue;
    }

    // Bağımsız bir sıra no satırı mı? Yeni kalem başlıyor demektir —
    // önceki kalemin devam açıklaması artık kapanır.
    const siraMatch = stripped.match(siraNoRe);
    if (siraMatch && parseInt(siraMatch[1], 10) <= 999) {
      lastItem = null;
      pendingSiraNo = siraMatch[1];
      leadingLines = [];
      continue;
    }

    // Sütun taşması artığı (tek başına tutar parçası) — açıklama sayma.
    if (kalintiRe.test(stripped)) {
      continue;
    }

    // Düz metin satırı: hem bir önceki kalemin devamı olabilir hem de
    // sıradaki kalemin açıklamasının başlangıcı — ikisine de ekleniyor.
    if (stripped.length > 0 && stripped.length < 200) {
      if (lastItem) {
        lastItem.aciklama = lastItem.aciklama ? `${lastItem.aciklama} ${stripped}` : stripped;
      }
      leadingLines.push(stripped);
    }
  }

  return items;
}

function computeConfidence(header, items) {
  let score = 0;
  if (header.belge_no) score += 20;
  if (header.ettn) score += 20;
  if (header.duzenleme_tarihi) score += 15;
  if (header.mal_hizmet_toplam_tutari != null) score += 20;
  if (items.length > 0) score += 25;
  return score;
}

module.exports = { extract };
