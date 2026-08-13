'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/db');

// GET /api/documents/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Geçersiz id' });

  const doc = db.prepare(`
    SELECT d.*,
           s.unvan as satici_unvan, s.vkn_tckn as satici_vkn_tckn,
           s.vergi_dairesi as satici_vergi_dairesi, s.adres as satici_adres,
           s.eposta as satici_eposta, s.telefon as satici_telefon,
           a.unvan as alici_unvan, a.vkn_tckn as alici_vkn_tckn,
           a.vergi_dairesi as alici_vergi_dairesi, a.adres as alici_adres,
           a.eposta as alici_eposta, a.telefon as alici_telefon
    FROM documents d
    LEFT JOIN taraflar s ON s.id = d.satici_id
    LEFT JOIN taraflar a ON a.id = d.alici_id
    WHERE d.id = ?
  `).get(id);
  if (!doc) return res.status(404).json({ error: 'Belge bulunamadı' });

  const items = db.prepare('SELECT * FROM items WHERE document_id = ? ORDER BY sira_no').all(id);
  res.json({ ...doc, items });
});

module.exports = router;
