'use strict';

// Extractor çıktısının ({ header, items }) alan/tip sözleşmesi. Statik,
// LLM-üretimi (dinamik) ve LLM doğrudan çıkarım sonuçlarının hepsi aynı
// sözleşmeye göre denetlenir; DB'ye yanlış tipte değer (ör. REAL kolona
// "[MONEY_VAL]" metni) yazılması burada engellenir.

const { parseTrNumber, parseTrDate } = require('./normalize');

const HEADER_STRING_FIELDS = [
  'belge_no', 'senaryo', 'fatura_tipi',
  'satici_unvan', 'satici_vkn_tckn', 'satici_vergi_dairesi', 'satici_adres', 'satici_eposta', 'satici_telefon',
  'alici_unvan', 'alici_vkn_tckn', 'alici_vergi_dairesi', 'alici_adres', 'alici_eposta', 'alici_telefon',
  'notlar',
];
const HEADER_NUMBER_FIELDS = [
  'mal_hizmet_toplam_tutari', 'toplam_iskonto', 'kdv_matrahi', 'hesaplanan_kdv_toplam',
  'vergiler_dahil_toplam_tutar', 'odenecek_tutar',
];
const ITEM_STRING_FIELDS = ['aciklama', 'birim'];
const ITEM_NUMBER_FIELDS = [
  'miktar', 'birim_fiyat', 'iskonto_orani', 'iskonto_tutari', 'net_satir_tutari',
  'kdv_orani', 'kdv_tutari', 'mal_hizmet_tutari',
];

// Eski maskeleme biçiminin yer tutucuları ([MONEY_VAL], [VKN_TCKN] ...):
// bir parser bunları değer olarak döndürüyorsa maskeli metne göre "ezber"
// yazılmıştır ve gerçek veriyi okumuyordur.
const PLACEHOLDER_RE = /\[[A-Z][A-Z_]{2,}\]/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Sonucu sözleşmeye göre denetler.
 * @returns {string[]} hata mesajları (boşsa geçerli)
 */
function checkSchema(result) {
  const hatalar = [];
  if (!result || typeof result !== 'object') return ['Sonuç bir nesne değil'];
  const { header, items } = result;
  if (!header || typeof header !== 'object') return ['header alanı yok'];
  if (!Array.isArray(items)) hatalar.push('items bir dizi değil');

  for (const [k, v] of Object.entries(header)) {
    if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) hatalar.push(`header.${k} yer tutucu içeriyor (${v})`);
  }
  for (const f of HEADER_STRING_FIELDS) {
    const v = header[f];
    if (v != null && typeof v !== 'string') hatalar.push(`header.${f} metin olmalı`);
  }
  for (const f of HEADER_NUMBER_FIELDS) {
    const v = header[f];
    if (v != null && !isNum(v)) hatalar.push(`header.${f} sayı olmalı (${JSON.stringify(v)})`);
  }
  if (header.belge_tipi != null && !['FATURA', 'IRSALIYE'].includes(header.belge_tipi)) {
    hatalar.push(`header.belge_tipi geçersiz (${header.belge_tipi})`);
  }
  if (header.duzenleme_tarihi != null && !ISO_DATE_RE.test(header.duzenleme_tarihi)) {
    hatalar.push(`header.duzenleme_tarihi YYYY-AA-GG olmalı (${header.duzenleme_tarihi})`);
  }
  if (header.duzenleme_zamani != null && !TIME_RE.test(header.duzenleme_zamani)) {
    hatalar.push(`header.duzenleme_zamani SS:DD[:ss] olmalı (${header.duzenleme_zamani})`);
  }
  if (header.ettn != null && !UUID_RE.test(header.ettn)) {
    hatalar.push(`header.ettn UUID olmalı (${header.ettn})`);
  }

  (Array.isArray(items) ? items : []).forEach((it, i) => {
    if (!it || typeof it !== 'object') {
      hatalar.push(`items[${i}] nesne değil`);
      return;
    }
    for (const [k, v] of Object.entries(it)) {
      if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) hatalar.push(`items[${i}].${k} yer tutucu içeriyor`);
    }
    for (const f of ITEM_STRING_FIELDS) {
      if (it[f] != null && typeof it[f] !== 'string') hatalar.push(`items[${i}].${f} metin olmalı`);
    }
    for (const f of ITEM_NUMBER_FIELDS) {
      if (it[f] != null && !isNum(it[f])) hatalar.push(`items[${i}].${f} sayı olmalı (${JSON.stringify(it[f])})`);
    }
  });

  return hatalar;
}

