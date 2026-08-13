# e-Fatura / e-İrsaliye Arşivi — Windows kurulum sihirbazı
# PowerShell 5.1+ ile çalışır. KUR.bat üzerinden çağrılır.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # paket kök klasörü

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  e-Fatura / e-Irsaliye Arsivi - Kurulum"      -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Node.js kontrolü (>= 22.5, node:sqlite için) ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[HATA] Node.js bulunamadi." -ForegroundColor Red
    Write-Host "Lutfen once Node.js 22.5 veya ustunu kurun: https://nodejs.org/"
    exit 1
}
$nodeVer = (node --version).TrimStart('v')
$verParts = $nodeVer.Split('.')
$major = [int]$verParts[0]; $minor = [int]$verParts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    Write-Host "[HATA] Node.js $nodeVer bulundu; en az 22.5 gerekli (node:sqlite icin)." -ForegroundColor Red
    Write-Host "Guncelleyin: https://nodejs.org/"
    exit 1
}
Write-Host "[OK] Node.js $nodeVer" -ForegroundColor Green

# --- 2. pdftotext (poppler) kontrolü ---
$pdftotext = Get-Command pdftotext -ErrorAction SilentlyContinue
$popplerAdaylar = @(
    'C:\poppler\pdftotext.exe',
    'C:\poppler\Library\bin\pdftotext.exe',
    'C:\poppler\bin\pdftotext.exe'
)
$bulunanPoppler = $null
foreach ($aday in $popplerAdaylar) {
    if (Test-Path $aday) {
        $bulunanPoppler = $aday
        break
    }
}

if ($bulunanPoppler) {
    $env:PDFTOTEXT_PATH = $bulunanPoppler
    Write-Host "[OK] pdftotext (poppler) bulundu: $bulunanPoppler" -ForegroundColor Green
} elseif ($pdftotext -and $pdftotext.Source -notlike '*miktex*') {
    Write-Host "[OK] pdftotext bulundu: $($pdftotext.Source)" -ForegroundColor Green
} else {
    if ($pdftotext -and $pdftotext.Source -like '*miktex*') {
        Write-Host "[UYARI] MiKTeX pdftotext bulundu fakat MiKTeX -layout secenegini desteklemez." -ForegroundColor Yellow
        Write-Host "  Lutfen poppler-windows'u C:\poppler konumuna cikarin."
    } else {
        Write-Host "[UYARI] pdftotext PATH'te veya C:\poppler konumunda bulunamadi." -ForegroundColor Yellow
    }
    Write-Host "  PDF ice aktarmak icin poppler-windows gereklidir:"
    Write-Host "  https://github.com/oschwartz10612/poppler-windows/releases"
    Write-Host "  -> Zip'i C:\poppler konumuna cikarin (C:\poppler\pdftotext.exe veya C:\poppler\Library\bin\pdftotext.exe)."
    Write-Host "  (Web arayuzu pdftotext olmadan da calisir; yalnizca PDF isleme icin gerekir.)"
}

# --- 3. Bağımlılıklar (pakette hazır gelir; eksikse npm install) ---
if (Test-Path (Join-Path $root 'node_modules\express')) {
    Write-Host "[OK] Bagimliliklar pakete dahil (cevrimdisi kurulum)." -ForegroundColor Green
} else {
    Write-Host "Bagimliliklar yukleniyor (npm install)..."
    Push-Location $root
    npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[HATA] npm install basarisiz oldu." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Bagimliliklar yuklendi." -ForegroundColor Green
}

# --- 3.5 Yapay Zeka (LLM Auto-Parser) yapılandırması ---
Write-Host ""
Write-Host "Yapay Zeka (LLM Auto-Parser) Destegi:" -ForegroundColor Cyan
Write-Host "  Taninmayan e-Fatura/e-Irsaliye PDF sablonlarinda otomatik parser uretmek icin"
Write-Host "  LLM API Key (DeepSeek / OpenAI / GLM) tanimlayabilirsiniz."
$llmKur = Read-Host "Yapay Zeka (DeepSeek / LLM) API key tanimlamak ister misiniz? (E/h)"

if ($llmKur -ne 'h' -and $llmKur -ne 'H') {
    Write-Host "Saglayici secin:"
    Write-Host "  [1] DeepSeek (onerilen - deepseek-chat / deepseek-reasoner)"
    Write-Host "  [2] OpenAI (gpt-4o / mini)"
    Write-Host "  [3] GLM (glm-4)"
    Write-Host "  [4] Diger / Ozel"
    $llmProviderSecim = Read-Host "Seciminiz (1/2/3/4, varsayilan 1)"
    
    switch ($llmProviderSecim) {
        '2' { $provider = 'openai' }
        '3' { $provider = 'glm' }
        '4' { $provider = 'custom' }
        default { $provider = 'deepseek' }
    }
    
    $apiKey = Read-Host "$provider API Key girin"
    if ($apiKey) {
        $env:LLM_PROVIDER = $provider
        if ($provider -eq 'deepseek') {
            $env:DEEPSEEK_API_KEY = $apiKey
        } elseif ($provider -eq 'openai') {
            $env:OPENAI_API_KEY = $apiKey
        } elseif ($provider -eq 'glm') {
            $env:GLM_API_KEY = $apiKey
        }
        $env:LLM_API_KEY = $apiKey
        $env:ENABLE_LLM_AUTO_PARSER = 'true'
        Write-Host "[OK] Yapay zeka destegi aktif ($provider)." -ForegroundColor Green
    } else {
        Write-Host "[UYARI] API Key bos birakildi; LLM Auto-Parser pasif kalacak." -ForegroundColor Yellow
    }
}

