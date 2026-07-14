'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const execFileAsync = promisify(execFile);

// Windows'ta C:\poppler\pdftotext.exe varsa onu kullan (MiKTeX sürümü -layout desteklemez)
function resolvePdftotextBin() {
  if (process.env.PDFTOTEXT_PATH) return process.env.PDFTOTEXT_PATH;
  const windowsFallback = 'C:\\poppler\\pdftotext.exe';
  if (process.platform === 'win32' && fs.existsSync(windowsFallback)) return windowsFallback;
  return 'pdftotext';
}

const PDFTOTEXT_BIN = resolvePdftotextBin();

async function runPdftotext(pdfPath, modeArgs) {
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT_BIN, [...modeArgs, pdfPath, '-'], {
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

module.exports = { pdfToText, pdfToTextRaw };
