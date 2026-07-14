'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/db');
const { validateDocument } = require('../../ingest/validate');
const {
  sayiVeyaNull, tamsayiVeyaNull, metinVeyaNull, kumeden, isoTarihVeyaNull, dogrula,
} = require('../validators');

// PATCH ile değiştirilebilecek belge alanları (whitelist).
// satici_id/alici_id, kaynak_dosya ve olusturma_tarihi bilinçli olarak dışarıda:
// taraf düzeltmesi /api/taraflar üzerinden yapılır, kaynak dosya ingest'in işidir.
const BELGE_SEMASI = {
  belge_tipi: kumeden(['FATURA', 'IRSALIYE']),
  belge_no: metinVeyaNull(100),
  ettn: metinVeyaNull(50),
  duzenleme_tarihi: isoTarihVeyaNull,
  duzenleme_zamani: metinVeyaNull(20),
  senaryo: metinVeyaNull(50),
  fatura_tipi: metinVeyaNull(50),
  mal_hizmet_toplam_tutari: sayiVeyaNull,
  hesaplanan_kdv_toplam: sayiVeyaNull,
  vergiler_dahil_toplam_tutar: sayiVeyaNull,
  odenecek_tutar: sayiVeyaNull,
  notlar: metinVeyaNull(4000),
  parse_durumu: kumeden(['BASARILI', 'SUPHELI', 'HATALI']),
  parse_notu: metinVeyaNull(4000),
};

const KALEM_SEMASI = {
  sira_no: tamsayiVeyaNull,
  aciklama: metinVeyaNull(2000),
  miktar: sayiVeyaNull,
  birim: metinVeyaNull(30),
  birim_fiyat: sayiVeyaNull,
  kdv_orani: sayiVeyaNull,
  kdv_tutari: sayiVeyaNull,
  mal_hizmet_tutari: sayiVeyaNull,
};

function belgeIdAl(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id < 1) {
    res.status(400).json({ error: 'Geçersiz id' });
    return null;
  }
  return id;
}

// PATCH /api/documents/:id — belge başlığını kısmi güncelle
router.patch('/:id', (req, res) => {
  const id = belgeIdAl(req, res);
  if (id === null) return;
  const db = getDb();

  const mevcut = db.prepare('SELECT id FROM documents WHERE id = ?').get(id);
  if (!mevcut) return res.status(404).json({ error: 'Belge bulunamadı' });

  const { fields, errors } = dogrula(req.body, BELGE_SEMASI);
  if (errors.length) return res.status(400).json({ error: 'Doğrulama hatası', detaylar: errors });
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Güncellenecek alan yok' });

  // parse_durumu HATALI/BASARILI olamaz kısıtı yok; ama belge_tipi NOT NULL
  if ('belge_tipi' in fields && fields.belge_tipi === null) {
    return res.status(400).json({ error: 'belge_tipi boş olamaz' });
  }
  if ('parse_durumu' in fields && fields.parse_durumu === null) {
    return res.status(400).json({ error: 'parse_durumu boş olamaz' });
  }

  const sets = Object.keys(fields).map((k) => `${k} = :${k}`).join(', ');
  try {
    db.prepare(`UPDATE documents SET ${sets} WHERE id = :__id`).run({ ...fields, __id: id });
  } catch (err) {
    if (/UNIQUE.*ettn/i.test(err.message)) {
      return res.status(409).json({ error: 'Bu ETTN başka bir belgede zaten kayıtlı' });
    }
    throw err;
  }
  res.json({ ok: true, guncellenen_alanlar: Object.keys(fields) });
});

// DELETE /api/documents/:id — belgeyi ve kalemlerini (CASCADE) siler
router.delete('/:id', (req, res) => {
  const id = belgeIdAl(req, res);
  if (id === null) return;
  const db = getDb();

  const result = db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Belge bulunamadı' });
  res.json({ ok: true });
});

// POST /api/documents/:id/items — belgeye yeni kalem ekle
router.post('/:id/items', (req, res) => {
  const id = belgeIdAl(req, res);
  if (id === null) return;
  const db = getDb();

  const mevcut = db.prepare('SELECT id FROM documents WHERE id = ?').get(id);
  if (!mevcut) return res.status(404).json({ error: 'Belge bulunamadı' });

  const { fields, errors } = dogrula(req.body, KALEM_SEMASI);
  if (errors.length) return res.status(400).json({ error: 'Doğrulama hatası', detaylar: errors });

  if (fields.sira_no == null) {
    const maxRow = db.prepare('SELECT MAX(sira_no) as maxNo FROM items WHERE document_id = ?').get(id);
    fields.sira_no = (maxRow.maxNo || 0) + 1;
  }

  const result = db.prepare(`
    INSERT INTO items (document_id, sira_no, aciklama, miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari)
    VALUES (:document_id, :sira_no, :aciklama, :miktar, :birim, :birim_fiyat, :kdv_orani, :kdv_tutari, :mal_hizmet_tutari)
  `).run({
    document_id: id,
    sira_no: fields.sira_no ?? null,
    aciklama: fields.aciklama ?? null,
    miktar: fields.miktar ?? null,
    birim: fields.birim ?? null,
    birim_fiyat: fields.birim_fiyat ?? null,
    kdv_orani: fields.kdv_orani ?? null,
    kdv_tutari: fields.kdv_tutari ?? null,
    mal_hizmet_tutari: fields.mal_hizmet_tutari ?? null,
  });

  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(result.lastInsertRowid));
  res.status(201).json(item);
});

// POST /api/documents/:id/revalidate — kalem toplamlarını header ile yeniden
// karşılaştırıp parse_durumu/parse_notu alanlarını günceller. Panelden yapılan
// düzeltmelerden sonra "bu belge artık tutarlı mı?" sorusunun cevabı.
router.post('/:id/revalidate', (req, res) => {
  const id = belgeIdAl(req, res);
  if (id === null) return;
  const db = getDb();

  const doc = db.prepare(
    'SELECT mal_hizmet_toplam_tutari, toplam_iskonto, hesaplanan_kdv_toplam FROM documents WHERE id = ?'
  ).get(id);
  if (!doc) return res.status(404).json({ error: 'Belge bulunamadı' });

  const items = db.prepare(
    'SELECT mal_hizmet_tutari, kdv_tutari FROM items WHERE document_id = ?'
  ).all(id);

  if (doc.mal_hizmet_toplam_tutari == null && items.length === 0) {
    return res.status(400).json({ error: 'Doğrulanacak veri yok: belgede toplam tutar ve kalem bulunmuyor' });
  }

  const validation = validateDocument(doc, items);
  db.prepare('UPDATE documents SET parse_durumu = ?, parse_notu = ? WHERE id = ?').run(
    validation.durum,
    validation.notlar.length ? validation.notlar.join('; ') : null,
    id
  );

  res.json({ ok: true, parse_durumu: validation.durum, notlar: validation.notlar });
});

module.exports = router;
module.exports.KALEM_SEMASI = KALEM_SEMASI;
