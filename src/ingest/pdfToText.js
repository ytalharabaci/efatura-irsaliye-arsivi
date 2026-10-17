'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const execFileAsync = promisify(execFile);

/**
 * Bir poppler aracının (pdftotext, pdftoppm, pdfdetach) yolunu çözer.
 * Windows'ta C:\poppler altındaki aday yolları denetler (MiKTeX sürümü
 * -layout desteklemez). PDFTOTEXT_PATH ayarlıysa diğer araçlar da aynı
 * dizinde aranır.
 */
function resolvePopplerBin(tool = 'pdftotext') {
  const ozel = process.env.PDFTOTEXT_PATH;
  if (ozel && fs.existsSync(ozel)) {
    if (tool === 'pdftotext') return ozel;
    const kardes = path.join(path.dirname(ozel), tool + path.extname(ozel));
    if (fs.existsSync(kardes)) return kardes;
  }
  if (process.platform === 'win32') {
    const candidates = [
      `C:\\poppler\\${tool}.exe`,
      `C:\\poppler\\Library\\bin\\${tool}.exe`,
      `C:\\poppler\\bin\\${tool}.exe`,
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) return cand;
    }
  }
  return tool === 'pdftotext' && ozel ? ozel : tool;
}

function resolvePdftotextBin() {
  return resolvePopplerBin('pdftotext');
}

// xpdf'in pdftotext'i -layout modunda sütunları satırlardan bağımsız bloklar
// halinde dizebilir (tutar sütunu kalem satırlarından kopar); extractor'lar
// poppler çıktısına göre yazıldığından bir kez uyarılır.
let surumDenetlendi = false;
async function warnIfXpdf(bin) {
  if (surumDenetlendi) return;
  surumDenetlendi = true;
  let cikti;
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['-v'], { encoding: 'utf8', timeout: 5000 });
    cikti = `${stdout}${stderr}`;
  } catch (err) {
    // xpdf -v sıfırdan farklı kodla çıkar; sürüm metni yine err.stdout/stderr'dedir.
    cikti = `${err.stdout || ''}${err.stderr || ''}`;
  }
  if (/xpdf/i.test(cikti) && !/poppler/i.test(cikti)) {
    console.warn(`[pdfToText] UYARI: ${bin} xpdf sürümü; tablo düzeni bozulabilir. Poppler kurun (C:\\poppler) veya PDFTOTEXT_PATH ayarlayın.`);
  }
}

async function runPdftotext(pdfPath, modeArgs) {
  const bin = resolvePdftotextBin();
  await warnIfXpdf(bin);
  try {
    // -enc UTF-8: xpdf'in pdftotext'i (ör. Git for Windows ile gelen) varsayılan
    // olarak Latin-1 üretir; Türkçe karakterler (ş, ğ, ı, İ) kaybolur.
    const { stdout } = await execFileAsync(bin, [...modeArgs, '-enc', 'UTF-8', pdfPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    // Windows'taki pdftotext.exe CRLF üretir; extractor regex'leri LF varsayıyor.
    return stdout.replace(/\r\n/g, '\n');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'pdftotext bulunamadı. Lütfen poppler-utils kurun: ' +
        'Windows: C:\\poppler\\pdftotext.exe konumuna yerleştirin veya PDFTOTEXT_PATH env değişkenini ayarlayın. ' +
        'Ubuntu/Debian: apt install poppler-utils'
      );
    }
    throw new Error(`pdftotext hatası (${path.basename(pdfPath)}): ${err.message}`);
  }
}

/**
 * pdftotext -layout ile PDF'ten metin çıkarır (sütun düzeni korunur;
 * extractor'ların beklediği biçim budur).
 * @param {string} pdfPath - PDF dosyasının tam yolu
 * @returns {Promise<string>} - Çıkarılan ham metin
 */
async function pdfToText(pdfPath) {
  return runPdftotext(pdfPath, ['-layout']);
}

/**
 * pdftotext -raw ile PDF'ten metin çıkarır. Sütun düzeni kaybolur ama
 * kelimeler bütündür: -layout modunun sabit karakter ızgarası, geniş harf
 * aralıklı (kerning) fontlarda kelime içine boşluk sokar ("HO RTUM");
 * -raw çıktısı bu bozulmayı onarmak için referans olarak kullanılır.
 */
async function pdfToTextRaw(pdfPath) {
  return runPdftotext(pdfPath, ['-raw']);
}

module.exports = { pdfToText, pdfToTextRaw, resolvePopplerBin };
