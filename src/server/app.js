'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8888;
// Varsayılan: yalnızca bu makineden erişim. DB kişisel veri (VKN/TCKN, adres)
// içerdiğinden ağa açmak bilinçli bir tercih olmalı: HOST=0.0.0.0 ile açılır.
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Opsiyonel gizleme katmanı (Secret Path / Cookie): SECRET_PATH ayarlanmışsa
// panel yalnızca /<SECRET_PATH> adresini ziyaret edip yetki çerezi alanlara
// açılır; diğer tüm istekler 404 döner. Çerez değeri koddan tahmin
// edilemesin diye gizli yoldan türetilir. Bu bir kimlik doğrulama değildir;
// ağa açık kurulumda PANEL_USER/PANEL_PASS ile birlikte kullanılmalıdır.
const SECRET_PATH = process.env.SECRET_PATH;
if (SECRET_PATH) {
  const { createHash } = require('crypto');
  const yetkiToken = createHash('sha256')
    .update(`efatura-yetki:${SECRET_PATH}`)
    .digest('hex')
    .slice(0, 32);

  app.use((req, res, next) => {
    // 1. Adım: Yetkilendirme Girişi
    if (req.path === `/${SECRET_PATH}` || req.path === `/${SECRET_PATH}/`) {
      res.setHeader(
        'Set-Cookie',
        `yetki_karti=${yetkiToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`
      );
      return res.redirect('/');
    }

    // 2. Adım: Çerez Kontrolü
    const cookieHeader = req.headers.cookie;
    let isAuthorized = false;
    if (cookieHeader) {
      const cookies = cookieHeader.split(';');
      for (let cookie of cookies) {
        const [key, val] = cookie.trim().split('=');
        if (key === 'yetki_karti' && val === yetkiToken) {
          isAuthorized = true;
          break;
        }
      }
    }

    if (!isAuthorized) {
      // Yetkisiz isteklere 404 dönerek sistemi gizle
      return res.status(404).send('Not Found');
    }

    next();
  });
}


// Opsiyonel parola koruması: PANEL_USER + PANEL_PASS ayarlanmışsa tüm
// istekler HTTP Basic Auth ister. Panel kurum ağına (HOST=0.0.0.0) açılıyorsa
// kullanılması önerilir — DB kişisel veri içerir ve düzenleme modu vardır.
const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;
if (PANEL_USER && PANEL_PASS) {
  const { timingSafeEqual } = require('crypto');
  const beklenen = Buffer.from(`${PANEL_USER}:${PANEL_PASS}`);
  app.use((req, res, next) => {
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
    const gelen = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
    const dogru = gelen.length === beklenen.length && timingSafeEqual(gelen, beklenen);
    if (!dogru) {
      res.setHeader('WWW-Authenticate', 'Basic realm="eFatura Arsivi", charset="UTF-8"');
      return res.status(401).json({ error: 'Kimlik doğrulama gerekli' });
    }
    next();
  });
}

// Temel güvenlik başlıkları
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});

// CSRF koruması: durum değiştiren istekler yalnızca panelin kendisinden
// gelebilir. Tarayıcı cross-site isteklerde Origin/Sec-Fetch-Site gönderir;
// eşleşmiyorsa reddet. (curl gibi tarayıcı dışı araçlar Origin göndermez,
// onlar localhost'tan zaten erişebilir.)
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return res.status(403).json({ error: 'Cross-origin yazma isteği reddedildi' });
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'Cross-site yazma isteği reddedildi' });
  }
  next();
});

// Statik frontend
app.use(express.static(path.join(__dirname, '..', 'web')));

// API route'ları
app.use('/api/documents', require('./routes/documents'));
app.use('/api/documents', require('./routes/documents_detail'));
app.use('/api/documents', require('./routes/documents_crud'));
app.use('/api/items', require('./routes/items_search'));
app.use('/api/items', require('./routes/items_crud'));
app.use('/api/taraflar', require('./routes/taraflar'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/extractors', require('./routes/extractors'));

// Bilinmeyen API yolu → JSON 404 (SPA fallback'ine düşüp HTML dönmesin)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

// Merkezi hata yakalayıcı: stack trace'i istemciye sızdırma, logla
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Geçersiz JSON gövdesi' });
  }
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Sunucu hatası' });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`e-Fatura Arşivi çalışıyor: http://${HOST}:${PORT}`);
  });
}

module.exports = app;
