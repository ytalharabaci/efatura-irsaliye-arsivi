'use strict';

const { parseTrNumber, parseTrPercent, parseTrDate } = require('../normalize');

// "-layout" çıktısında iki sütunlu satırlarda etiketin değeri ile sağdaki
// başka bir sütunun metni aynı fiziksel satıra düşebilir (örn. "Vergi Dairesi: X
// Örnek Dairesi                    10:09:13"). Değeri, tek boşlukla ayrılmış
// kelimeler olarak alıp 2+ boşluk (bir sonraki sütuna geçiş) veya satır sonunda
// durdur. İki noktadan sonra en fazla TEK boşluk kabul edilir: etiket boşsa
// ("Vergi Dairesi:" + geniş boşluk + sağ sütun) sağ sütun değer sanılmasın.
const VERGI_DAIRESI_RE = /Vergi Dairesi\s*:[ \t]?(\S+(?:[ \t]\S+)*?)(?:[ \t]{2,}|\n|$)/;

// Bazı şablonlarda harf aralığı (kerning) PDF metnine boşluk olarak sızar:
// "SAYIN" → "SA YIN". Alıcı bloğunu bulan tüm aramalar bu regex'i kullanır.
const SAYIN_RE = /SA\s?YIN/;

// Tutar soneki: TL dışındaki para birimleriyle düzenlenen faturalar da
// aynı şablonu kullanır.
const CUR = '(?:TL|TRY|USD|EUR|GBP)';

// Satıcı/alıcı bloklarında bir alanın başladığını gösteren etiketler —
// adres satırları bu etiketlerden birine kadar sürer.
const BLOK_ETIKET_RE = /^(?:Tel(?:efon)?|Fax|Faks|Web\s*Sitesi|E-?Posta|Vergi\s*Dairesi|VKN|TCKN|Mersis\s*No|Ticaret\s*Sicil\s*No|HIZMETNO|Müşteri\s*No|Abone\s*No|ETTN)\b/i;

