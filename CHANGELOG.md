# Changelog

Bu projedeki dikkate değer değişiklikler bu dosyada belgelenir.

Biçim [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) standardına,
sürümleme [Semantic Versioning](https://semver.org/lang/tr/) kurallarına uyar.

## [1.3.0] - 2026-07-06

### Eklendi

- **Parser, GİB şablonunun entegratör varyasyonlarını tanıyor** (gerçek
  örnek faturalarla doğrulandı — pazaryeri, telekom ve eLogo çıkışlı):
  - "e-Arşiv Fatura" başlıklı belgeler (yalnızca "e-FATURA" değil)
  - İki nokta üst üste olmayan etiketler ("Fatura No  EAR2026…")
  - "Fatura Tarihi" etiketi ve "09 - 05 - 2026" gibi boşluklu tarihler
  - Bitişik sayı-birim yazımı ("1,0Adet 183,21TL", "% 20,00")
  - "Mal / Hizmet Toplam Tutarı" (bölü işaretli) toplam etiketleri
  - Birimsiz kalem satırları; sütun taşmasıyla bölünen tutar sütunu
    (tutar miktar × birim fiyattan hesaplanır)
  - Kalem satırındaki satır içi açıklama/stok kodu artık açıklamaya dahil

### Düzeltildi

- Satıcı/alıcı VKN-TCKN ayrımı artık konuma göre (SAYIN öncesi satıcı,
  sonrası alıcı): kurumsal satıcı + şahıs alıcı faturalarında iki taraf
  ters atanıyordu
- Boş "Vergi Dairesi:" etiketi sağ sütundaki metni değer sanmıyor
- Alıcı adı iki kez basılan şablonlarda unvan tekrarlanmıyor
- Adres satırındaki "No:74" gibi ifadeler kalem tablosu başlığı sanılıp
  açıklamaya sayfa başlığının karışmasına yol açıyordu
- Kök dizindeki deneme PDF'leri `.gitignore`'a eklendi (kişisel veri
  içeren gerçek faturalar yanlışlıkla commit'lenmesin)

## [1.2.0] - 2026-07-06

### Eklendi

- **`KALDIR.bat` kaldırma aracı**: kurulu bileşenleri (Windows servisi,
  otomatik ingest/yedek görevleri) tespit eder, onayla kaldırır. Verilere
  dokunmaz — veritabanı ve PDF'ler `data\` klasöründe aynen kalır. Paket
  zip'ine dahil edilir; KURULUM.md'nin Kaldırma bölümü buna göre güncellendi

## [1.1.2] - 2026-07-06

### Değişti

- **Satış Fiyatı** sütunu tabloların en sağına taşındı ve kayıtlı veri
  olmadığı görünümünden anlaşılsın diye ayrı zemin/ayırıcıyla vurgulandı
  (değer tarayıcıda kar oranından anlık hesaplanır, veritabanında yoktur)

### Düzeltildi

- Kurulum sihirbazı: servis zaten kuruluyken kurulum başarısız olduğu halde
  "[OK] Servis kuruldu" deniyordu; artık mevcut servis algılanıp onayla
  kaldırılıyor ve yeni ayarlarla kuruluyor (güncelleme akışı)
- `service:install` servis zaten kuruluysa artık hata koduyla çıkıyor
- Ağa açık kurulumda erişim ve gizli yol adresleri `localhost` yerine
  makinenin gerçek IP'leriyle gösteriliyor
- KURULUM.md'ye "Güncelleme (yeni sürüme geçiş)" bölümü eklendi

## [1.1.1] - 2026-07-06

### Düzeltildi

- `SECRET_PATH` artık Windows servis kurulumunda da destekleniyor: kurulum
  sihirbazı (`KUR.bat`) gizli yolu soruyor, `service:install` değişkeni
  servise gömüyor (1.1.0'da yalnızca `npm start` ile çalışıyordu)

## [1.1.0] - 2026-07-06

### Eklendi

- **Kar Oranı**: panelin sağ üstünden girilen yüzde ile kalem listelerinde ve
  belge detayında hesaplanmış **Satış Fiyatı** sütunu gösterilir; tercih
  tarayıcıda (localStorage) saklanır, veritabanına yazılmaz
- **Gizli yol (`SECRET_PATH`)**: opsiyonel gizleme katmanı — ayarlanırsa yetki
  çerezi olmayan tüm istekler 404 alır; panele ilk erişim
  `/<SECRET_PATH>` ziyaretiyle yapılır ve 30 gün geçerli, gizli yoldan
  türetilmiş (SHA-256) HttpOnly çerez verilir. Kimlik doğrulama yerine geçmez;
  ağa açık kurulumda `PANEL_USER`/`PANEL_PASS` ile birlikte önerilir

## [1.0.0] - 2026-07-05

İlk kararlı sürüm. 🎉

### Eklendi

- **Ingest hattı**: GİB e-Fatura/e-İrsaliye PDF'lerini (resmi "yazdırılabilir
  görünüm") `pdftotext -layout` ile OCR'sız parse etme; tek dosya, klasör
  (batch) ve `--dry-run` modları
- **Adapter tabanlı parser mimarisi**: farklı e-fatura entegratörlerinin
  (Logo, Mikro, Foriba, Nilvera, QNB eFinans vb.) şablon farklılıklarına uyum
- **Otomatik doğrulama**: kalem toplamlarının fatura başlığıyla tutarlılık
  kontrolü; BAŞARILI / ŞÜPHELİ / HATALI parse durumları
- **SQLite veritabanı** (`node:sqlite`, sıfır native bağımlılık) + migration
  altyapısı
- **REST API** (Express): belge listeleme/arama/detay, kalem araması, taraf
  (satıcı/alıcı) yönetimi, CRUD uçları
- **Web arayüzü** (framework'süz): Türkçe harf duyarsız arama, gözden geçirme
  kuyruğu, sürükle-bırak **PDF Yükle** sekmesi, açılıp kapatılabilen
  **Düzenleme Modu** (varsayılan read-only)
- **Güvenlik**: varsayılan `127.0.0.1` bind, opsiyonel HTTP Basic Auth
  (`PANEL_USER`/`PANEL_PASS`), same-origin (CSRF) kontrolü, girdi
  doğrulama/whitelist, LIKE joker etkisizleştirme
- **Windows deployment**: `node-windows` ile servis kurulumu (tek UAC onayı),
  otomatik güvenlik duvarı kuralı, Görev Zamanlayıcı ile otomatik ingest ve
  `VACUUM INTO` tabanlı OneDrive yedeği
- **Windows kurulum paketi**: sürüm eklerinde yayınlanan, bağımlılıkları
  paketlenmiş zip + etkileşimli kurulum sihirbazı (`KUR.bat`)

[1.3.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/releases/tag/v1.0.0
