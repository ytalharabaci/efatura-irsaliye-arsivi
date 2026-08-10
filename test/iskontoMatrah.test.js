'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { getDb } = require('../src/db/db');
const { extract } = require('../src/ingest/extractors/gibStandardInvoice');
const { upsertDocument } = require('../src/ingest/ingestCore');

test('0003 Migration ve İskonto/Matrah Hesaplama Testi', () => {
  const db = getDb();

  // Tablo sütun kontrolü
  const itemCols = db.prepare("PRAGMA table_info('items')").all().map((c) => c.name);
  assert.ok(itemCols.includes('iskonto_orani'), 'items.iskonto_orani sütunu olmalı');
  assert.ok(itemCols.includes('iskonto_tutari'), 'items.iskonto_tutari sütunu olmalı');
  assert.ok(itemCols.includes('net_satir_tutari'), 'items.net_satir_tutari sütunu olmalı');

  const docCols = db.prepare("PRAGMA table_info('documents')").all().map((c) => c.name);
  assert.ok(docCols.includes('kdv_matrahi'), 'documents.kdv_matrahi sütunu olmalı');
});

test('gibStandardInvoice: İskonto ve KDV Matrahı Doğru Hesaplanmalı', () => {
  const samplePath = path.join(__dirname, 'fixtures', 'gib_standard_invoice_sample.txt');
  const sampleText = fs.readFileSync(samplePath, 'utf8');

  const result = extract(sampleText);
  assert.ok(result !== null);
  assert.equal(result.header.mal_hizmet_toplam_tutari, 15000);
  assert.equal(result.header.toplam_iskonto, 0);
  assert.equal(result.header.kdv_matrahi, 15000);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].net_satir_tutari, 15000);
});

test('Ingest Upsert: İskonto ve Matrah Alanları Veritabanına Yazılmalı', () => {
  const db = getDb();

  const mockHeader = {
    belge_tipi: 'FATURA',
    belge_no: 'TST2026000000100',
    ettn: '99999999-8888-7777-6666-555555555555',
    duzenleme_tarihi: '2026-08-10',
    duzenleme_zamani: '12:00',
    mal_hizmet_toplam_tutari: 1000,
    toplam_iskonto: 100,
    kdv_matrahi: 900,
    hesaplanan_kdv_toplam: 180,
    vergiler_dahil_toplam_tutar: 1080,
    odenecek_tutar: 1080,
    kaynak_dosya: 'test_iskonto.pdf',
    parse_durumu: 'BASARILI',
  };

  const mockItems = [
    {
      sira_no: 1,
      aciklama: 'İskontolu Ürün',
      miktar: 10,
      birim: 'Adet',
      birim_fiyat: 100,
      iskonto_orani: 10,
      iskonto_tutari: 100,
      net_satir_tutari: 900,
      kdv_orani: 20,
      kdv_tutari: 180,
      mal_hizmet_tutari: 900,
    },
  ];

  const docId = upsertDocument(db, mockHeader, mockItems);
  assert.ok(docId > 0);

  const docRow = db.prepare('SELECT kdv_matrahi, toplam_iskonto FROM documents WHERE id = ?').get(docId);
  assert.equal(docRow.toplam_iskonto, 100);
  assert.equal(docRow.kdv_matrahi, 900);

  const itemRow = db.prepare('SELECT iskonto_orani, iskonto_tutari, net_satir_tutari FROM items WHERE document_id = ?').get(docId);
  assert.equal(itemRow.iskonto_orani, 10);
  assert.equal(itemRow.iskonto_tutari, 100);
  assert.equal(itemRow.net_satir_tutari, 900);

  // Temizlik
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
});
