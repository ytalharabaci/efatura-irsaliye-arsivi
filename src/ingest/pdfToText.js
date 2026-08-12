'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const execFileAsync = promisify(execFile);

// Windows'ta C:\poppler altındaki aday yolları denetle (MiKTeX sürümü -layout desteklemez)
function resolvePdftotextBin() {
  if (process.env.PDFTOTEXT_PATH && fs.existsSync(process.env.PDFTOTEXT_PATH)) {
    return process.env.PDFTOTEXT_PATH;
  }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\poppler\\pdftotext.exe',
      'C:\\poppler\\Library\\bin\\pdftotext.exe',
      'C:\\poppler\\bin\\pdftotext.exe',
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) return cand;
    }
  }
  return process.env.PDFTOTEXT_PATH || 'pdftotext';
}

async function runPdftotext(pdfPath, modeArgs) {
  const bin = resolvePdftotextBin();
  try {
    const { stdout } = await execFileAsync(bin, [...modeArgs, pdfPath, '-'], {
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
