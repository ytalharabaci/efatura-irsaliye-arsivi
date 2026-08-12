# e-Fatura / e-İrsaliye Arşivi — kaldırma aracı
# PowerShell 5.1+ ile çalışır. KALDIR.bat üzerinden çağrılır.
# Yalnızca Windows servisini ve zamanlanmış görevleri kaldırır;
# verilere (data\ klasörü: veritabanı + PDF'ler) DOKUNMAZ.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # paket kök klasörü

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  e-Fatura / e-Irsaliye Arsivi - Kaldirma"     -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "NOT: Bu arac yalnizca servisi ve zamanlanmis gorevleri kaldirir." -ForegroundColor Yellow
Write-Host "Verileriniz (data\ klasoru: veritabani + PDF'ler) SILINMEZ."      -ForegroundColor Yellow
Write-Host ""

# --- Kurulu bilesenleri tespit et ---
$servis = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*efaturaarsiv*' -or $_.DisplayName -like '*EFaturaArsiv*' }
$ingest = Get-ScheduledTask -TaskName 'EFaturaArsivIngest' -ErrorAction SilentlyContinue
$yedek  = Get-ScheduledTask -TaskName 'EFaturaArsivYedek'  -ErrorAction SilentlyContinue

if (-not $servis -and -not $ingest -and -not $yedek) {
    Write-Host "[OK] Kaldirilacak bilesen bulunamadi - servis ve gorevler zaten kurulu degil." -ForegroundColor Green
    Write-Host "Uygulamayi tamamen silmek icin bu klasoru silebilirsiniz;"
    Write-Host "once data\ klasorunu yedeklemeyi unutmayin."
    exit 0
}

Write-Host "Bulunan bilesenler:"
if ($servis) { Write-Host "  - Windows servisi   : EFaturaArsivServisi (durum: $($servis[0].Status))" }
if ($ingest) { Write-Host "  - Zamanlanmis gorev : EFaturaArsivIngest (otomatik ice aktarma)" }
if ($yedek)  { Write-Host "  - Zamanlanmis gorev : EFaturaArsivYedek (otomatik yedek)" }
Write-Host ""
$onay = Read-Host "Bunlarin tumu kaldirilsin mi? (E/h)"
if ($onay -eq 'h' -or $onay -eq 'H') {
    Write-Host "Islem iptal edildi; hicbir sey kaldirilmadi."
    exit 0
}

$hata = $false

if ($servis) {
    Write-Host ""
    Write-Host "Servis kaldiriliyor (bir UAC onayi istenebilir)..."
    Push-Location $root
    npm run service:uninstall
    Pop-Location
    Start-Sleep -Seconds 2
    $kalanServis = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*efaturaarsiv*' -or $_.DisplayName -like '*EFaturaArsiv*' }
    if ($kalanServis) {
        Write-Host "[BILGI] Servis baska bir klasorden veya farkli isimle kurulmus olabilir; sc.exe ile dogrudan kaldiriliyor..." -ForegroundColor Yellow
        foreach ($s in $kalanServis) {
            $sName = $s.Name
            Start-Process sc.exe -ArgumentList "stop `"$sName`"" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
            Start-Process sc.exe -ArgumentList "delete `"$sName`"" -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
    $kalanServis = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*efaturaarsiv*' -or $_.DisplayName -like '*EFaturaArsiv*' }
    if ($kalanServis) {
        Write-Host "[HATA] Servis kaldirilamadi." -ForegroundColor Red
        $hata = $true
    } else {
        Write-Host "[OK] Servis ve guvenlik duvari kurali kaldirildi." -ForegroundColor Green
    }
}

if ($ingest) {
    Write-Host ""
    Push-Location $root
    npm run task:uninstall-ingest
    Pop-Location
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] EFaturaArsivIngest gorevi kaldirildi." -ForegroundColor Green
    } else {
        Write-Host "[HATA] EFaturaArsivIngest gorevi kaldirilamadi." -ForegroundColor Red
        $hata = $true
    }
}

if ($yedek) {
    Write-Host ""
    Push-Location $root
    npm run task:uninstall-backup
    Pop-Location
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] EFaturaArsivYedek gorevi kaldirildi." -ForegroundColor Green
    } else {
        Write-Host "[HATA] EFaturaArsivYedek gorevi kaldirilamadi." -ForegroundColor Red
        $hata = $true
    }
}

Write-Host ""
if ($hata) {
    Write-Host "Kaldirma KISMEN tamamlandi - yukaridaki hatalara bakin." -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Kaldirma tamamlandi. Verileriniz data\ klasorunde durmaya devam ediyor." -ForegroundColor Green
Write-Host "Uygulamayi tamamen silmek icin bu klasoru silebilirsiniz;"
Write-Host "once data\ klasorunu yedeklemeyi unutmayin."
