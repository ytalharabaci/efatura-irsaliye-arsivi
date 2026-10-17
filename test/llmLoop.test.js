'use strict';

// LLM entegrasyonu uçtan uca (ağ yerine sahte fetch ile): maskeli metinden
// kod üretimi → yerel doğrulama → PII'siz geri bildirim → düzeltme →
// kayıt → aynı şablonda LLM'siz yeniden kullanım.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.EXTRACTORS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'efatura-llm-'));
delete process.env.LLM_DIRECT_EXTRACT;

const { generateValidatedParser } = require('../src/ingest/llmParserGenerator');
const { extractSegment } = require('../src/ingest/ingestCore');
const { directExtract } = require('../src/ingest/llmDirectExtract');
const { listExtractors, unregisterDynamicExtractor } = require('../src/ingest/extractors/index');

// gibStandardInvoice'ın tanımadığı (e-Fatura başlığı olmayan) bir şablon
const OZEL = [
  'OZEL ENTEGRATOR BELGESI',
  'Satici Firma: Zeynep Kaya Elektrik',
  'VKN: 1234567890',
  'Belge Numarasi: ZKE2026000000123',
  'Evrak Tarihi: 05.03.2026',
  'ETTN: 0f8fad5b-d9cb-469f-a165-70867728950e',
  '1 | Kablo Makarasi | 2 | 500,00 | 1.000,00 | %20 | 200,00',
  'Toplam Mal Hizmet: 1.000,00 TL',
  'KDV Toplami: 200,00 TL',
  'Odenecek: 1.200,00 TL',
  '',
].join('\n');

function reEsc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// LLM'in maskeli metinde gördüğü (sahte) etiketlerle yazdığı kod: etiketleri
// maskeli istemin ilgili satırlarından okuyup regex'e yerleştirir — gerçek
// bir LLM'in yapacağı gibi.
function dogruKod(masked) {
  const satirlar = masked.split('\n');
  const etiket = (i) => reEsc(satirlar[i].slice(0, satirlar[i].indexOf(':')));
  const tanima = reEsc(satirlar[0].trim());
  const kod = `
module.exports = { extract(text) {
  text = text.replace(/\\r\\n?/g, '\\n');
  if (!/^${tanima}/.test(text)) return null;
  const m = (re) => { const x = text.match(re); return x ? x[1].trim() : null; };
  const items = [];
  for (const l of text.split('\\n')) {
    const r = l.match(/^(\\d+) \\| (.+?) \\| ([\\d.,]+) \\| ([\\d.,]+) \\| ([\\d.,]+) \\| %(\\d+) \\| ([\\d.,]+)$/);
    if (r) items.push({ sira_no: +r[1], aciklama: r[2], miktar: normalize.parseTrNumber(r[3]),
      birim_fiyat: normalize.parseTrNumber(r[4]), mal_hizmet_tutari: normalize.parseTrNumber(r[5]),
      kdv_orani: +r[6], kdv_tutari: normalize.parseTrNumber(r[7]) });
  }
  const odenecek = normalize.parseTrNumber(m(/${etiket(9)}:\\s*([\\d.,]+)/));
  return { header: {
    belge_tipi: 'FATURA',
    belge_no: m(/${etiket(3)}:\\s*(\\S+)/),
    ettn: m(/ETTN:\\s*(\\S+)/),
    duzenleme_tarihi: normalize.parseTrDate(m(/${etiket(4)}:\\s*(\\S+)/)),
    satici_unvan: m(/${etiket(1)}:\\s*(.+)/),
    satici_vkn_tckn: m(/VKN:\\s*(\\d+)/),
    mal_hizmet_toplam_tutari: normalize.parseTrNumber(m(/${etiket(7)}:\\s*([\\d.,]+)/)),
    hesaplanan_kdv_toplam: normalize.parseTrNumber(m(/${etiket(8)}:\\s*([\\d.,]+)/)),
    vergiler_dahil_toplam_tutar: odenecek,
    odenecek_tutar: odenecek,
  }, items };
} };`;
  return '```js\n' + kod + '\n```';
}

// Eski hata modu: yer tutucu döndüren, kalem bulamayan kod
const KOTU_KOD = "```js\nmodule.exports = { extract(text) { return { header: { belge_no: '[BELGE_NO]' }, items: [] }; } };\n```";

function sahteFetch(yanitlar) {
  const istekler = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    istekler.push(body);
    const masked = body.messages[1].content.split('\n\n').slice(1).join('\n\n');
    const sira = istekler.length - 1;
    const icerik = typeof yanitlar[sira] === 'function' ? yanitlar[sira](masked) : yanitlar[sira];
    return { ok: true, json: async () => ({ choices: [{ message: { content: icerik } }] }) };
  };
  fn.istekler = istekler;
  return fn;
}

const OPTS = { provider: 'openai', apiKey: 'test-anahtar', maxAttempts: 3 };
const GIZLI = ['Zeynep', 'Kaya', 'ZKE2026000000123', '1234567890', '0f8fad5b', '1.000,00', '1.200,00', 'Kablo', 'Makarasi'];