// -layout çıktısında sağ sütun (fatura bilgileri kutusu) satır başından
// bu kadar boşlukla içeride başlar; daha derin girintili satır sol sütuna
// (satıcı/alıcı bloğuna) ait değildir.
const SAG_SUTUN_GIRINTI = 40;

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
  const sayinIdx = lines.findIndex((l) => SAYIN_RE.test(l));
  const oncesi = sayinIdx > 0 ? lines.slice(0, sayinIdx).join('\n') : '';
  const sonrasi = sayinIdx >= 0 ? lines.slice(sayinIdx).join('\n') : '';

  const ID_RE = /\b(?:VKN|TCKN)\s*:\s*(\d{10,11})/;

  const satici = extractSaticiBlok(lines, sayinIdx);
  header.satici_unvan = satici.unvan;
  header.satici_adres = satici.adres;
  if (sayinIdx > 0) {
    header.satici_vkn_tckn = matchField(oncesi, ID_RE);
    header.satici_vergi_dairesi = matchField(oncesi, VERGI_DAIRESI_RE);
  } else {
    // SAYIN bulunamadı — eski sezgisel: ilk TCKN satıcıya ait say
    header.satici_vkn_tckn = matchField(text, /TCKN\s*:\s*(\d+)/);
    header.satici_vergi_dairesi = matchField(text, VERGI_DAIRESI_RE);
  }
  header.satici_telefon = matchTelefon(sayinIdx > 0 ? oncesi : text);
  header.satici_eposta = sayinIdx > 0 ? matchEposta(lines.slice(0, sayinIdx)) : null;

  const alici = extractAliciBlok(lines);
  header.alici_unvan = alici.unvan;
  header.alici_adres = alici.adres;
  header.alici_vkn_tckn = sonrasi ? matchField(sonrasi, ID_RE) : null;
  header.alici_vergi_dairesi = extractAliciVergiDairesi(lines);
  const aliciBolgesi = sayinIdx >= 0 ? lines.slice(sayinIdx, sayinIdx + 30) : [];
  header.alici_eposta = sayinIdx >= 0 ? matchEposta(aliciBolgesi) : null;
  header.alici_telefon = sayinIdx >= 0 ? matchTelefon(leftColumnText(aliciBolgesi)) : null;

  // --- Tutarlar ---
  // Bazı şablonlar "Mal / Hizmet Toplam Tutarı" (bölü işaretli) yazar,
  // bazıları tutarı TL'ye bitişik ("505,66TL") basar, bazıları etiket ile
  // tutar arasına iki nokta üst üste koyar ("Ödenecek Tutar   :   39.321,00 TL").
  header.mal_hizmet_toplam_tutari = parseTrNumber(
    matchField(text, new RegExp(`Mal\\s*\\/?\\s*Hizmet Toplam Tut[aA]r[ıi]\\s*:?\\s*([\\d.,]+)\\s*${CUR}`))
  );
  // Birden fazla KDV oranı varsa şablon her oran için ayrı "Hesaplanan KDV(%X)"
  // satırı basar — belge toplamı bunların toplamıdır.
  let kdvToplam = null;
  for (const m of text.matchAll(new RegExp(`Hesaplanan KDV\\s*\\([^)]+\\)\\s*:?\\s*([\\d.,]+)\\s*${CUR}`, 'g'))) {
    const v = parseTrNumber(m[1]);
    if (v != null) kdvToplam = (kdvToplam ?? 0) + v;
  }
  header.hesaplanan_kdv_toplam = kdvToplam != null ? Math.round(kdvToplam * 100) / 100 : null;
  header.vergiler_dahil_toplam_tutar = parseTrNumber(
    matchField(text, new RegExp(`Vergiler Dahil Toplam Tutar\\s*:?\\s*([\\d.,]+)\\s*${CUR}`))
  );
  header.odenecek_tutar = parseTrNumber(
    matchField(text, new RegExp(`[ÖO]denecek Tutar\\s*:?\\s*([\\d.,]+)\\s*${CUR}`))
  );
  header.toplam_iskonto = parseTrNumber(
    matchField(text, new RegExp(`Toplam [İI]skonto\\s*(?:\\([^)]*\\))?\\s*:?\\s*([\\d.,]+)\\s*${CUR}`))
  ) || 0;
  if (header.mal_hizmet_toplam_tutari != null) {
    header.kdv_matrahi = Math.round((header.mal_hizmet_toplam_tutari - header.toplam_iskonto) * 100) / 100;
  } else {
    header.kdv_matrahi = null;
  }

  // --- Notlar (Yalnız + İrsaliye yerine geçer vb.) ---
  const notlarParts = [];
  // Büyük harfli "YALNIZ:" yazımı da kabul edilir (/i: "I" ↔ "i").
  const yalnizM = text.match(/Yaln[ıi]z\s*:\s*(.+)/i)
    || text.match(/#\s*Yaln[ıi]z\s+([^#\n]+?)\s*#/i); // "# Yalnız ... #" biçimi
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
 * Satırın sol sütun parçası: sağ sütuna ait (derin girintili) satırlar için
 * boş, diğerlerinde 2+ boşluktan önceki kısım.
 */
function leftColumn(line) {
  const girinti = line.match(/^[ \t]*/)[0].length;
  if (girinti >= SAG_SUTUN_GIRINTI) return '';
  return line.trim().split(/[ \t]{2,}/)[0].trim();
}

function leftColumnText(lines) {
  return lines.map(leftColumn).filter(Boolean).join('\n');
}

/**
 * Bir unvan satırından sonra gelen adres satırlarını, bir blok etiketine
 * (Tel, E-Posta, VKN ...) veya bloğun sonuna kadar toplar.
 */
function collectAdres(lines, start, end) {
  const parcalar = [];
  for (let i = start; i < end; i++) {
    const t = leftColumn(lines[i]);
    if (!t) continue;
    if (BLOK_ETIKET_RE.test(t) || SAYIN_RE.test(t)) break;
    parcalar.push(t);
  }
  const adres = parcalar.join(' ').replace(/\s+/g, ' ').trim();
  return adres || null;
}

/**
 * Satıcı bloğu: sayfanın en üstündeki metin bloğu, "SAYIN" satırından önce.
 * İlk anlamlı satır unvandır (ad-soyad veya şirket unvanı), etiketli
 * satırlara kadar olan devamı adrestir.
 */
function extractSaticiBlok(lines, sayinIdx) {
  const son = sayinIdx > 0 ? sayinIdx : Math.min(lines.length, 15);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^E-Fatura$/i.test(t)) continue;
    if (/^Page \d+ of \d+$/i.test(t)) continue; // bazı şablonlar sayfa no basar
    return { unvan: t, adres: i + 1 < son ? collectAdres(lines, i + 1, son) : null };
  }
  return { unvan: null, adres: null };
}