/**
 * LLM kaynaklı sonuçları sözleşmeye yaklaştırır: sayısal alanlardaki
 * "1.234,50" gibi metinleri sayıya, "30.06.2026" gibi tarihleri ISO'ya
 * çevirir, boş metinleri null yapar. Statik extractor çıktısı zaten
 * uygundur; bu işlem onu değiştirmez.
 */
function coerceResult(result) {
  if (!result || typeof result !== 'object' || !result.header) return result;
  const header = { ...result.header };
  for (const f of HEADER_NUMBER_FIELDS) {
    if (typeof header[f] === 'string') header[f] = parseTrNumber(header[f]);
  }
  for (const f of HEADER_STRING_FIELDS) {
    if (typeof header[f] === 'number') header[f] = String(header[f]);
    if (typeof header[f] === 'string' && !header[f].trim()) header[f] = null;
  }
  if (typeof header.duzenleme_tarihi === 'string' && !ISO_DATE_RE.test(header.duzenleme_tarihi)) {
    header.duzenleme_tarihi = parseTrDate(header.duzenleme_tarihi) ?? header.duzenleme_tarihi;
  }
  if (typeof header.belge_tipi === 'string') header.belge_tipi = header.belge_tipi.toUpperCase();
  if (!header.belge_tipi) header.belge_tipi = 'FATURA';

  const items = (Array.isArray(result.items) ? result.items : []).map((it, i) => {
    const out = { ...it };
    for (const f of ITEM_NUMBER_FIELDS) {
      if (typeof out[f] === 'string') out[f] = f === 'kdv_orani' || f === 'iskonto_orani'
        ? parseTrNumber(out[f].replace('%', ''))
        : parseTrNumber(out[f]);
    }
    if (typeof out.sira_no === 'string') out.sira_no = parseInt(out.sira_no, 10) || i + 1;
    if (out.sira_no == null) out.sira_no = i + 1;
    return out;
  });

  return { ...result, header, items };
}

/** LLM doğrudan çıkarımında `response_format: json_schema` için şema. */
const RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['header', 'items'],
  properties: {
    header: {
      type: 'object',
      additionalProperties: false,
      required: ['belge_tipi', 'duzenleme_tarihi', 'duzenleme_zamani', 'ettn', ...HEADER_STRING_FIELDS, ...HEADER_NUMBER_FIELDS],
      properties: {
        belge_tipi: { type: 'string', enum: ['FATURA', 'IRSALIYE'] },
        duzenleme_tarihi: { type: ['string', 'null'], description: 'YYYY-AA-GG' },
        duzenleme_zamani: { type: ['string', 'null'], description: 'SS:DD veya SS:DD:ss' },
        ettn: { type: ['string', 'null'], description: 'UUID' },
        ...Object.fromEntries(HEADER_STRING_FIELDS.map((f) => [f, { type: ['string', 'null'] }])),
        ...Object.fromEntries(HEADER_NUMBER_FIELDS.map((f) => [f, { type: ['number', 'null'] }])),
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sira_no', ...ITEM_STRING_FIELDS, ...ITEM_NUMBER_FIELDS],
        properties: {
          sira_no: { type: 'integer' },
          ...Object.fromEntries(ITEM_STRING_FIELDS.map((f) => [f, { type: ['string', 'null'] }])),
          ...Object.fromEntries(ITEM_NUMBER_FIELDS.map((f) => [f, { type: ['number', 'null'] }])),
        },
      },
    },
  },
};

module.exports = {
  checkSchema,
  coerceResult,
  RESULT_JSON_SCHEMA,
  HEADER_STRING_FIELDS,
  HEADER_NUMBER_FIELDS,
  ITEM_STRING_FIELDS,
  ITEM_NUMBER_FIELDS,
  PLACEHOLDER_RE,
};
