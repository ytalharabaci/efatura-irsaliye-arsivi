#!/usr/bin/env node
'use strict';

// Ayrıştırma doğruluğu ölçümü: test/fixtures altındaki her `<ad>_sample.txt`
// metnini üretim hattından (belge bölme → extractSegment) geçirir ve
// `<ad>_expected.json` ile ALAN BAZINDA karşılaştırır.
//
//   npm run eval                 → rapor
//   npm run eval -- --verbose    → hatalı alanların listesi
//   npm run eval -- --json       → makine okunur çıktı
//   npm run eval -- --snapshot   → expected dosyası olmayan fixture'lar için
//                                   mevcut çıktıyı expected olarak yazar
//                                   (gözden geçirip düzelttikten sonra commit edin)
//
// Expected biçimi: { header, items } (tek belge) veya { documents: [{ header, items }, ...] }.
// Yalnız expected'da bulunan alanlar karşılaştırılır.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures');

function fixturePairs(dir = FIXTURE_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('_sample.txt'))
    .map((f) => {
      const ad = f.replace(/_sample\.txt$/, '');
      return { ad, metin: path.join(dir, f), beklenen: path.join(dir, `${ad}_expected.json`) };
    });
}

function esit(a, b) {
  if (typeof b === 'number' && typeof a === 'number') return Math.abs(a - b) < 0.005;
  if (typeof b === 'string' && typeof a === 'string') return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
  return (a ?? null) === (b ?? null);
}

function karsilastir(gercek, beklenen, onEk, sonuc) {
  for (const [alan, b] of Object.entries(beklenen)) {
    sonuc.toplam++;
    const g = gercek ? gercek[alan] : undefined;
    if (esit(g, b)) sonuc.dogru++;
    else sonuc.hatalar.push({ alan: `${onEk}${alan}`, beklenen: b, gercek: g ?? null });
  }
}

/**
 * @param {{ dir?: string, withDynamic?: boolean }} [opts]
 * @returns {Promise<{ fixtures: object[], dogru: number, toplam: number, oran: number }>}
 */
async function evaluate(opts = {}) {
  // Kurulumun LLM üretimi parser'ları ölçümü etkilemesin (varsayılan).
  if (!opts.withDynamic && !process.env.EXTRACTORS_DIR) {
    process.env.EXTRACTORS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'efatura-eval-'));
  }
  const { splitIntoDocuments } = require('../src/ingest/splitDocuments');
  const { extractSegment } = require('../src/ingest/ingestCore');

  const fixtures = [];
  for (const fx of fixturePairs(opts.dir)) {
    if (!fs.existsSync(fx.beklenen)) continue;
    const beklenen = JSON.parse(fs.readFileSync(fx.beklenen, 'utf8'));
    const belgeler = beklenen.documents || [beklenen];
    const segmentler = splitIntoDocuments(fs.readFileSync(fx.metin, 'utf8'));
    const sonuc = { ad: fx.ad, dogru: 0, toplam: 0, hatalar: [], belgeSayisi: segmentler.length };

    sonuc.toplam++;
    if (segmentler.length === belgeler.length) sonuc.dogru++;
    else sonuc.hatalar.push({ alan: 'belge_sayisi', beklenen: belgeler.length, gercek: segmentler.length });

    for (let i = 0; i < belgeler.length; i++) {
      const exp = belgeler[i];
      const aday = segmentler[i]
        ? await extractSegment(segmentler[i], { options: { autoGenerateParser: false }, log: () => {} })
        : null;
      const onEk = belgeler.length > 1 ? `[${i + 1}].` : '';
      const header = aday ? aday.result.header : null;
      const items = aday ? aday.result.items : [];
      karsilastir(header, exp.header || {}, `${onEk}header.`, sonuc);
      if (Array.isArray(exp.items)) {
        sonuc.toplam++;
        if (items.length === exp.items.length) sonuc.dogru++;
        else sonuc.hatalar.push({ alan: `${onEk}kalem_sayisi`, beklenen: exp.items.length, gercek: items.length });
        exp.items.forEach((it, k) => karsilastir(items[k], it, `${onEk}items[${k}].`, sonuc));
      }
    }
    sonuc.oran = sonuc.toplam ? sonuc.dogru / sonuc.toplam : 1;
    fixtures.push(sonuc);
  }

  const dogru = fixtures.reduce((s, f) => s + f.dogru, 0);
  const toplam = fixtures.reduce((s, f) => s + f.toplam, 0);
  return { fixtures, dogru, toplam, oran: toplam ? dogru / toplam : 1 };
}

const SNAPSHOT_ALANLARI = (r) => {
  const { confidence, ...rest } = r; // eslint-disable-line no-unused-vars
  return { header: rest.header, items: rest.items };
};

async function snapshot() {
  const { splitIntoDocuments } = require('../src/ingest/splitDocuments');
  const { extractSegment } = require('../src/ingest/ingestCore');
  for (const fx of fixturePairs()) {
    if (fs.existsSync(fx.beklenen)) continue;
    const belgeler = [];
    for (const seg of splitIntoDocuments(fs.readFileSync(fx.metin, 'utf8'))) {
      const aday = await extractSegment(seg, { options: { autoGenerateParser: false }, log: () => {} });
      belgeler.push(aday ? SNAPSHOT_ALANLARI(aday.result) : { header: {}, items: [] });
    }
    const icerik = belgeler.length === 1 ? belgeler[0] : { documents: belgeler };
    fs.writeFileSync(fx.beklenen, `${JSON.stringify(icerik, null, 2)}\n`, 'utf8');
    console.log(`yazıldı: ${path.relative(process.cwd(), fx.beklenen)} — gözden geçirin`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--snapshot')) return snapshot();

  const rapor = await evaluate({ withDynamic: args.includes('--with-dynamic') });
  if (args.includes('--json')) {
    console.log(JSON.stringify(rapor, null, 2));
    return;
  }
  const yuzde = (x) => `${(x * 100).toFixed(1)}%`;
  for (const f of rapor.fixtures) {
    console.log(`${f.oran === 1 ? '✓' : '✗'} ${f.ad.padEnd(36)} ${String(f.dogru).padStart(4)}/${String(f.toplam).padEnd(4)} ${yuzde(f.oran)}  (${f.belgeSayisi} belge)`);
    if (args.includes('--verbose')) {
      for (const h of f.hatalar) {
        console.log(`    ${h.alan}: beklenen ${JSON.stringify(h.beklenen)}, bulunan ${JSON.stringify(h.gercek)}`);
      }
    }
  }
  console.log(`\nToplam alan doğruluğu: ${rapor.dogru}/${rapor.toplam} = ${yuzde(rapor.oran)}`);
  if (!args.includes('--verbose') && rapor.oran < 1) console.log('Ayrıntı için: npm run eval -- --verbose');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { evaluate, fixturePairs };