/**
 * Alıcı bloğu: "SAYIN" satırından sonraki ilk anlamlı metin satırı unvan,
 * ardından etiketli satırlara kadar gelenler adrestir.
 */
function extractAliciBlok(lines) {
  let sayinIdx = lines.findIndex((l) => /^\s*SA\s?YIN\s*$/.test(l));
  if (sayinIdx === -1) sayinIdx = lines.findIndex((l) => SAYIN_RE.test(l));
  if (sayinIdx === -1) return { unvan: null, adres: null };

  const blokSonu = Math.min(lines.length, sayinIdx + 30);
  for (let i = sayinIdx + 1; i < blokSonu; i++) {
    // Unvan satırının sağına başka bir sütun ("Fatura Tipi: SATIS" gibi)
    // düşmüş olabilir — yalnızca 2+ boşluktan önceki sol sütunu al.
    const t = lines[i].trim().split(/[ \t]{2,}/)[0].trim();
    if (!t) continue;
    // Alıcı unvanı çok satırlı olabilir (ör. "Örnek Sistem... A.Ş.")
    // İlk anlamlı satırı al, sonraki kısa devam satırlarını da ekle
    let unvan = t;
    let adresBasi = i + 1;
    // Sonraki satır, sağdaki başka bir sütunla ("Özelleştirme No: ..." gibi)
    // aynı fiziksel satırda gelebilir — sadece 2+ boşluktan önceki sol sütun
    // parçasına (ör. "A.Ş.") bakılmalı, satırın tamamına değil.
    if (i + 1 < lines.length) {
      const nextLeftCol = lines[i + 1].split(/[ \t]{2,}/)[0].trim();
      if (nextLeftCol === unvan) {
        // Bazı şablonlar alıcı adını iki kez basar — tekrarı adres sayma.
        adresBasi = i + 2;
      } else if (nextLeftCol && nextLeftCol.length < 20
          && /^[A-ZÇĞİÖŞÜa-zçğışöşü.\s]+$/.test(nextLeftCol) && !/:\s/.test(nextLeftCol)) {
        unvan += ' ' + nextLeftCol;
        adresBasi = i + 2;
      }
    }
    return { unvan, adres: collectAdres(lines, adresBasi, blokSonu) };
  }
  return { unvan: null, adres: null };
}

