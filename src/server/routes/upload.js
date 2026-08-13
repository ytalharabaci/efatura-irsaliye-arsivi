'use strict';

// POST /api/upload?filename=fatura.pdf — panelden PDF yükleme.
// Gövde: ham PDF bayt dizisi (Content-Type: application/pdf).
// Dosya data/uploads/ altına kaydedilir, ardından CLI ingest ile aynı
// hattan geçer: pdftotext → extractor → doğrulama → DB'ye upsert.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../db/db');
const { ingestPdf } = require('../../ingest/ingestCore');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(PROJECT_ROOT, 'data', 'uploads');

const rawPdf = express.raw({
  type: ['application/pdf', 'application/octet-stream'],
  limit: '25mb',
});

router.post('/', rawPdf, async (req, res, next) => {
  try {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'PDF gövdesi boş — dosyayı Content-Type: application/pdf ile gönderin' });
    }
    // Magic byte kontrolü: PDF dosyaları "%PDF-" ile başlar
    if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'Geçerli bir PDF dosyası değil' });
    }

    // Dosya adı temizliği: path bileşenlerini at, tehlikeli karakterleri değiştir.
    // path.win32.basename hem '/' hem '\' ayraçlarını işler — POSIX'te de
    // Windows istemciden gelen 'a\..\b.pdf' benzeri adlar güvenle kırpılır.
    const ham = String(req.query.filename || 'belge.pdf');
    let ad = path.win32.basename(ham)
      .replace(/[^\w.\- çğıöşüÇĞİÖŞÜ]/g, '_')
      .replace(/^\.+/, '')
      .trim();
    if (!ad || ad === '.pdf') ad = 'belge.pdf';
    if (!/\.pdf$/i.test(ad)) ad += '.pdf';

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    let hedef = path.join(UPLOAD_DIR, ad);
    if (fs.existsSync(hedef)) {
      // Aynı adla ikinci yükleme: üzerine yazma, zaman damgasıyla ayrıştır
      hedef = path.join(UPLOAD_DIR, ad.replace(/\.pdf$/i, `-${Date.now()}.pdf`));
    }
    fs.writeFileSync(hedef, body);

    const kaynak_dosya = path.relative(PROJECT_ROOT, hedef);
    const sonuc = await ingestPdf(getDb(), hedef, kaynak_dosya);

    res.status(['HATALI', 'TANINMAYAN'].includes(sonuc.durum) ? 422 : 200).json({
      dosya: path.basename(hedef),
      ...sonuc,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
