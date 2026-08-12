'use strict';

// Yönetici yetkisini TEK UAC onayıyla alan yardımcı.
//
// Sorun: node-windows, yükseltilmemiş bir terminalden çalıştırıldığında her
// alt komutu (servis kurulumu, başlatma...) ayrı ayrı yükseltmeye çalışır ve
// kullanıcı 3-4 kez UAC onayı vermek zorunda kalır.
//
// Çözüm: script yükseltilmiş değilse kendini yönetici olarak yeniden başlatır
// (tek UAC istemi). Yükseltilmiş kopyanın içinden çalışan node-windows artık
// zaten yönetici olduğundan hiç UAC sormaz. Yükseltilmiş kopyanın çıktısı bir
// log dosyası üzerinden orijinal terminale aktarılır; PORT/HOST gibi ortam
// değişkenleri de geçici bir config dosyasıyla taşınır (yükseltilmiş sürece
// ortam değişkeni aktarımı güvenilir değildir).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// Yükseltilmiş kopyaya taşınacak yapılandırma değişkenleri
const ENV_KEYS = [
  'PORT', 'HOST', 'PANEL_USER', 'PANEL_PASS', 'SECRET_PATH', 'DB_PATH',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GLM_API_KEY', 'LLM_PROVIDER',
  'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'ENABLE_LLM_AUTO_PARSER', 'PDFTOTEXT_PATH'
];

function isElevated() {
  try {
    // "net session" yalnızca yönetici yetkisiyle çalışır — standart kontrol
    execFileSync('net', ['session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Çağıran script'in yönetici yetkisiyle çalıştığını garanti eder.
 * - Zaten yükseltilmişse: hiçbir şey yapmaz, script devam eder.
 * - Yükseltilmiş kopya isek (--config ile geldik): ortam değişkenlerini
 *   config dosyasından geri yükler, script devam eder.
 * - Yükseltilmemişse: tek UAC onayıyla kendini yeniden başlatır, çıktıyı
 *   gösterir ve mevcut process'i bitirir (script devam ETMEZ).
 *
 * @param {string} scriptFile - çağıran script'in tam yolu (__filename)
 */
function ensureElevated(scriptFile) {
  const cfgIdx = process.argv.indexOf('--config');
  if (cfgIdx !== -1) {
    const cfgPath = process.argv[cfgIdx + 1];
    if (!cfgPath) {
      console.error('--config bayrağı bir dosya yolu gerektirir.');
      process.exit(1);
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      for (const k of ENV_KEYS) if (cfg[k] != null) process.env[k] = cfg[k];
    } finally {
      fs.rmSync(cfgPath, { force: true });
    }
    return;
  }

  if (isElevated()) return;

  console.log('Yönetici yetkisi gerekiyor — tek bir UAC onayı istenecek, işlem bitene kadar bekleyin...');

  const stamp = Date.now();
  const tmp = os.tmpdir();
  const cfgPath = path.join(tmp, `efatura-svc-cfg-${stamp}.json`);
  const logPath = path.join(tmp, `efatura-svc-log-${stamp}.txt`);
  const cmdPath = path.join(tmp, `efatura-svc-run-${stamp}.cmd`);

  const cfg = {};
  for (const k of ENV_KEYS) if (process.env[k]) cfg[k] = process.env[k];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  // İki kademeli PowerShell tırnaklamasıyla boğuşmamak için asıl komut
  // geçici bir .cmd dosyasına yazılır; Start-Process yalnızca onu çalıştırır.
  fs.writeFileSync(cmdPath, [
    '@echo off',
    `"${process.execPath}" "${scriptFile}" --config "${cfgPath}" > "${logPath}" 2>&1`,
    '',
  ].join('\r\n'));

  const ps = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `$p = Start-Process -FilePath cmd -ArgumentList '/c','"${cmdPath}"' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode`,
  ], { encoding: 'utf8' });

  let ok = ps.status === 0;
  if (fs.existsSync(logPath)) {
    const log = fs.readFileSync(logPath, 'utf8').trim();
    if (log) console.log(log);
    fs.rmSync(logPath, { force: true });
  } else {
    // Log dosyası hiç oluşmadıysa yükseltilmiş kopya hiç çalışmadı demektir
    ok = false;
    console.error('UAC onayı reddedildi veya yükseltme başarısız oldu — işlem yapılmadı.');
  }
  fs.rmSync(cmdPath, { force: true });
  fs.rmSync(cfgPath, { force: true });
  process.exit(ok ? 0 : 1);
}

module.exports = { ensureElevated, isElevated };
