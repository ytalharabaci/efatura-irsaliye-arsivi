'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/db');
const { clampInt, likeContains } = require('../queryUtil');

// GET /api/items?q=<metin>&limit=&offset=
router.get('/', (req, res) => {
  const db = getDb();
  const { q } = req.query;
  const limit = clampInt(req.query.limit, { def: 50, min: 1, max: 500 });
  const offset = clampInt(req.query.offset, { def: 0, min: 0, max: 1e9 });

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'q parametresi en az 2 karakter olmalı' });
  }

  // tr_lower: Türkçe harf duyarsız arama ("güvenlik" → "GÜVENLİK" bulunur).
  // İkinci koşul boşluk duyarsız: iki taraftan da boşluklar atılarak
  // karşılaştırılır — PDF kerning artefaktıyla bölünmüş eski kayıtlar
  // ("HO RTUM") ve bitişik yazımlar da bulunur.
  const pattern = likeContains(q);
  const patternNoSpace = likeContains(String(q).replace(/\s+/g, ''));
  const whereSql = `(tr_lower(i.aciklama) LIKE tr_lower(?) ESCAPE '\\'
    OR REPLACE(tr_lower(i.aciklama), ' ', '') LIKE tr_lower(?) ESCAPE '\\')`;
  const whereParams = [pattern, patternNoSpace];

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM items i WHERE ${whereSql}`
  ).get(...whereParams);

  const rows = db.prepare(`
    SELECT i.id, i.sira_no, i.aciklama, i.miktar, i.birim, i.birim_fiyat,
           i.kdv_orani, i.kdv_tutari, i.mal_hizmet_tutari,
           d.id as document_id, d.belge_no, d.duzenleme_tarihi,
           s.unvan as satici_unvan, a.unvan as alici_unvan, d.parse_durumu
    FROM items i
    JOIN documents d ON d.id = i.document_id
    LEFT JOIN taraflar s ON s.id = d.satici_id
    LEFT JOIN taraflar a ON a.id = d.alici_id
    WHERE ${whereSql}
    ORDER BY d.duzenleme_tarihi DESC, d.id DESC
    LIMIT ? OFFSET ?
  `).all(...whereParams, limit, offset);

  res.json({ total: countRow.total, limit, offset, data: rows });
});

module.exports = router;
