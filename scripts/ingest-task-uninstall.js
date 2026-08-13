'use strict';

// EFaturaArsivIngest zamanlanmış görevini kaldırır.
// Kullanım: npm run task:uninstall-ingest

const { execFileSync } = require('child_process');

const TASK_NAME = 'EFaturaArsivIngest';

try {
  execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'inherit' });
  console.log(`Zamanlanmış görev kaldırıldı: ${TASK_NAME}`);
} catch {
  // Görev zaten kurulu değilse schtasks hata döner; bu durumda sorun yok.
  console.log(`Zamanlanmış görev zaten mevcut değil veya kaldırıldı: ${TASK_NAME}`);
}