/** "Tel: +90 555 ..." / "Tel : (555) 111 22 33" — aynı satırdaki "Fax:" dahil edilmez. */
function matchTelefon(text) {
  const m = text.match(/\bTel(?:efon)?\s*:[ \t]*(\+?\(?\d[\d \t()-]{5,}\d)/i);
  return m ? m[1].replace(/[ \t]+/g, ' ').trim() : null;
}

/**
 * E-posta etiketinin değeri; etiket boş kalıp adres alt satırlardan birine
 * (sol sütunda) düşmüşse oradan alınır.
 */
function matchEposta(lines) {
  const idx = lines.findIndex((l) => /E-?Posta\s*:/i.test(l));
  if (idx === -1) return null;
  const ayni = lines[idx].match(/E-?Posta\s*:[ \t]*(\S+@\S+)/i);
  if (ayni) return ayni[1];
  for (let j = idx + 1; j < Math.min(idx + 4, lines.length); j++) {
    const sol = leftColumn(lines[j]);
    if (!sol) continue;
    if (/^\S+@\S+\.\S+$/.test(sol)) return sol;
    if (BLOK_ETIKET_RE.test(sol)) break;
  }
  return null;
}

/**
 * Alıcı vergi dairesi: "SAYIN" bloğu içindeki "Vergi Dairesi:" satırı.
 * Satıcı Vergi Dairesi de var, bu yüzden SAYIN bloğundan sonrasını arıyoruz.
 */
function extractAliciVergiDairesi(lines) {
  let sayinIdx = lines.findIndex((l) => SAYIN_RE.test(l));
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
 * Danışmanlığı Hizmet Bedeli") ise hücre içinde dikey ortalandığından kalem
 * satırının hem ÖNCESİNE hem SONRASINA bölünmüş halde yayılabiliyor.
 *
 * Bu yüzden iki geçiş yapılır: önce satırlar olaylara (kalem satırı, düz
 * metin, hücre artığı, sıra no, toplam) dönüştürülür; sonra iki kalem
 * arasındaki her düz metin satırı TEK bir kaleme atanır (bkz. assignGap).
 */
function extractItems(lines) {
  const items = [];

  // Kalem veri satırı regex'i — tüm sayısal alanları tek seferde yakalar.
  // Bazı şablonlar değerleri bitişik basar ("1,0Adet 183,2083TL ... %20,00
  // 36,64TL 183,21TL") ya da yüzdeyi boşluklu yazar ("% 20,00") — bu yüzden
  // sayı-birim ve %-sayı arasında boşluk opsiyonel.
  // Gruplar: [miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari]
  const itemLineRe = /(\d[\d.,]*)\s*(Adet|Kg|KG|Litre|Lt|m²|m2|Metre|Ton|Paket|Kutu|Hizmet|Saat|Tak[ıi]m)\s+([\d.,]+)\s*TL\s+%?\s*([\d.,]+)\s+([\d.,]+)\s*TL\s+([\d.,]+)\s*TL/i;

  // Birimsiz varyasyon (ör. telekom faturası): "1   546,4 TL ... %20,00  109,28 TL".
  // Mal hizmet tutarı sütunu satır taşması yüzünden başka satırlara
  // bölünebildiğinden yakalanmaz; miktar × birim fiyattan hesaplanır.
  // Gruplar: [miktar, birim_fiyat, kdv_orani, kdv_tutari]
  const itemLineNoUnitRe = /(\d[\d.,]*)\s+([\d.,]+)\s*TL\s+%\s*([\d.,]+)\s+([\d.,]+)\s*TL/;

  // İskonto sütunlu şablon (ör. hırdavat toptancısı ticari faturası): "12 Adet
  // 85,0000 TL   %20,00   173,40    867,00 TL". KDV tutarı hücresi dikey
  // hizalama bozulması yüzünden TL'siz kalabilir, tamamen komşu satıra
  // kayabilir ("%20,00   TL   1.836,00 TL") ya da mal/hizmet tutarı bir alt
  // satıra taşabilir — bu yüzden %oran'dan sonrası serbest "kuyruk" olarak
  // yakalanıp parseIskontoTail ile ayrıştırılır. ".*%" açgözlü olduğundan
  // oran, satırdaki SON yüzdedir (dolu iskonto oranı sütunu KDV sanılmaz).
  // Birim "M" yalnız burada: ardından boşluk/rakam şartı MLX/MM gibi
  // kelime içi eşleşmeleri engeller.
  // Gruplar: [miktar, birim, birim_fiyat, kdv_orani, kuyruk]
  const itemLineIskontoRe = /(\d[\d.,]*)\s*(Adet|Kg|KG|Litre|Lt|m²|m2|Metre|Ton|Paket|Kutu|Hizmet|Saat|Tak[ıi]m|M)(?=[\s\d])\s*([\d.,]+)\s*TL\b.*%\s*([\d.,]+)([^%]*)$/i;

  // Aynı şablonun birimsiz hali (birim hücresi alt satıra taşmış:
  // "80.000   0,2100 TL   %20,00   2.856,00   14.280,00 TL").
  // Gruplar: [miktar, birim_fiyat, kdv_orani, kuyruk]
  const itemLineNoUnitIskontoRe = /(\d[\d.,]*)\s+([\d.,]+)\s*TL\b.*%\s*([\d.,]+)([^%]*)$/;

  // Sıra no satırı (sadece rakam, opsiyonel boşluk) — bazı şablonlarda ayrı satırda gelebilir
  const siraNoRe = /^\s*(\d+)\s*$/;

  // Tablo başlığı satırlarını atlamak için ("Sıra" / "No" iki satıra bölünmüş
  // olabilir; kimi şablonda "Stok Kodu", "İskonto/Arttırım", "Diğer Vergiler"
  // sütunları ve tek başına "Tutarı"/"Oranı"/"No" parça satırları bulunur)
  // Dikkat: "^No" sonrası boşluk/satır sonu şart — adres satırlarındaki
  // "No:74" gibi ifadeler tablo başlığı sanılmasın.
  const headerLineRe = /Sıra|^No(?:\s|$)|Malzeme|Açıklama|Miktar|Birim Fiyat|KDV Oranı|KDV Tutarı|Mal\s*\/?\s*Hizmet|Stok Kodu|[ÜU]r[üu]n Kodu|[İI]skonto|Di[ğg]er Vergiler|^Tutar[ıi]$|^Oran[ıi](?:\s|$)/;

  const totalsLineRe = /Toplam Tutar|Toplam [İI]skonto|Toplam Masraf|Hesaplanan\s+\S*[KO][DI]V|Vergiler Dahil|[ÖO]denecek Tutar|Yuvarlama Fark[ıi]|Yaln[ıi]z|[İI]rsaliye yerine/i;

  // Tablo sütun taşması artıkları: tek başına kalan tutar parçası ("546,40",
  // "TL") — açıklamaya karışmasın.
  const kalintiRe = /^(?:[\d.,]+(?:\s*TL)?|TL)$/;

  // Başlık/satıcı/alıcı üstbilgi alanları kalem açıklamasına karışmasın
  const headerNoiseRe = /\b(?:VKN|TCKN|Vergi Dairesi|Senaryo|Fatura Tipi|Fatura No|ETTN|SA\s?YIN|[ÖO]zelle[şs]tirme No|Fatura Tarihi|Fatura Saati|[İI]rsaliye No|[İI]rsaliye Tarihi|E-Posta|Web Sitesi)\b/i;

  // Olay dizisi: { tip: 'row'|'text'|'marker'|'break', satir, ... }
  //  - row: kalem veri satırı (item + satır içi kod/açıklama)
  //  - text: açıklama adayı düz metin (cue: 'prev' | 'next' | null)
  //  - marker: yalnız hücre artığından oluşan satır (yalnız cue taşır)
  //  - break: tablo başlığı / toplamlar / bağımsız sıra no — gruplama sınırı
  const events = [];
  let pendingSiraNo = null; // bağımsız bir sıra no satırı görüldüyse
  let inTable = false;      // kalem tablosu başlığı görülmeden hiçbir satır açıklama sayılmaz
  const consumed = new Set(); // ileri bakışla tüketilen taşma satırları (indeks)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (consumed.has(i)) continue;
    const stripped = line.trim();

    if (headerLineRe.test(stripped)) {
      inTable = true;
      events.push({ tip: 'break', satir: i });
      continue;
    }

    if (!stripped || !inTable) {
      continue;
    }

    if (totalsLineRe.test(stripped)) {
      // Kalem tablosu bitti, açık kalan her şeyi kapat
      pendingSiraNo = null;
      events.push({ tip: 'break', satir: i });
      continue;
    }

    let itemMatch = line.match(itemLineRe);
    let birimYok = false;
    let iskontoVaryant = false;
    if (!itemMatch) {
      itemMatch = line.match(itemLineNoUnitRe);
      birimYok = itemMatch != null;
    }
    if (!itemMatch) {
      itemMatch = line.match(itemLineIskontoRe);
      iskontoVaryant = itemMatch != null;
    }
    if (!itemMatch) {
      itemMatch = line.match(itemLineNoUnitIskontoRe);
      if (itemMatch) { iskontoVaryant = true; birimYok = true; }
    }
    if (itemMatch) {
      let miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari;
      if (iskontoVaryant) {
        let kuyruk;
        if (birimYok) {
          [, miktar, birim_fiyat, kdv_orani, kuyruk] = itemMatch;
          birim = null;
        } else {
          [, miktar, birim, birim_fiyat, kdv_orani, kuyruk] = itemMatch;
        }
        const tail = parseIskontoTail(kuyruk);
        kdv_tutari = tail.kdv;
        mal_hizmet_tutari = tail.tutar;
        // Tutar bir alt satıra taştıysa ("TL   6.120,00 TL" gibi yalnız
        // taşma içeren satır) oradan al ve o satırı tüket.
        if (mal_hizmet_tutari == null) {
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const next = lines[j].trim();
            if (!next) continue;
            const nm = next.match(/^(?:TL\s+)?([\d.,]+)\s*TL$/);
            if (nm) {
              mal_hizmet_tutari = nm[1];
              consumed.add(j);
            }
            break;
          }
        }
      } else if (birimYok) {
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

      if (inlineDesc && headerNoiseRe.test(inlineDesc)) inlineDesc = null;

      const miktarNum = parseTrNumber(miktar);
      const birimFiyatNum = parseTrNumber(birim_fiyat);
      const oranNum = parseTrPercent(kdv_orani);
      let kdvNum = parseTrNumber(kdv_tutari);
      let tutarNum = mal_hizmet_tutari != null ? parseTrNumber(mal_hizmet_tutari) : null;

      if (iskontoVaryant) {
        // Bu şablonda kalem tutarı belge iskontosu düşülmüş yazılır, miktar ×
        // birim fiyat İSKONTOSUZ değerdir — eksik hücre komşularından türetilir:
        // KDV her zaman iskontolu tutar üzerinden hesaplandığından ikili
        // (tutar, KDV) birbirinden %oran ile çıkarılabilir.
        if (kdvNum == null && tutarNum != null && oranNum != null) {
          kdvNum = Math.round(tutarNum * oranNum) / 100;
        } else if (tutarNum == null && kdvNum != null && oranNum > 0) {
          tutarNum = Math.round((kdvNum * 100 / oranNum) * 100) / 100;
        }
      } else if (tutarNum == null) {
        // Birimsiz şablonda tutar sütunu satır taşmasına kurban gidiyor —
        // miktar × birim fiyat ile hesapla (iskonto yoksa birebir aynı değer).
        tutarNum = miktarNum != null && birimFiyatNum != null
          ? Math.round(miktarNum * birimFiyatNum * 100) / 100
          : null;
      }

      let iskontoTutarNum = 0;
      let iskontoOranNum = 0;
      let netSatirTutariNum = null;

      if (tutarNum != null) {
        netSatirTutariNum = tutarNum;
      } else if (miktarNum != null && birimFiyatNum != null) {
        netSatirTutariNum = Math.round((miktarNum * birimFiyatNum - iskontoTutarNum) * 100) / 100;
      }

      const item = {
        sira_no: siraNo != null ? parseInt(siraNo, 10) : items.length + 1,
        aciklama: null,
        miktar: miktarNum,
        birim: birim ? birim.trim() : null,
        birim_fiyat: birimFiyatNum,
        iskonto_orani: iskontoOranNum,
        iskonto_tutari: iskontoTutarNum,
        net_satir_tutari: netSatirTutariNum,
        kdv_orani: oranNum,
        kdv_tutari: kdvNum,
        mal_hizmet_tutari: tutarNum,
      };
      items.push(item);
      events.push({ tip: 'row', satir: i, item, ...splitKod(inlineDesc) });

      pendingSiraNo = null;
      continue;
    }

    // Bağımsız bir sıra no satırı mı? Yeni kalem başlıyor demektir —
    // sonraki metin satırları artık bir sonraki kaleme aittir.
    const siraMatch = stripped.match(siraNoRe);
    if (siraMatch && parseInt(siraMatch[1], 10) <= 999) {
      pendingSiraNo = siraMatch[1];
      events.push({ tip: 'break', satir: i });
      continue;
    }

    // Üstbilgi metadata satırı — açıklama sayma.
    if (headerNoiseRe.test(stripped)) continue;

    // Satırın sağına dikey hizalama bozulmasıyla düşen yalnız-sayı/TL
    // sütunları (komşu kalemin KDV tutarı vb.) açıklamadan ayıklanır;
    // hangi kaleme ait oldukları ise satırın sahibini gösterir (cue).
    const { metin, cue, birim } = splitNumericColumns(stripped);
    if (!metin || kalintiRe.test(stripped)) {
      if (cue || birim) events.push({ tip: 'marker', satir: i, cue, birim });
      continue;
    }
    if (metin.length < 200) {
      events.push({
        tip: 'text', satir: i, metin, birim,
        cue: cue || (KOD_RE.test(metin.split(/\s+/)[0]) ? 'next' : null),
      });
    }
  }

  assignDescriptions(events);
  return items;
}

// Ürün/stok kodu görünümlü belirteç: en az 5 karakter, büyük harf/rakam/tire,
// en az bir rakam ("MLX1184", "507621", "2001201B"). Bir metin satırı böyle
// başlıyorsa yeni bir kalemin kod hücresidir.
const KOD_RE = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,}$/;

