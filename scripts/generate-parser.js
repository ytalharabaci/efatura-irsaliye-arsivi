'use strict';

const path = require('node:path');
const { pdfToText, pdfToTextRaw } = require('../src/ingest/pdfToText');
const { splitIntoDocuments } = require('../src/ingest/splitDocuments');
const { maskForLlm } = require('../src/ingest/anonymize');
const { generateValidatedParser } = require('../src/ingest/llmParserGenerator');
const {
  registerDynamicExtractor,
  dispatchAll,
  templateFingerprint,
  findByFingerprint,
} = require('../src/ingest/extractors/index');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Kullanım: node scripts/generate-parser.js <pdf_dosya_yolu> [extractor_adi]');
    process.exit(1);
  }

  const pdfPath = path.resolve(args[0]);

  console.log(`[1/4] PDF metin katmanı okunuyor: ${pdfPath}`);
  let text;
  let rawText = null;
  try {
    text = splitIntoDocuments(await pdfToText(pdfPath))[0];
    rawText = await pdfToTextRaw(pdfPath).catch(() => null);
  } catch (err) {
    console.error('PDF okunurken hata oluştu:', err.message);
    process.exit(1);
  }

  const fingerprint = templateFingerprint(text);
  const customName = args[1] || findByFingerprint(fingerprint)?.name || `dynamic_${fingerprint}`;

  const [mevcut] = dispatchAll(text, { rawText });
  console.log(mevcut
    ? `      Mevcut en iyi extractor: ${mevcut.name} → ${mevcut.validation.durum}, skor ${mevcut.validation.skor}`
    : '      Mevcut extractor\'lar bu şablonu tanımıyor.');

  console.log('[2/4] LLM\'e gidecek sentetik maskeli metin (örnek — her çağrıda yeniden üretilir):');
  console.log('---------------------------------------------------');
  const ornek = maskForLlm(text).masked;
  console.log(ornek.slice(0, 1500));
  if (ornek.length > 1500) console.log('... [kırpıldı]');
  console.log('---------------------------------------------------\n');

  console.log('[3/4] LLM ile parser üretilip gerçek metin üzerinde YEREL olarak doğrulanıyor...');
  const gen = await generateValidatedParser({ text, rawText, options: { force: true } });
  if (!gen.success) {
    console.error(`❌ Parser üretimi başarısız (${gen.attempts} deneme): ${gen.error}`);
    if (gen.best) console.error(`   En iyi deneme skoru: ${gen.best.validation.skor}`);
    process.exit(1);
  }

  console.log('[4/4] Doğrulanan parser kaydediliyor...');
  const savedPath = registerDynamicExtractor(customName, gen.code, {
    fingerprint, provider: gen.provider, model: gen.model,
    skor: gen.validation.skor, denemeSayisi: gen.attempts,
  });
  console.log(`✅ Kaydedildi: ${savedPath}`);
  console.log(`   ${gen.validation.durum}, skor ${gen.validation.skor}, ${gen.attempts} deneme (${gen.provider}/${gen.model})`);
  console.log(`   ${gen.result.items.length} kalem; belge no: ${gen.result.header.belge_no ?? '-'}`);
  if (gen.validation.notlar.length) console.log(`   Notlar: ${gen.validation.notlar.join('; ')}`);
}

main().catch((err) => {
  console.error('İşlem sırasında hata:', err);
  process.exit(1);
});
