# e-Fatura / e-İrsaliye Arşivi — Windows Kurulum Rehberi

Bu paket, uygulamayı ve tüm Node.js bağımlılıklarını içerir — internet
bağlantısı yalnızca ön koşulları (Node.js, poppler) indirmek için gerekir.

## Ön koşullar

1. **Node.js 22.5 veya üstü** — <https://nodejs.org/> (LTS önerilir)
2. **poppler-windows** (PDF metin çıkarma için `pdftotext`):
   - <https://github.com/oschwartz10612/poppler-windows/releases> adresinden
     son sürümü indirin
   - `C:\poppler` konumuna çıkarın
   - `C:\poppler\Library\bin` klasörünü **PATH**'e ekleyin
     (Ayarlar → Sistem → Hakkında → Gelişmiş sistem ayarları → Ortam Değişkenleri)
   - Doğrulama: yeni bir terminalde `pdftotext -v`

> Not: Web arayüzü poppler olmadan da çalışır; poppler yalnızca PDF içe
> aktarma (ingest/yükleme) için gereklidir.

## Kurulum

1. Bu zip'i kalıcı bir klasöre çıkarın (ör. `C:\EFaturaArsivi`).
   *Servis kuracaksanız klasörü sonradan taşımayın.*
2. **`KUR.bat`** dosyasına çift tıklayın.
3. Sihirbaz ön koşulları denetler, **Yapay Zeka (DeepSeek / LLM API Key)** yapılandırmasını sorar ve ardından çalıştırma seçeneği sunar:
   - **Deneme**: sunucuyu hemen başlatır → <http://localhost:8888>
   - **Windows servisi** (önerilen): bilgisayar her açıldığında otomatik
     başlar. Tek bir UAC (yönetici) onayı ister; kurum ağına açık kurulumda
     panel parolası belirlemeniz önerilir. Güvenlik duvarı kuralı (yalnızca
     yerel alt ağ, TCP 8888) otomatik eklenir.

## İlk kullanım

```powershell
# Klasördeki tüm PDF'leri içe aktar
npm run ingest -- --dir "D:\belgeler"

# Önce denemek için (veritabanına yazmadan)
npm run ingest -- --dir "D:\belgeler" --dry-run
```

Ya da panel üzerinden: **PDF Yükle** sekmesine belgeleri sürükleyip bırakın.

## Opsiyonel otomasyonlar & Yapay Zeka (Auto-Parser)

```powershell
# Her gün 21:00'de OneDrive'a tutarlı veritabanı yedeği
npm run task:install-backup

# Her gün 07:00'de belirlenen klasörü otomatik içe aktar
$env:INGEST_DIR="D:\belgeler"; npm run task:install-ingest

# Yapay Zeka (LLM Auto-Parser) desteği (Tanınmayan PDF'lerde otomatik parser yazma)
$env:LLM_API_KEY="sk-f866f..."; $env:LLM_PROVIDER="deepseek"
npm run service:install
```

## Güncelleme (yeni sürüme geçiş)

Servis ayarları kurulum anında servise gömülür; sonradan değiştirmek veya
yeni sürüme geçmek için servis kaldırılıp yeniden kurulur:

1. Yeni sürüm zip'ini ayrı bir klasöre çıkarın (eski klasörün üzerine yazmayın).
2. `data\` klasörünü (veritabanı + PDF'ler) eski kurulumdan yeni klasöre kopyalayın.
3. Yeni klasörde `KUR.bat`'ı çalıştırın — servis zaten kuruluysa sihirbaz
   sorar ve onayınızla eskisini kaldırıp yenisini kurar.

> Not: `npm run service:uninstall` komutu, servisi **ilk kurduğunuz klasörden**
> çalıştırıldığında sorunsuz çalışır. Sihirbaz eski servisi kaldıramazsa eski
> kurulum klasöründe bu komutu çalıştırıp kurulumu tekrarlayın.

## Kaldırma

**`KALDIR.bat`** dosyasına çift tıklayın — kurulu bileşenleri (servis,
zamanlanmış görevler) bulur, onayınızı alıp kaldırır. **Verilerinize
dokunmaz**: veritabanı ve PDF'ler `data\` klasöründe aynen kalır.

Elle kaldırmayı tercih ederseniz:

```powershell
npm run service:uninstall      # Windows servisini ve güvenlik duvarı kuralını kaldırır
npm run task:uninstall-backup  # yedek görevini kaldırır
npm run task:uninstall-ingest  # ingest görevini kaldırır
```

Sonra klasörü silebilirsiniz. Verileriniz `data\` alt klasöründedir —
silmeden önce yedeklemeyi unutmayın.

## Sorun giderme

- **"node tanınmıyor"** → Node.js kurulu değil veya PATH'te yok; kurun ve
  terminali yeniden açın.
- **"pdftotext tanınmıyor"** → poppler PATH'e eklenmemiş (yukarıya bakın).
- **Panel açılmıyor** → `services.msc` içinde *EFaturaArsivServisi* durumunu
  denetleyin; loglar `src\server\daemon\` klasöründedir.
- **Ağdaki başka bilgisayardan erişilemiyor** → servisin ağa açık
  (`HOST=0.0.0.0`) kurulduğundan ve istemcinin aynı alt ağda olduğundan emin
  olun.

Daha fazla bilgi: <https://github.com/yusufarbc/efatura-irsaliye-arsivi>
