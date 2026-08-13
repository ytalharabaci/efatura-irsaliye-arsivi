'use strict';

// EFaturaArsivYedek zamanlanmış görevini kaldırır: npm run task:uninstall-backup

const { execFileSync } = require('child_process');

try {
  execFileSync('schtasks', ['/Delete', '/TN', 'EFaturaArsivYedek', '/F'], { stdio: 'inherit' });
  console.log('Zamanlanmış yedek görevi kaldırıldı.');
} catch {
  // Görev zaten kurulu değilse schtasks hata döner; bu durumda sorun yok.
  console.log('Zamanlanmış yedek görevi zaten mevcut değil veya kaldırıldı.');
}
