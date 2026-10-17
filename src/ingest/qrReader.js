'use strict';

// GİB e-Fatura / e-Arşiv görsellerindeki karekod, belgenin özet alanlarını
// JSON olarak taşır (vkntckn, avkntckn, senaryo, tip, tarih, no, ettn,
// parabirimi, malhizmettoplam, kdvmatrah(20), hesaplanankdv(20), vergidahil,
// odenecek). Bu değerler PDF metninden bağımsız, makine tarafından üretilmiş
// "ground truth"tur: extractor'ın başlık alanları bunlarla doğrulanır.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolvePopplerBin } = require('./pdfToText');
const { parseTrNumber, parseTrDate } = require('./normalize');

const execFileAsync = promisify(execFile);

let jsQR = null;
let PNG = null;
try {
  jsQR = require('jsqr');
  ({ PNG } = require('pngjs'));
} catch { /* bağımlılık yoksa QR okuma devre dışı */ }

function qrEnabled() {
  return Boolean(jsQR && PNG) && process.env.QR_DISABLED !== 'true';
}

/** QR içindeki sayı: "15000.00" (nokta ondalık) veya "15.000,00" (TR). */
function qrNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  return parseTrNumber(s);
}

function qrDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return parseTrDate(s);
}

/**
 * QR metnini JSON olarak çözer; GİB fatura karekodu değilse null.
 * Bazı entegratörler anahtarları büyük harfle ya da boşluklu yazar.
 */
function parseQrPayload(text) {
  if (!text) return null;
  let obj;
  try {
    obj = JSON.parse(String(text).trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const n = {};
  for (const [k, v] of Object.entries(obj)) n[k.toLowerCase().replace(/\s+/g, '')] = v;
  if (!n.ettn && !n.no) return null;
  return n;
}

/**
 * Çözülmüş QR nesnesini extractor başlık alanlarına çevirir. Birden çok
 * KDV oranı varsa "kdvmatrah(X)" / "hesaplanankdv(X)" anahtarları toplanır.
 */
function qrToHeader(qr) {
  if (!qr) return null;
  let matrah = null;
  let kdv = null;
  for (const [k, v] of Object.entries(qr)) {
    if (/^kdvmatrah/.test(k)) matrah = (matrah ?? 0) + (qrNumber(v) ?? 0);
    if (/^hesaplanankdv/.test(k)) kdv = (kdv ?? 0) + (qrNumber(v) ?? 0);
  }
  const yuvarla = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const header = {
    satici_vkn_tckn: qr.vkntckn ? String(qr.vkntckn) : null,
    alici_vkn_tckn: qr.avkntckn ? String(qr.avkntckn) : null,
    senaryo: qr.senaryo ? String(qr.senaryo) : null,
    fatura_tipi: qr.tip ? String(qr.tip) : null,
    duzenleme_tarihi: qrDate(qr.tarih),
    belge_no: qr.no ? String(qr.no) : null,
    ettn: qr.ettn ? String(qr.ettn).toLowerCase() : null,
    mal_hizmet_toplam_tutari: qrNumber(qr.malhizmettoplam),
    kdv_matrahi: yuvarla(matrah),
    hesaplanan_kdv_toplam: yuvarla(kdv),
    vergiler_dahil_toplam_tutar: qrNumber(qr.vergidahil),
    odenecek_tutar: qrNumber(qr.odenecek),
  };
  return { header, paraBirimi: qr.parabirimi ? String(qr.parabirimi) : null };
}

function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  const code = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height, {
    inversionAttempts: 'dontInvert',
  });
  return code ? code.data : null;
}

/**
 * PDF'in ilk `maxPages` sayfasını görüntüye çevirip GİB karekodlarını okur.
 * Çok faturalı PDF'lerde her faturanın kendi karekodu vardır.
 * @returns {Promise<Array<{ sayfa: number, header: object, paraBirimi: string|null }>>}
 */
async function readPdfQrs(pdfPath, { maxPages = 20, dpi = 150 } = {}) {
  if (!qrEnabled()) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efatura-qr-'));
  try {
    await execFileAsync(resolvePopplerBin('pdftoppm'), [
      '-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), pdfPath, path.join(dir, 'p'),
    ], { maxBuffer: 1024 * 1024, timeout: 60000 });

    const sonuclar = [];
    const gorulen = new Set();
    const dosyalar = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    for (const f of dosyalar) {
      let data = null;
      try {
        data = decodePng(fs.readFileSync(path.join(dir, f)));
      } catch { /* bozuk görüntü — atla */ }
      const qr = parseQrPayload(data);
      if (!qr) continue;
      const mapped = qrToHeader(qr);
      const anahtar = mapped.header.ettn || mapped.header.belge_no;
      if (gorulen.has(anahtar)) continue;
      gorulen.add(anahtar);
      sonuclar.push({ sayfa: Number((f.match(/(\d+)\.png$/) || [])[1]) || null, ...mapped });
    }
    return sonuclar;
  } catch {
    // pdftoppm yok / çalışmadı: QR opsiyonel bir doğrulama kaynağıdır.
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Segment metnine ait karekodu ETTN veya belge no ile eşleştirir. */
function findQrForSegment(qrs, segmentText, tekSegment) {
  if (!qrs || !qrs.length) return null;
  const metin = String(segmentText || '').toLowerCase();
  const eslesen = qrs.find((q) => (q.header.ettn && metin.includes(q.header.ettn))
    || (q.header.belge_no && metin.includes(q.header.belge_no.toLowerCase())));
  if (eslesen) return eslesen;
  return tekSegment && qrs.length === 1 ? qrs[0] : null;
}

const SAYISAL = new Set([
  'mal_hizmet_toplam_tutari', 'kdv_matrahi', 'hesaplanan_kdv_toplam', 'vergiler_dahil_toplam_tutar', 'odenecek_tutar',
]);

/**
 * Karekod değerlerini extractor başlığına uygular: boş alanları doldurur,
 * çelişen alanlarda karekodu esas alır. Değişiklikler not olarak döner.
 * @returns {{ header: object, notlar: string[] }}
 */
function mergeQrIntoHeader(header, qrHeader) {
  const out = { ...header };
  const notlar = [];
  if (!qrHeader) return { header: out, notlar };
  for (const [alan, qrDeger] of Object.entries(qrHeader)) {
    if (qrDeger == null || qrDeger === '') continue;
    const mevcut = out[alan];
    if (mevcut == null || mevcut === '') {
      out[alan] = qrDeger;
      notlar.push(`QR: ${alan} dolduruldu`);
      continue;
    }
    const farkli = SAYISAL.has(alan)
      ? Math.abs(Number(mevcut) - Number(qrDeger)) > 0.01
      : String(mevcut).toLowerCase() !== String(qrDeger).toLowerCase();
    if (farkli) {
      out[alan] = qrDeger;
      notlar.push(`QR: ${alan} düzeltildi (${mevcut} → ${qrDeger})`);
    }
  }
  return { header: out, notlar };
}

module.exports = {
  qrEnabled,
  parseQrPayload,
  qrToHeader,
  readPdfQrs,
  findQrForSegment,
  mergeQrIntoHeader,
};
