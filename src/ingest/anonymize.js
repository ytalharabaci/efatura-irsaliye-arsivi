'use strict';

// KVKK uyumlu "sentetik maskeleme": pdftotext -layout çıktısındaki tüm
// kişisel/ticari değerler (unvan, adres, VKN/TCKN, ETTN, belge no, tutar,
// kalem açıklaması, e-posta, telefon, tarih) AYNI UZUNLUK VE BİÇİMDE sahte
// değerlerle değiştirilir; yalnız şablonu tanımlayan sabit etiketler
// (beyaz liste) ve KDV oranları korunur.
//
// Eski yaklaşım değerleri "[MONEY_VAL]" gibi yer tutucularla değiştiriyordu:
// LLM gerçek sayı/tarih desenini göremediği için yer tutucuyu sabit olarak
// döndüren kod yazıyordu; kara liste yaklaşımı da satıcı bloğunu kaçırıyordu.
// Burada sütun hizası birebir korunur, LLM "15.000,00" biçimini görür ama
// gerçek tutarı görmez.

const crypto = require('node:crypto');
const { isValidVkn, isValidTckn } = require('./normalize');

// Şablon etiketleri ve şablona özgü sabit kelimeler — korunur. Karşılaştırma
// Türkçe küçük harfe çevrilerek yapılır.
const SOZLUK = new Set(`
fatura faturası no tarihi tarih düzenleme zamanı saati senaryo tipi ettn vkn tckn vergi dairesi
sayın sa yin özelleştirme tel telefon fax faks web sitesi e-posta eposta posta mersis ticaret sicil
irsaliye sıra malzeme hizmet mal açıklaması açıklama açıklamalar miktar birim fiyat fiyatı iskonto
arttırım artırım oranı oran tutarı tutar nedeni kdv diğer vergiler kodu stok ürün satıcı alıcı toplam
hesaplanan dahil ödenecek yuvarlama farkı yalnız geçer yerine masraf oiv öiv ötv otv tevkifat
e-fatura e-arşiv arşiv e-irsaliye temelfatura ticarifatura earsivfatura temelirsaliye satis satış iade
tevkifat istisna ozelmatrah ihrackayitli sgk adet kg litre lt metre ton paket kutu saat takım m m2 m²
tl try usd eur gbp türkiye mah mahallesi mahalle sok sokak sk cad caddesi cd bulvar bulvarı kapı daire
blok iç kat dış ve ile genel banka iban not page of sayfa müşteri abone hizmetno dönemi ödeme koşulu son
izni kapsamında elektronik ortamda iletilmiştir imza gerekmez kur döviz para birimi a.ş a.ş. ltd şti
belge belgesi numarası numara evrak adı adresi adres unvan unvanı ünvan ünvanı açıklamalar teslim sevk
`.split(/\s+/).filter(Boolean));

const SESLI = 'AEIOU';
const SESSIZ = 'BCDFGHKLMNPRSTVYZ';

function rastgele(str) {
  return str[crypto.randomInt(str.length)];
}

function trLower(s) {
  return s.toLocaleLowerCase('tr');
}

/** Sözlükte mi? GİB kodları ASCII yazılır ("TICARIFATURA", "SATIS") — Türkçe küçültme "ı" üretir. */
function sozlukte(s) {
  return SOZLUK.has(trLower(s)) || SOZLUK.has(s.toLowerCase());
}

/** Harf dizisini aynı uzunluk ve büyük/küçük harf düzeninde sahte kelimeyle değiştirir. */
function sahteKelime(kelime) {
  let out = '';
  for (let i = 0; i < kelime.length; i++) {
    const ch = kelime[i];
    const harf = i % 2 === 0 ? rastgele(SESSIZ) : rastgele(SESLI);
    out += ch === ch.toLocaleLowerCase('tr') && ch !== ch.toLocaleUpperCase('tr')
      ? harf.toLowerCase()
      : harf;
  }
  return out;
}

/**
 * Rakam dizisini aynı uzunlukta sahte rakamlarla değiştirir. Kısa
 * dizilerde (tutar parçaları: "15", "000", "00") sıfırlar sıfır kalır ki
 * biçim okunabilsin; uzun dizilerde (posta kodu, telefon, belge no) sıfır
 * düzeni de bilgi taşıdığından tamamı rastgeledir.
 */
