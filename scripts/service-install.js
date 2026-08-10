'use strict';

// Express sunucusunu Windows Service olarak kaydeder (node-windows).
// Normal (yükseltilmemiş) terminalden çalıştırılabilir: npm run service:install
// — tek bir UAC onayı istenir (bkz. elevate.js).
//
// Ortam değişkenleri (kurulum sırasında okunur, servise gömülür):
//   PORT        → dinlenecek port (varsayılan 8888)
//   HOST        → varsayılan 0.0.0.0 (kurum ağından, makinenin IP'siyle erişim).
//                 Yalnızca bu makineden erişim için: $env:HOST='127.0.0.1'
//   PANEL_USER / PANEL_PASS → ayarlanırsa panel parola ister (ağa açıkken önerilir)
//   SECRET_PATH → ayarlanırsa panel gizlenir; ilk erişim /<SECRET_PATH> ziyaretiyle
//   DB_PATH     → farklı bir veritabanı konumu
//
// HOST=0.0.0.0 (varsayılan) ise, yalnızca yerel alt ağa izin veren güvenlik
// duvarı kuralı da otomatik eklenir (zaten yönetici yetkisiyle çalışıyoruz).

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Service } = require('node-windows');
const { ensureElevated } = require('./elevate');

// Yönetici değilsek tek UAC onayıyla kendimizi yükseltip yeniden başlarız;
// aşağıdaki kod her durumda yönetici yetkisiyle çalışır (node-windows'un
// her adım için ayrı UAC sorması böylece engellenir).
ensureElevated(__filename);

const PORT = process.env.PORT || '8888';
const HOST = process.env.HOST || '0.0.0.0';

const env = [
  { name: 'PORT', value: PORT },
  { name: 'HOST', value: HOST },
];
if (process.env.PANEL_USER && process.env.PANEL_PASS) {
  env.push({ name: 'PANEL_USER', value: process.env.PANEL_USER });
  env.push({ name: 'PANEL_PASS', value: process.env.PANEL_PASS });
}
if (process.env.SECRET_PATH) {
  env.push({ name: 'SECRET_PATH', value: process.env.SECRET_PATH });
}
if (process.env.DB_PATH) {
  env.push({ name: 'DB_PATH', value: process.env.DB_PATH });
}
if (process.env.LLM_API_KEY) {
  env.push({ name: 'LLM_API_KEY', value: process.env.LLM_API_KEY });
}
if (process.env.LLM_BASE_URL) {
  env.push({ name: 'LLM_BASE_URL', value: process.env.LLM_BASE_URL });
}
if (process.env.LLM_MODEL) {
  env.push({ name: 'LLM_MODEL', value: process.env.LLM_MODEL });
}
if (process.env.ENABLE_LLM_AUTO_PARSER) {
  env.push({ name: 'ENABLE_LLM_AUTO_PARSER', value: process.env.ENABLE_LLM_AUTO_PARSER });
}

const svc = new Service({
  name: 'EFaturaArsivServisi',
  description: 'e-Fatura/e-İrsaliye arşiv web sunucusu.',
  script: path.join(__dirname, '..', 'src', 'server', 'app.js'),
  nodeOptions: ['--experimental-sqlite'],
  workingDirectory: path.join(__dirname, '..'),
  env,
});

svc.on('install', () => {
  console.log('Servis kuruldu, başlatılıyor...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.error('HATA: Servis zaten kurulu — yeni ayarlar UYGULANMADI.');
  console.error('Güncellemek için servisi ilk kurduğunuz klasörde önce kaldırın:');
  console.error('  npm run service:uninstall');
  console.error('sonra bu kurulumu yeniden çalıştırın.');
  process.exitCode = 1;
});

// Ağdaki diğer makinelerin kullanacağı gerçek IPv4 adresleri (localhost hariç)
function yerelIPler() {
  const out = [];
  for (const arr of Object.values(os.networkInterfaces())) {
    for (const i of arr || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) {
        out.push(i.address);
      }
    }
  }
  return out;
}

svc.on('start', () => {
  console.log(`Servis çalışıyor: http://localhost:${PORT} (bind: ${HOST})`);
  console.log('Bilgisayar her açıldığında otomatik başlayacak.');
  const agdan = HOST === '0.0.0.0';
  if (process.env.SECRET_PATH) {
    console.log('Gizli yol aktif — panele ilk erişim:');
    console.log(`  bu bilgisayardan : http://localhost:${PORT}/${process.env.SECRET_PATH}`);
    if (agdan) {
      for (const ip of yerelIPler()) {
        console.log(`  ağdaki diğerleri : http://${ip}:${PORT}/${process.env.SECRET_PATH}`);
      }
    }
    console.log('(Bu adresi ziyaret etmeyen tarayıcılar 404 görür; çerez 30 gün geçerlidir.)');
  }
  if (agdan) {
    kurGuvenlikDuvariKurali();
    console.log('');
    const ipler = yerelIPler();
    const adres = ipler.length ? ipler.map((ip) => `http://${ip}:${PORT}`).join(' veya ') : `http://<bu-makinenin-ip'si>:${PORT}`;
    console.log('Sunucu kurum ağına açık — diğer bilgisayarlar ' + adres + ' adresinden erişir.');
    if (!process.env.PANEL_USER) {
      console.log('UYARI: Parola KORUMASIZ kurulum yapıldı — DB kişisel veri içeriyor. Önerilen:');
      console.log("  npm run service:uninstall");
      console.log("  $env:PANEL_USER='kullanici'; $env:PANEL_PASS='guclu-parola'; npm run service:install");
    }
  }
});

// Yalnızca yerel alt ağdan (localsubnet) erişime izin veren güvenlik duvarı
// kuralı. Aynı adlı eski kural varsa önce silinir (port değişikliğinde
// bayat kural kalmasın).
function kurGuvenlikDuvariKurali() {
  try {
    execFileSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=EFaturaArsivi'], { stdio: 'ignore' });
  } catch { /* kural yoktu, sorun değil */ }
  try {
    execFileSync('netsh', [
      'advfirewall', 'firewall', 'add', 'rule',
      'name=EFaturaArsivi', 'dir=in', 'action=allow', 'protocol=TCP',
      `localport=${PORT}`, 'remoteip=localsubnet',
    ], { stdio: 'ignore' });
    console.log(`Güvenlik duvarı kuralı eklendi: TCP ${PORT}, yalnızca yerel alt ağ (EFaturaArsivi).`);
  } catch (err) {
    console.log('Güvenlik duvarı kuralı eklenemedi: ' + err.message);
    console.log('Elle eklemek için: netsh advfirewall firewall add rule name="EFaturaArsivi" dir=in action=allow protocol=TCP localport=' + PORT + ' remoteip=localsubnet');
  }
}

svc.on('error', (err) => {
  console.error('Servis hatası:', err);
});

svc.install();
