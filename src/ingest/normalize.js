'use strict';

const CURRENCY_SUFFIX_RE = /(?:TL|TRY|USD|EUR|GBP|₺|\$|€)$/i;

/**
 * Türkçe sayı formatını (15.000,00) JS float'a çevirir.
 * Binlik ayraç: nokta, ondalık ayraç: virgül. Virgül yoksa noktanın rolü
 * basamak düzeninden çıkarılır: "15.000" / "1.250.000" binlik ayraçtır,
 * "85.5" / "0.21" gibi 3 basamaklı grup oluşturmayan nokta ondalıktır.
 */
function parseTrNumber(str) {
  if (str == null) return null;
  let cleaned = String(str)
    .trim()
    .replace(/\s/g, '')
    .replace(CURRENCY_SUFFIX_RE, '');

  if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes('.') && !/^-?\d{1,3}(?:\.\d{3})+$/.test(cleaned)) {
    // Ondalık nokta: olduğu gibi bırak
  } else {
    cleaned = cleaned.replace(/\./g, '');
  }

  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Türkçe KDV oranı string'ini (örn. "%20,00" veya "20,00") yüzde sayısına çevirir.
 * Dönen değer: 20 (yüzde olarak, 0.20 değil)
 */
function parseTrPercent(str) {
  if (str == null) return null;
  const cleaned = String(str).trim().replace('%', '').trim();
  return parseTrNumber(cleaned);
}

/**
 * GG-AA-YYYY / GG.AA.YYYY / GG/AA/YYYY (ayraç çevresinde boşluk olabilir)
 * tarihini ISO 8601 (YYYY-MM-DD) formatına çevirir. Takvimde olmayan tarih
 * (31-02-2026) null döner.
 */
function parseTrDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})$/);
  if (!m) return null;
  const gun = Number(m[1]);
  const ay = Number(m[2]);
  const yil = Number(m[3]);
  const d = new Date(Date.UTC(yil, ay - 1, gun));
  if (d.getUTCFullYear() !== yil || d.getUTCMonth() !== ay - 1 || d.getUTCDate() !== gun) return null;
  return `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}`;
}

/** GİB 10 haneli vergi kimlik numarası kontrol basamağı doğrulaması. */
function isValidVkn(vkn) {
  const s = String(vkn ?? '');
  if (!/^\d{10}$/.test(s)) return false;
  let toplam = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (Number(s[i]) + 9 - i) % 10;
    let deger = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && deger === 0) deger = 9;
    toplam += deger;
  }
  return (10 - (toplam % 10)) % 10 === Number(s[9]);
}

/** 11 haneli T.C. kimlik numarası kontrol basamakları doğrulaması. */
function isValidTckn(tckn) {
  const s = String(tckn ?? '');
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const tek = d[0] + d[2] + d[4] + d[6] + d[8];
  const cift = d[1] + d[3] + d[5] + d[7];
  if ((((tek * 7 - cift) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

/** VKN (10 hane) veya TCKN (11 hane) olarak geçerli mi? */
function isValidVknTckn(value) {
  const s = String(value ?? '');
  return s.length === 10 ? isValidVkn(s) : isValidTckn(s);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value ?? ''));
}

module.exports = {
  parseTrNumber,
  parseTrPercent,
  parseTrDate,
  isValidVkn,
  isValidTckn,
  isValidVknTckn,
  isUuid,
};