function sahteRakam(rakamlar) {
  if (rakamlar.length === 10) return sahteVkn();
  if (rakamlar.length === 11) return sahteTckn();
  // Sıfır olmayan bir rakam içeren dizi asla kendisiyle aynı çıkmaz.
  const degisebilir = /[1-9]/.test(rakamlar);
  for (;;) {
    let out = '';
    for (let i = 0; i < rakamlar.length; i++) {
      const ch = rakamlar[i];
      if (rakamlar.length < 5) out += ch === '0' ? '0' : String(1 + crypto.randomInt(9));
      else out += i === 0 && ch !== '0' ? String(1 + crypto.randomInt(9)) : String(crypto.randomInt(10));
    }
    if (!degisebilir || out !== rakamlar) return out;
  }
}

function sahteVkn() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 9; i++) s += crypto.randomInt(10);
    for (let d = 0; d < 10; d++) if (isValidVkn(s + d)) return s + d;
  }
}

function sahteTckn() {
  for (;;) {
    let s = String(1 + crypto.randomInt(9));
    for (let i = 0; i < 8; i++) s += crypto.randomInt(10);
    const d = [...s].map(Number);
    const d10 = ((((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10) + 10) % 10;
    const d11 = (d.reduce((a, b) => a + b, 0) + d10) % 10;
    const t = `${s}${d10}${d11}`;
    if (isValidTckn(t)) return t;
  }
}

function sahteTarih(gg, ay, yil, ayr1, ayr2) {
  const g = String(1 + crypto.randomInt(28)).padStart(gg.length, '0');
  const a = String(1 + crypto.randomInt(12)).padStart(ay.length, '0');
  const y = String(2020 + crypto.randomInt(10));
  return `${g}${ayr1}${a}${ayr2}${y}`;
}

// Sahte kelime üretiminde kaçınılan, kodda tanımlayıcı/anahtar kelime
// olarak geçebilecek sözcükler: üretilen kodda sahte → gerçek geri
// dönüşümü bunları bozmasın.
const KOD_KELIMELERI = new Set(`
line lines case data date name type time rate size node code base make page sale note zone home
take mode role rule value index items item text body file left right null true false void this
`.split(/\s+/).filter(Boolean));

/**
 * Maskeleme bağlamı: aynı gerçek kelime belge boyunca hep aynı sahte
 * kelimeye dönüşür (tutarlı takma ad). Böylece sözlükte olmayan şablon
 * etiketleri ("Belge Numarası:") LLM'e tutarlı bir belirteç olarak gider;
 * LLM'in koduna yazdığı sahte etiket, kod yerelde çalıştırılmadan önce
 * `unmaskCode` ile gerçeğine çevrilir. Eşleme tablosu dışarı gönderilmez.
 */
function yeniBaglam(text) {
  return {
    ileri: new Map(), // gerçek → sahte
    geri: new Map(),  // sahte → gerçek
    gercekler: new Set(String(text).match(/\p{L}+/gu) || []),
  };
}

const ESLEME_MIN_UZUNLUK = 4;

function takmaAd(kelime, ctx) {
  if (kelime.length < ESLEME_MIN_UZUNLUK) return sahteKelime(kelime);
  const var_ = ctx.ileri.get(kelime);
  if (var_) return var_;
  let sahte;
  do {
    sahte = sahteKelime(kelime);
  } while (ctx.geri.has(sahte) || ctx.gercekler.has(sahte) || KOD_KELIMELERI.has(sahte.toLowerCase()));
  ctx.ileri.set(kelime, sahte);
  ctx.geri.set(sahte, kelime);
  return sahte;
}

/**
 * Tek bir boşluksuz belirteci maskeler: harf/rakam/diğer koşularına bölünür;
 * sözlükteki kelimeler ve noktalama korunur.
 */
function maskToken(token, ctx) {
  // KDV/iskonto oranları ("%20,00", "(%20)") kişisel veri değildir ve
  // şablonun anlaşılması için gereklidir.
  if (/^\(?%\s*\d{1,2}(?:[.,]\d{1,2})?\)?[:.,]?$/.test(token)) return token;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    const uuid = crypto.randomUUID();
    return /[A-F]/.test(token) && !/[a-f]/.test(token) ? uuid.toUpperCase() : uuid;
  }

  const temiz = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (temiz && sozlukte(temiz)) return token;

  // Belirteç içindeki oranlar ("KDV(%20)") korunur, geri kalanı maskelenir.
  return token.split(/(%\d{1,2}(?:[.,]\d{1,2})?)/).map((parca, i) => (i % 2 === 1
    ? parca
    : parca.replace(/\p{L}+|\p{N}+/gu, (kosu) => {
      if (/^\p{N}+$/u.test(kosu)) return sahteRakam(kosu);
      return sozlukte(kosu) ? kosu : takmaAd(kosu, ctx);
    }))).join('');
}

// Tarih ("09 - 05 - 2026", "30.06.2026") ve saat ("10:09:13") — belirteç
// maskelemesinden önce bütün olarak geçerli sahte değerle değiştirilir.
const TARIH_SAAT_RE = /\b(\d{1,2})([ \t]*[-./][ \t]*)(\d{1,2})([ \t]*[-./][ \t]*)(\d{4})\b|\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g;

function sahteTarihSaat(m, gg, a1, ay, a2, yil) {
  if (yil) return sahteTarih(gg, ay, yil, a1, a2);
  const parca = () => String(crypto.randomInt(60)).padStart(2, '0');
  const hh = String(crypto.randomInt(24)).padStart(2, '0');
  return m.length > 5 ? `${hh}:${parca()}:${parca()}` : `${hh}:${parca()}`;
}

function maskSegment(seg, ctx) {
  return seg.split(/(\s+)/).map((tok) => (/^\s*$/.test(tok) ? tok : maskToken(tok, ctx))).join('');
}

/**
 * pdftotext -layout çıktısını sentetik olarak maskeler. Satır ve sütun
 * yapısı (boşluklar, uzunluklar) birebir korunur.
 * @returns {{ masked: string, harita: Map<string, string> }} harita: sahte → gerçek
 */
function maskWithMap(text) {
  const ctx = yeniBaglam(text || '');
  if (!text) return { masked: '', harita: ctx.geri };
  const satirlar = text.replace(/\r\n?/g, '\n').split('\n');
  const masked = satirlar.map((satir) => {
    let out = '';
    let son = 0;
    for (const m of satir.matchAll(TARIH_SAAT_RE)) {
      out += maskSegment(satir.slice(son, m.index), ctx);
      out += sahteTarihSaat(...m);
      son = m.index + m[0].length;
    }
    return out + maskSegment(satir.slice(son), ctx);
  }).join('\n');
  return { masked, harita: ctx.geri };
}

/** @returns {string} */
function syntheticMask(text) {
  return maskWithMap(text).masked;
}

/**
 * LLM'in maskeli metne göre yazdığı koddaki sahte kelimeleri (etiketler)
 * gerçek karşılıklarına çevirir. Yalnız tam kelime eşleşmeleri değişir.
 */
function unmaskCode(code, harita) {
  if (!code || !harita || !harita.size) return code;
  const sahteler = [...harita.keys()].sort((a, b) => b.length - a.length);
  let out = code;
  for (const sahte of sahteler) {
    out = out.replace(new RegExp(`(?<![\\p{L}])${sahte}(?![\\p{L}])`, 'gu'), harita.get(sahte));
  }
  return out;
}

/**
 * Orijinal metindeki hassas aday belirteçlerden (sözlük dışı ≥4 harfli
 * kelimeler, ≥5 haneli sayılar, e-postalar) maskeli metinde aynen kalan
 * var mı? Gönderim öncesi son güvenlik denetimi.
 * @returns {string[]} sızan belirteçler
 */
function findLeaks(original, masked) {
  const maskeliKume = new Set(String(masked).split(/[^\p{L}\p{N}@._-]+/u).filter(Boolean));
  const sizan = new Set();
  for (const tok of String(original).split(/[^\p{L}\p{N}@._-]+/u)) {
    if (!tok) continue;
    const kelime = /^\p{L}{4,}$/u.test(tok) && !sozlukte(tok);
    const sayi = /^\d{5,}$/.test(tok);
    const eposta = tok.includes('@');
    if ((kelime || sayi || eposta) && maskeliKume.has(tok)) sizan.add(tok);
  }
  return [...sizan];
}

/**
 * Sızıntısız maskeleme: nadir de olsa rastgele üretim orijinal bir
 * belirteçle çakışırsa yeniden dener; korunması gerekmeyen bir şey
 * kalırsa hata fırlatır (metin LLM'e gönderilmez).
 * @returns {{ masked: string, harita: Map<string, string> }}
 */
function maskForLlm(text) {
  for (let deneme = 0; deneme < 3; deneme++) {
    const sonuc = maskWithMap(text);
    if (findLeaks(text, sonuc.masked).length === 0) return sonuc;
  }
  throw new Error('Maskeleme sonrası kişisel veri sızıntısı tespit edildi; metin LLM\'e gönderilmedi.');
}

module.exports = {
  syntheticMask,
  maskWithMap,
  maskForLlm,
  unmaskCode,
  findLeaks,
  // Geriye dönük uyumluluk: eski ad yeni (sentetik) maskelemeyi kullanır.
  anonymizePdfText: syntheticMask,
  SOZLUK,
};