/** Satır içi açıklamayı baştaki ürün kodu ve kalan metin olarak ayırır. */
function splitKod(inlineDesc) {
  if (!inlineDesc) return { kod: null, inline: null };
  const parts = inlineDesc.split(/\s+/);
  if (KOD_RE.test(parts[0])) {
    return { kod: parts[0], inline: parts.slice(1).join(' ') || null };
  }
  return { kod: null, inline: inlineDesc };
}

/**
 * Olay dizisindeki düz metin satırlarını kalemlere dağıtır ve her kalemin
 * açıklamasını "kod + önceki satırlar + satır içi metin + sonraki satırlar"
 * olarak kurar.
 */
function assignDescriptions(events) {
  const ekler = new Map(); // row event → { once: [], sonra: [] }
  const ek = (row) => {
    if (!ekler.has(row)) ekler.set(row, { once: [], sonra: [] });
    return ekler.get(row);
  };

  let prevRow = null;
  let gap = [];
  const flush = (nextRow) => {
    assignGap(gap, prevRow, nextRow, ek);
    gap = [];
  };

  for (const ev of events) {
    if (ev.tip === 'row') {
      flush(ev);
      prevRow = ev;
    } else if (ev.tip === 'text' || ev.tip === 'marker') {
      gap.push(ev);
    } else if (ev.tip === 'break') {
      // Sıra no satırına kadar olanlar öncekine; sonrası sıradaki kaleme.
      // Başlık/toplam satırı tabloyu kapatır.
      flush(null);
      prevRow = null;
    }
  }
  flush(null);

  for (const ev of events) {
    if (ev.tip !== 'row') continue;
    const { once, sonra } = ekler.get(ev) || { once: [], sonra: [] };
    const parcalar = [];
    if (ev.kod) parcalar.push(ev.kod);
    parcalar.push(...once);
    if (ev.inline) parcalar.push(ev.inline);
    parcalar.push(...sonra);
    const aciklama = parcalar.join(' ').replace(/\s+/g, ' ').trim();
    ev.item.aciklama = aciklama || null;
  }
}