# --- 4. Kurulum tipi seçimi ---
Write-Host ""
Write-Host "Kurulum tipi secin:"
Write-Host "  [1] Deneme / gelistirme: sunucuyu simdi baslat (http://localhost:8888)"
Write-Host "  [2] Windows servisi olarak kur (onerilen - bilgisayar acilinca otomatik baslar)"
Write-Host "  [3] Cikis (yalnizca dosyalari birak)"
$secim = Read-Host "Seciminiz (1/2/3)"

switch ($secim) {
    '1' {
        Write-Host ""
        Write-Host "Sunucu baslatiliyor... Durdurmak icin Ctrl+C." -ForegroundColor Cyan
        Write-Host "Tarayicida acin: http://localhost:8888"
        Push-Location $root
        npm start
        Pop-Location
    }
    '2' {
        # Eski kurulum varsa node-windows yeni ayarlari uygulamaz; once kaldirilmali
        $mevcutServis = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*efaturaarsiv*' -or $_.DisplayName -like '*EFaturaArsiv*' }
        if ($mevcutServis) {
            Write-Host ""
            Write-Host "[UYARI] EFaturaArsivServisi zaten kurulu (durum: $($mevcutServis[0].Status))." -ForegroundColor Yellow
            Write-Host "Ayar degistirmek veya guncellemek icin once kaldirilmasi gerekir."
            $kaldir = Read-Host "Mevcut servis kaldirilip yeni ayarlarla kurulsun mu? (E/h)"
            if ($kaldir -eq 'h' -or $kaldir -eq 'H') {
                Write-Host "Mevcut servis degistirilmedi; kurulum iptal edildi."
                break
            }
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
                Write-Host "[HATA] Eski servis kaldirilamadi." -ForegroundColor Red
                exit 1
            }
            Write-Host "[OK] Eski servis kaldirildi." -ForegroundColor Green
        }
        Write-Host ""
        Write-Host "Servis kurum agina acik kurulur (HOST=0.0.0.0)." -ForegroundColor Yellow
        Write-Host "Agdaki diger bilgisayarlar erisebilecegi icin panel parolasi onerilir."
        $parolaIste = Read-Host "Panel parolasi belirlensin mi? (E/h)"
        if ($parolaIste -ne 'h' -and $parolaIste -ne 'H') {
            $env:PANEL_USER = Read-Host "Kullanici adi"
            $env:PANEL_PASS = Read-Host "Parola"
        }
        Write-Host ""
        Write-Host "Gizli yol: belirlenirse panel adresi gizlenir; paneli yalnizca"
        Write-Host "http://<adres>/<gizli-yol> adresini bir kez ziyaret edenler gorebilir."
        $gizliYol = Read-Host "Gizli yol belirleyin (bos birakirsaniz ozellik kapali kalir)"
        if ($gizliYol) { $env:SECRET_PATH = $gizliYol }
        $sadeceYerel = Read-Host "Yalnizca bu bilgisayardan erisim olsun mu? (e/H)"
        if ($sadeceYerel -eq 'e' -or $sadeceYerel -eq 'E') { $env:HOST = '127.0.0.1' }
        Push-Location $root
        npm run service:install
        Pop-Location
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "[OK] Servis kuruldu. Panel: http://localhost:8888" -ForegroundColor Green
            $ipler = @()
            if ($env:HOST -ne '127.0.0.1') {
                $ipler = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
                    Select-Object -ExpandProperty IPAddress)
                foreach ($ip in $ipler) { Write-Host "Agdaki diger bilgisayarlar: http://${ip}:8888" }
            }
            if ($env:SECRET_PATH) {
                Write-Host "Gizli yol aktif - panele ilk erisim (tarayici basina bir kez):" -ForegroundColor Yellow
                Write-Host "  bu bilgisayardan : http://localhost:8888/$($env:SECRET_PATH)"
                foreach ($ip in $ipler) { Write-Host "  agdaki digerleri : http://${ip}:8888/$($env:SECRET_PATH)" }
                Write-Host "Bu adresleri not edin; ziyaret etmeyen tarayicilar 404 gorur."
            }
            Write-Host "Kaldirmak icin: KALDIR.bat (verilere dokunmaz)"
        } else {
            Write-Host "[HATA] Servis kurulumu basarisiz. Ayrintilar yukarida." -ForegroundColor Red
            exit 1
        }
    }
    default {
        Write-Host ""
        Write-Host "Kurulum tamamlandi (servis kurulmadi)." -ForegroundColor Green
        Write-Host "Baslatmak icin bu klasorde: npm start"
    }
}

Write-Host ""
Write-Host "Sonraki adimlar KURULUM.md dosyasinda: PDF ice aktarma, otomatik yedek, otomatik ingest."
