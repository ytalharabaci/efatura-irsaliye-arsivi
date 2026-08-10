'use strict';

const path = require('node:path');
const { pdfToText } = require('../src/ingest/pdfToText');
const { anonymizePdfText } = require('../src/ingest/anonymize');
const { generateParserFromLayout } = require('../src/ingest/llmParserGenerator');
const { registerDynamicExtractor, dispatch } = require('../src/ingest/extractors/index');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Kullanım: node scripts/generate-parser.js <pdf_dosya_yolu> [extractor_adi]');
    process.exit(1);
  }

  const pdfPath = path.resolve(args[0]);
  const customName = args[1] || `dynamic_${Date.now()}`;

  console.log(`[1/5] PDF metin katmanı okunuyor: ${pdfPath}`);
  let rawText;
  try {
    rawText = await pdfToText(pdfPath);
  } catch (err) {
    console.error('PDF okunurken hata oluştu:', err.message);
    process.exit(1);
  }

  console.log('[2/5] Metin KVKK uyumlu olarak maskeleniyor...');
  const anonymizedText = anonymizePdfText(rawText);

  console.log('\n--- MASKELEME İSKELETİ (LLM\'e Gönderilen Metin) ---');
  console.log(anonymizedText.slice(0, 800));
  if (anonymizedText.length > 800) console.log('... [kırpıldı]');
  console.log('---------------------------------------------------\n');

  console.log('[3/5] LLM API\'sinden JS Extractor kütüphanesi üretilmesi isteniyor...');
  const genResult = await generateParserFromLayout(anonymizedText);

  if (!genResult.success) {
    console.error('❌ Parser üretimi başarısız:', genResult.error);
    process.exit(1);
  }

  console.log('[4/5] Üretilen JS kodu doğrulanıp diske kaydediliyor...');
  try {
    const savedPath = registerDynamicExtractor(customName, genResult.code);
    console.log(`✅ Extractor başarıyla kaydedildi: ${savedPath}`);
  } catch (err) {
    console.error('❌ Extractor kaydetme hatası:', err.message);
    process.exit(1);
  }

  console.log('[5/5] Yeni extractor sunucuda YEREL olarak orijinal PDF üzerinde test ediliyor...');
  const dispatched = dispatch(rawText);

  if (dispatched) {
    console.log(`\n🎉 BAŞARILI! Orijinal fatura sunucudan hiç çıkmadan yerel olarak ayrıştırıldı:`);
    console.log(`Kullanılan Extractor: ${dispatched.name}`);
    console.log('Başlık Bilgileri:', JSON.stringify(dispatched.result.header, null, 2));
    console.log(`Toplam ${dispatched.result.items.length} adet kalem bulundu.`);
  } else {
    console.error('⚠️ Extractor kaydedildi ancak yerel test eşleşmedi.');
  }
}

main().catch((err) => {
  console.error('İşlem sırasında hata:', err);
  process.exit(1);
});