/**
 * İki kalem satırı (prevRow, nextRow; tablo kenarında biri null olabilir)
 * arasındaki metin satırlarını bir bölme noktasından ikiye ayırır:
 * öncesi prevRow'un devamı, sonrası nextRow'un başlangıcıdır.
 *
 * Bölme noktası ipuçları (öncelik sırasıyla):
 *  1. "next" ipucu (TL'siz bölünmüş tutar hücresi ya da satır başında ürün
 *     kodu) taşıyan ilk satır ve sonrası nextRow'a aittir.
 *  2. Yalnız "prev" ipucu (tek başına kalmış "TL" hücre artığı) varsa,
 *     tüm aradaki satırlar prevRow'a aittir.
 *  3. İpucu yoksa satır, fiziksel olarak daha yakın kalem satırına gider;
 *     eşitlikte sıradaki kaleme (açıklamalar hücrede dikey ortalanır,
 *     üst satır genellikle alttaki kalem satırına aittir).
 */
function assignGap(gap, prevRow, nextRow, ek) {
  if (!prevRow && !nextRow) return;
  const firstNext = gap.findIndex((e) => e.cue === 'next');
  const hasPrev = gap.some((e) => e.cue === 'prev');

  for (let idx = 0; idx < gap.length; idx++) {
    const e = gap[idx];
    let sonrakine;
    if (!prevRow) sonrakine = true;
    else if (!nextRow) sonrakine = false;
    else if (firstNext !== -1) sonrakine = idx >= firstNext;
    else if (hasPrev) sonrakine = false;
    else sonrakine = (e.satir - prevRow.satir) >= (nextRow.satir - e.satir);

    const row = sonrakine ? nextRow : prevRow;
    // Alt satıra taşmış birim hücresi ("80.000 ... \n UÇLU 3,5*25  Adet")
    if (e.birim && row.item.birim == null) row.item.birim = e.birim;
    if (e.tip !== 'text') continue;
    if (sonrakine) ek(row).once.push(e.metin);
    else ek(row).sonra.push(e.metin);
  }
}

