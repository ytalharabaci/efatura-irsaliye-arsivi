# e-Fatura / e-İrsaliye Arşivi

[![CI](https://github.com/yusufarbc/efatura-irsaliye-arsivi/actions/workflows/ci.yml/badge.svg)](https://github.com/yusufarbc/efatura-irsaliye-arsivi/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yusufarbc/efatura-irsaliye-arsivi)](https://github.com/yusufarbc/efatura-irsaliye-arsivi/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

OCR kullanmadan e-Fatura ve e-İrsaliye PDF'lerini (GİB resmi "yazdırılabilir
görünüm" formatı) parse edip SQLite veritabanına kaydeden, web arayüzünden
sorgulanabilen muhasebe belge arşivi sistemi. Panel varsayılan olarak
**read-only** çalışır; hatalı parse'ları düzeltmek için açılıp kapatılabilen
bir **Düzenleme Modu** vardır.

## Neden OCR yok?

GİB'in e-Fatura/e-İrsaliye PDF'leri taranmış görüntü değildir — UBL-TR XML'den
render edilmiş, metin katmanı (text layer) gömülü PDF'lerdir. Bu yüzden karakterler
`pdftotext -layout` (poppler-utils) ile doğrudan ve güvenilir şekilde çıkarılabilir.
OCR (Tesseract vb.) hem gereksizdir hem de daha hataya açık bir yaklaşım olurdu.

## Özellikler

- PDF metin katmanından (OCR'sız) başlık ve kalem (satır) bilgisi çıkarma
- Farklı e-fatura entegratörlerinin (Logo, Mikro, Foriba, Nilvera, QNB eFinans vb.)
  şablon farklılıklarına uyum sağlayan adapter tabanlı parser mimarisi
- Kalem toplamlarının fatura geneliyle tutarlılık kontrolü (otomatik doğrulama)
- Toplu (batch) PDF işleme — bir klasördeki yüzlerce belgeyi tek seferde içe aktarma
- Panelden PDF yükleme: **PDF Yükle** sekmesine sürükle-bırak ile tek/çoklu
  belge yüklenir, aynı parse hattından geçip sonucu (başarılı/şüpheli/hatalı/
  tanınmayan) anında gösterilir; dosyalar `data/uploads/` altında saklanır
- SQLite veritabanı, sorgulanabilir yapı (belge no, tarih, satıcı/alıcı, ürün/hizmet
  açıklaması bazlı arama; Türkçe harf duyarsız — "güvenlik" araması "GÜVENLİK"i bulur)
- Web arayüzü varsayılan olarak **read-only**; sağ üstteki **Düzenleme Modu**
  açıldığında hatalı parse'lar panelden düzeltilebilir:
  - Belge başlığı alanlarını güncelleme (belge no, tarihler, tutarlar, parse durumu…)
  - Kalem ekleme / düzenleme / silme, belge silme
  - Taraf (satıcı/alıcı) bilgisi düzeltme — o tarafın geçtiği tüm belgelere yansır
  - **Yeniden Doğrula**: düzeltme sonrası kalem toplamlarının başlıkla tutup
    tutmadığını kontrol edip parse durumunu günceller
- **Yapay Zeka (LLM Auto-Parser) & KVKK Maskeleme**: Tanınmayan/bilinmeyen e-fatura şablonlarıyla karşılaşıldığında, TCKN/VKN/Adres gibi hassas veriler KVKK maskelemesinden geçirilerek LLM (DeepSeek / GLM / OpenAI) vasıtasıyla o şablona özel bir JavaScript extractor kütüphanesi üretilir ve sunucuya yerel olarak kaydedilir.
- **Akıllı Fallback (Smart Fallback) Mimarisi**: Şablon ayrıştırma jenerasyonunda ilk aşamada süper hızlı `deepseek-v4-flash` (~1-2s) çalıştırılır; karmaşık şablonlarda veya yetersizlikte otomatik olarak derin muhakeme yapan `deepseek-v4-pro` modeline geçilir.
- **Net Satır Maliyeti & İskonto Bazlı Kâr Hesaplaması**: Kâr marjı ve Satış Fiyatı hesaplamaları ham birim fiyattan değil, mali standartlara uygun olarak **Net Satır Maliyeti** ($[Miktar \times Birim Fiyat] - İskonto$) üzerinden hesaplanır.
- **Web Arayüzü İbareleri & AI Rozetleri**: Yapay Zeka ile parse edilmiş belgeler panellerde mor `🤖 AI Parser` rozeti ve özel bilgilendirme kartlarıyla işaretlenir.
- **Kar Oranı**: sağ üstten girilen yüzde, net birim maliyetinin yanında hesaplanmış **Satış Fiyatı (KDV Dahil)** sütunu olarak kalem listelerinde ve belge detayında gösterilir; tercih tarayıcıda saklanır, veritabanına yazılmaz

## Güvenlik notları

- Sunucu varsayılan olarak yalnızca `127.0.0.1`'e bağlanır (DB kişisel veri
  içerir). Ağdaki başka makinelere açmak bilinçli bir tercih olmalı:
  `HOST=0.0.0.0 npm start` (Windows servisi ise varsayılan olarak ağa açık
  kurulur — bkz. Deployment).
- `PANEL_USER` + `PANEL_PASS` ortam değişkenleri ayarlanırsa panel HTTP Basic
  Auth ile parola ister — ağa açık kurulumda önerilir.
- `SECRET_PATH` ortam değişkeni ayarlanırsa panel gizlenir: yetki çerezi
  olmayan tüm istekler 404 alır; panele ilk erişim `http://<adres>/<SECRET_PATH>`
  ziyaretiyle yapılır (30 gün geçerli çerez verilip ana sayfaya yönlendirilir).
  Bu bir gizleme katmanıdır, kimlik doğrulama yerine geçmez — ağa açık
  kurulumda `PANEL_USER`/`PANEL_PASS` ile birlikte kullanın.
- Yazma isteklerinde same-origin (CSRF) kontrolü yapılır; tüm yazma alanları
  whitelist + tip doğrulamasından geçer.
- Arama girdilerindeki `%`/`_` LIKE joker karakterleri etkisizleştirilir.

## Teknoloji

- **Node.js 22.5+** + **Express** (backend API)
- **node:sqlite** — Node.js built-in SQLite (sıfır native bağımlılık, C++ build gerekmez)
- **poppler-utils** / `pdftotext -layout` (PDF metin çıkarma, OCR yok)
- Vanilla HTML + CSS + JS (framework'süz frontend)

## Kurulum

### Windows — hazır kurulum paketi (önerilen)

1. [Son sürümü indirin](https://github.com/yusufarbc/efatura-irsaliye-arsivi/releases/latest)
   (`efatura-irsaliye-arsivi-*-windows.zip`) — tüm bağımlılıklar pakete dahildir.
2. Kalıcı bir klasöre çıkarın (ör. `C:\EFaturaArsivi`).
3. **`KUR.bat`** dosyasına çift tıklayın; sihirbaz ön koşulları (Node.js,
   poppler) denetler ve isterseniz Windows servisi olarak kurar.

Ayrıntılar paketteki `KURULUM.md` dosyasındadır.

### Kaynaktan kurulum

```bash
# 1. Node.js 22.5+ gereklidir (node:sqlite için)
node --version

# 2. poppler-utils (pdftotext için)
#    Ubuntu/Debian:
sudo apt install poppler-utils
#    Windows: https://github.com/oschwartz10612/poppler-windows/releases
#    → C:\poppler\ konumuna çıkart, PATH'e ekle

# 3. Bağımlılıkları yükle (sadece express)
npm install
```

## Kullanım

```bash
# Tek PDF içe aktar
npm run ingest -- --file fatura.pdf

# Klasördeki tüm PDF'leri içe aktar
npm run ingest -- --dir ./belgeler

# Önce denemek istersen (DB'ye yazmadan)
npm run ingest -- --dir ./belgeler --dry-run

# Web arayüzünü başlat → http://localhost:8888
npm start
```

## Deployment (Windows servis + kurum ağı + OneDrive yedeği)

### 1. Servis kurulumu

Web sunucusunun bilgisayar her açıldığında otomatik başlaması için
`node-windows` ile Windows Service olarak kaydedilir. Normal (yükseltilmemiş)
bir terminalden çalıştırılabilir — kurulum kendini **tek bir UAC onayıyla**
yönetici olarak yeniden başlatır:

```powershell
# Kurum ağına açık + parola korumalı kurulum (önerilen)
$env:PANEL_USER='muhasebe'; $env:PANEL_PASS='guclu-bir-parola'
npm run service:install

# İsteğe bağlı: paneli gizli yolun arkasına al (bkz. Güvenlik notları)
$env:SECRET_PATH='benim-gizli-yolum'
npm run service:install

# Servisi kaldır (ayar değiştirmek için önce kaldırıp yeniden kurun)
npm run service:uninstall
```

Servis varsayılan olarak `HOST=0.0.0.0` ile kurulur — kurum ağındaki diğer
bilgisayarlar `http://<bu-makinenin-ip'si>:8888` adresinden erişir. Yalnızca
bu makineden erişim istenirse: `$env:HOST='127.0.0.1'; npm run service:install`.
Farklı port: `$env:PORT='3001'`.

> Not: geliştirme modu (`npm start`) güvenli varsayılanla yalnızca
> 127.0.0.1'i dinler; ağa açılmak servise (veya `HOST` değişkenine) özeldir.

### 2. Güvenlik duvarı (otomatik)

Ağa açık kurulumda (`HOST=0.0.0.0`), yalnızca **yerel alt ağa** izin veren
güvenlik duvarı kuralı (`EFaturaArsivi`, TCP 8888) kurulum sırasında otomatik
eklenir; `service:uninstall` ile birlikte kaldırılır. Elle eklemek gerekirse:

```powershell
netsh advfirewall firewall add rule name="EFaturaArsivi" dir=in action=allow protocol=TCP localport=8888 remoteip=localsubnet
```

### 3. OneDrive yedeği

Canlı `data/arsiv.sqlite` dosyasını doğrudan OneDrive klasörüne koymayın:
WAL modunda verinin bir kısmı `-wal` dosyasındadır, OneDrive yazma sırasında
senkronlarsa yedek bozuk olur ve dosya kilitleri "database is locked"
hatalarına yol açar. Bunun yerine zamanlanmış görev, SQLite'ın kendi
mekanizmasıyla (`VACUUM INTO`) tutarlı bir anlık görüntüyü
`%OneDrive%\EFaturaArsivYedek` klasörüne yazar; OneDrive da onu buluta
senkronlar:

```powershell
# Her gün 21:00'de yedek görevi kur (varsayılan 14 yedek tutulur, eskiler silinir)
npm run task:install-backup

# Farklı saat: $env:BACKUP_TIME='23:30'; npm run task:install-backup
# Elle yedek almak için: npm run backup
# Görevi kaldır: npm run task:uninstall-backup
```

### 4. Otomatik ingest (opsiyonel)

`ingestRunner.js`'i her gün belirli bir saatte otomatik çalıştırmak için
Windows Görev Zamanlayıcı'ya (Task Scheduler) bir görev eklenebilir — bu
sürekli çalışan bir servis değil, periyodik bir toplu iştir:

```powershell
# Varsayılan: her gün 07:00, ./belgeler klasörü
npm run task:install-ingest

# Farklı klasör/saat ile
$env:INGEST_DIR="D:\belgeler"; $env:INGEST_TIME="23:00"; npm run task:install-ingest

# Kaldırmak için
npm run task:uninstall-ingest
```

## Proje Yapısı

Detaylı mimari, veritabanı şeması ve geliştirme yol haritası için bkz.
[`PROJECT_SPEC.md`](./PROJECT_SPEC.md).

## Katkı

Katkılar memnuniyetle karşılanır — özellikle yeni entegratör şablonları
(extractor). Başlamak için [`CONTRIBUTING.md`](./CONTRIBUTING.md)'ye,
güvenlik açığı bildirimi için [`SECURITY.md`](./SECURITY.md)'ye bakın.

## Lisans

MIT — bkz. [`LICENSE`](./LICENSE).

## KVKK notu

Bu sistem KVKK kapsamında kişisel veri (VKN/TCKN, ad-soyad, adres vb.) işler.
Veritabanı ve belge klasörleri depoya dahil edilmez (`.gitignore`); katkılarda
gerçek kişisel veri içeren örnek/test belgeleri kullanmayın — fixture'lar
maskelenmiş olmalıdır.