test('generateValidatedParser: kötü ilk denemeden sonra PII\'siz geri bildirimle düzelir', async () => {
  const eski = global.fetch;
  global.fetch = sahteFetch([KOTU_KOD, dogruKod]);
  try {
    const gen = await generateValidatedParser({ text: OZEL, options: OPTS, log: () => {} });
    assert.equal(gen.success, true, gen.error);
    assert.equal(gen.attempts, 2);
    assert.equal(gen.result.header.belge_no, 'ZKE2026000000123');
    assert.equal(gen.result.items.length, 1);
    assert.ok(gen.code.includes('Belge Numarasi'), 'kaydedilecek kod gerçek etiketleri içermeli');

    // LLM'e giden HER kullanıcı mesajı (maskeli metin + geri bildirim) gerçek veri içermemeli
    for (const istek of global.fetch.istekler) {
      for (const msg of istek.messages.filter((x) => x.role === 'user')) {
        for (const g of GIZLI) assert.ok(!msg.content.includes(g), `LLM'e "${g}" gönderilmemeli`);
      }
    }
    const geriBildirim = global.fetch.istekler[1].messages.at(-1).content;
    assert.match(geriBildirim, /Tip\/şema hataları|Hiç kalem/);
  } finally {
    global.fetch = eski;
  }
});

test('generateValidatedParser: eşik aşılamazsa başarısız döner', async () => {
  const eski = global.fetch;
  global.fetch = sahteFetch([KOTU_KOD, KOTU_KOD, KOTU_KOD]);
  try {
    const gen = await generateValidatedParser({ text: OZEL, options: OPTS, log: () => {} });
    assert.equal(gen.success, false);
    assert.equal(global.fetch.istekler.length, 3);
  } finally {
    global.fetch = eski;
  }
});

test('extractSegment: tanınmayan şablonda parser üretir, kaydeder ve sonra LLM\'siz kullanır', async () => {
  const eski = global.fetch;
  global.fetch = sahteFetch([dogruKod]);
  try {
    const ilk = await extractSegment(OZEL, { options: OPTS, log: () => {} });
    assert.ok(ilk, 'sonuç dönmeli');
    assert.equal(ilk.type, 'dynamic');
    assert.equal(ilk.validation.durum, 'BASARILI');
    assert.equal(global.fetch.istekler.length, 1);
    const kayitli = listExtractors().find((e) => e.name === ilk.name);
    assert.ok(kayitli && kayitli.meta.fingerprint, 'parmak iziyle kaydedilmeli');

    // Aynı şablonda başka bir belge: LLM'e gidilmeden kayıtlı parser kullanılır
    const ikinciMetin = OZEL.replace('ZKE2026000000123', 'ZKE2026000000999').replace('Kablo Makarasi', 'Priz Seti');
    const ikinci = await extractSegment(ikinciMetin, { options: OPTS, log: () => {} });
    assert.equal(ikinci.name, ilk.name);
    assert.equal(ikinci.result.header.belge_no, 'ZKE2026000000999');
    assert.equal(ikinci.result.items[0].aciklama, 'Priz Seti');
    assert.equal(global.fetch.istekler.length, 1, 'ikinci belgede LLM çağrılmamalı');
    unregisterDynamicExtractor(ilk.name);
  } finally {
    global.fetch = eski;
  }
});

test('extractSegment: LLM kapalıyken statik sonuç döner, ağ çağrısı yapılmaz', async () => {
  const eski = global.fetch;
  global.fetch = sahteFetch([]);
  try {
    const metin = fs.readFileSync(path.join(__dirname, 'fixtures', 'gib_standard_invoice_sample.txt'), 'utf8');
    const r = await extractSegment(metin, { options: { autoGenerateParser: false }, log: () => {} });
    assert.equal(r.name, 'gibStandardInvoice');
    assert.equal(global.fetch.istekler.length, 0);
  } finally {
    global.fetch = eski;
  }
});

test('directExtract: bulut uç noktasına maskesiz metin göndermeyi reddeder', async () => {
  const eski = global.fetch;
  global.fetch = sahteFetch([]);
  try {
    const r = await directExtract(OZEL, { options: { provider: 'openai', apiKey: 'x' } });
    assert.equal(r.success, false);
    assert.match(r.error, /yerel/);
    assert.equal(global.fetch.istekler.length, 0);
  } finally {
    global.fetch = eski;
  }
});

test('directExtract: yerel uç noktada JSON yanıtı tipe zorlanıp doğrulanır', async () => {
  const eski = global.fetch;
  const json = JSON.stringify({
    header: { belge_no: 'ZKE2026000000123', duzenleme_tarihi: '05.03.2026', mal_hizmet_toplam_tutari: '1.000,00', hesaplanan_kdv_toplam: 200 },
    items: [{ sira_no: 1, aciklama: 'Kablo', mal_hizmet_tutari: 1000, kdv_tutari: 200 }],
  });
  global.fetch = sahteFetch([json]);
  try {
    const r = await directExtract(OZEL, { options: { provider: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' } });
    assert.equal(r.success, true, r.error);
    assert.equal(r.result.header.duzenleme_tarihi, '2026-03-05');
    assert.equal(r.result.header.mal_hizmet_toplam_tutari, 1000);
    assert.equal(r.validation.durum, 'BASARILI');
  } finally {
    global.fetch = eski;
  }
});