/**
 * İskonto sütunlu şablonda %oran'dan sonra kalan kuyruğu ayrıştırır.
 * Görülen biçimler: "173,40  867,00 TL" (KDV + tutar), "93,50 TL  467,50 TL",
 * "TL  1.836,00 TL" (KDV komşu satıra kaymış), "1.224,00" (tutar alt satıra
 * taşmış), "  6.375,00 TL" (yalnız tutar), "" / "TL" (her ikisi de kaymış).
 * @returns {{ kdv: string|null, tutar: string|null }}
 */
function parseIskontoTail(kuyruk) {
  const t = (kuyruk || '').trim();
  let m = t.match(/^(?:([\d.,]+)\s*(?:TL)?\s+)?(?:TL\s+)?([\d.,]+)\s*TL$/);
  if (m) return { kdv: m[1] ?? null, tutar: m[2] };
  m = t.match(/^([\d.,]+)(?:\s*TL)?$/); // yalnız KDV kaldı, tutar taştı
  if (m) return { kdv: m[1], tutar: null };
  return { kdv: null, tutar: null };
}

/**
 * Bir açıklama satırından, 2+ boşlukla ayrılmış yalnız-sayısal sütun
 * parçalarını ("688,50", "TL", "%20,00") ayırır — bunlar dikey ortalanan
 * tutar hücrelerinin iki satıra bölünmüş yarılarıdır. Hücrenin üst yarısı
 * (TL'siz sayı) alttaki kalem satırına, alt yarısı (tek başına "TL")
 * üstteki kalem satırına aittir; aynı fiziksel satırdaki açıklama metni de
 * çoğunlukla aynı kaleme aittir → `cue`.
 * Tek başına bir birim adı ("Adet") da taşmış birim hücresidir → `birim`.
 * @returns {{ metin: string, cue: 'prev'|'next'|null, birim: string|null }}
 */
function splitNumericColumns(line) {
  const metinParcalari = [];
  let prev = false;
  let next = false;
  let birim = null;
  for (const seg of line.split(/[ \t]{2,}/)) {
    const s = seg.trim();
    if (!s) continue;
    if (TASAN_BIRIM_RE.test(s)) birim = s;
    else if (new RegExp(`^${CUR}$`).test(s)) prev = true;
    else if (/^[\d.,]+$/.test(s) && /\d/.test(s)) next = true;
    else if (new RegExp(`^(?:[\\d.,]+\\s*${CUR}|%\\s*[\\d.,]+)$`).test(s)) { /* tam hücre */ }
    else metinParcalari.push(s);
  }
  return {
    metin: metinParcalari.join(' ').trim(),
    cue: prev === next ? null : (next ? 'next' : 'prev'),
    birim,
  };
}

const TASAN_BIRIM_RE = /^(?:Adet|Kg|KG|Litre|Lt|m²|m2|Metre|Ton|Paket|Kutu|Saat|Tak[ıi]m)$/;

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
