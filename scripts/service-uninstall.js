'use strict';

// EFaturaArsivServisi Windows Service'ini kaldırır.
// Normal terminalden çalıştırılabilir (tek UAC onayı): npm run service:uninstall

const path = require('path');
const { execFileSync } = require('child_process');
const { Service } = require('node-windows');
const { ensureElevated } = require('./elevate');

ensureElevated(__filename);

const svc = new Service({
  name: 'EFaturaArsivServisi',
  script: path.join(__dirname, '..', 'src', 'server', 'app.js'),
});

function forceRemoveService() {
  const names = ['efaturaarsivservisi.exe', 'EFaturaArsivServisi', 'efaturaarsivservisi'];
  for (const name of names) {
    try { execFileSync('sc.exe', ['stop', name], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { execFileSync('sc.exe', ['delete', name], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try {
    execFileSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=EFaturaArsivi'], { stdio: 'ignore' });
    console.log('Güvenlik duvarı kuralı kaldırıldı (EFaturaArsivi).');
  } catch { /* kural yoktu */ }
}

svc.on('uninstall', () => {
  console.log('Servis (node-windows) kaldırıldı.');
  forceRemoveService();
});

svc.on('error', (err) => {
  console.log('node-windows kaldırıcı uyarısı:', err && err.message ? err.message : err);
  console.log('Servis sc.exe ile doğrudan kaldırılıyor...');
  forceRemoveService();
});

try {
  svc.uninstall();
} catch (err) {
  console.log('Servis kaldırma hatası:', err.message);
  forceRemoveService();
}
