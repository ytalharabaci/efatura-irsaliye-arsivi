# Changelog

Bu projedeki dikkate değer değişiklikler bu dosyada belgelenir.

Biçim [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) standardına,
sürümleme [Semantic Versioning](https://semver.org/lang/tr/) kurallarına uyar.

## [Unreleased]

### Eklendi

- **Gömülü UBL-TR XML okuma** (`embeddedXml.js`): PDF'e eklenmiş fatura/irsaliye XML'i varsa alanlar doğrudan resmi XML'den okunur (bağımlılıksız XML ayrıştırıcı).
- **GİB karekodu (QR) doğrulaması** (`qrReader.js`, `jsqr` + `pngjs`): karekoddaki VKN, belge no, ETTN, tarih ve toplamlar başlıkla karşılaştırılır; boş alan doldurulur, çelişen alan karekoda göre düzeltilir ve parse notuna yazılır.
- **Güven skoru (0–100)** ve genişletilmiş doğrulama (`validate.js`, `schema.js`): tip/şema denetimi (yer tutucu değer → HATALI), kalem içi aritmetik, vergiler dahil toplam, VKN/TCKN kontrol basamağı, zorunlu alanlar.
- **`dispatchAll`**: tanıyan tüm extractor'lar çalıştırılır, en yüksek skor seçilir (önceden ilk eşleşen kazanıyordu).
- **Doğrulamalı LLM döngüsü** (`generateValidatedParser`): üretilen kod gerçek metin üzerinde yerelde test edilir; yetersizse PII'siz geri bildirimle en fazla `LLM_MAX_ATTEMPTS` tur düzeltme istenir; yalnız eşiği geçen parser kaydedilir.
- **Yerel LLM ile doğrudan JSON çıkarım** (`llmDirectExtract.js`, `LLM_DIRECT_EXTRACT=true`): yalnız localhost/yerel uç noktada çalışır.
- **Şablon parmak izi ve parser istatistikleri**: aynı şablon için tekrar LLM çağrılmaz; sürekli başarısız parser otomatik devre dışı kalır; başarısız şablon için bekleme süresi (`LLM_RETRY_COOLDOWN_HOURS`).
- **`npm run eval`**: fixture korpusunda alan bazlı doğruluk ölçümü ve CI regresyon testi.
- Adres (satıcı/alıcı), alıcı telefonu, alt satıra düşmüş e-posta ve büyük harfli `YALNIZ:` notu çıkarımı; TL dışı para birimleri.
- Web arayüzünde `📄 XML` / `▣ QR` kaynak rozetleri ve güven skoru.

### Değiştirildi

- **Sentetik maskeleme** (`anonymize.js`): `[MONEY_VAL]` gibi yer tutucular yerine değerler aynı biçimde sahte değerlerle değiştirilir, sütun düzeni birebir korunur; sözlük dışı etiketler tutarlı takma adla gönderilip üretilen kodda gerçeğine çevrilir; gönderim öncesi sızıntı denetimi.
- **Kalem açıklaması ataması** (`gibStandardInvoice.js`): iki kalem arasındaki metin satırları artık iki kaleme birden eklenmiyor; bölünmüş hücre artıkları, ürün kodu ve satır uzaklığı ipuçlarıyla tek kaleme atanıyor. Taşan birim hücresi kurtarılıyor.
- `parseTrDate` `GG.AA.YYYY` / `GG/AA/YYYY` biçimlerini ve takvim doğrulamasını destekliyor; `parseTrNumber` döviz soneklerini ve ondalık noktayı tanıyor.
- Dinamik parser'lar `data/extractors/` altında tutuluyor (`EXTRACTORS_DIR`); eski konumdakiler otomatik taşınır.

### Düzeltildi

- **LLM fallback hiç devreye girmiyordu**: parser kaydedildikten sonra yeniden dispatch edildiğinde statik extractor yine ilk sırada eşleştiği için LLM sonucu kullanılmıyordu; her ŞÜPHELİ belge diske yeni bir `dynamic_<zaman>.js` yazıyordu.
- **xpdf `pdftotext` ile Türkçe karakter kaybı**: `-enc UTF-8` eklendi; xpdf sürümü tespit edilirse uyarı verilir.
- `DELETE /api/extractors/dynamic/:name` silinen parser'ı bellekten çıkarmıyordu.

### Güvenlik

- Kişisel veri içeren, LLM tarafından üretilmiş iki dinamik extractor dosyası depodan kaldırıldı.
- LLM üretimi kod `node:vm` sandbox'ında çalışıyor (require/process/dosya erişimi yok, zaman aşımı); önceden tam Node yetkisiyle `require` ediliyordu.
- `POST /api/extractors/generate` artık istemciden `apiKey`/`baseUrl` kabul etmiyor; `provider`/`model` beyaz listeden.

## [1.6.0] - 2026-08-13

### Düzeltilder (Kritik)

- **`schema.sql` tamamen yeniden yazıldı** (taze kurulum sorunu):
  - `taraflar` tablosu `schema.sql`'e eksikti; taze kurulumda her ingest `no such table: taraflar` hatasıyla başarısız oluyordu.
  - `documents` tablosunda `satici_id`, `alici_id`, `toplam_iskonto`, `kdv_matrahi` kolonları eksikti.
  - `items` tablosunda `iskonto_orani`, `iskonto_tutari`, `net_satir_tutari` kolonları eksikti.
  - Taze kurulumda tüm tablo ve index'ler eksiksiz oluşturuluyor.
- **`POST /api/documents/:id/items` eksik kolon hatası düzeltildi**:
  - Yeni kalem ekleyen INSERT sorgusu `iskonto_orani`, `iskonto_tutari`, `net_satir_tutari` kolonlarını kapsıyor.
- **`extractors.js` `pdfPath` güvenlik açığı kapatıldı**:
  - İstemciden gelen `pdfPath` parametresi artık proje kökü içinde olup olmadığı ve `.pdf` uzantısı kontrol edilerek doğrulanıyor; path traversal saldırısı önleniyor.

### Düzeltilder

- **DeepSeek model adları düzeltildi** (`llmParserGenerator.js`):
  - Var olmayan `deepseek-v4-flash` / `deepseek-v4-pro` adları gerçek DeepSeek API model adları `deepseek-chat` / `deepseek-reasoner` ile değiştirildi.
  - Akllı Fallback: `deepseek-chat` başarısız kalursa `deepseek-reasoner` (R1) ile otomatik tekrar denemesi.
  - LLM Sistem Prompt’una `iskonto_orani`, `iskonto_tutari`, `net_satir_tutari` kalem alanları eklendi; LLM üretilen parser’lar artık iskonto bilgilerini de çıkarıyor.
- **Edit modunda iskonto hesabı düzeltiildi** (`app.js` — `kalemSatiri()`):
  - `birim_fiyat × (1 + kar%)` yerine `calculateSellingPrice()` kullanılıyor; iskonto ve net satır tutarları dikkate alınıyor.
- **`parseInt` radix hatası düzeltildi** (`documents_detail.js` satir 10).
- **`TANINMAYAN` durumda HTTP 200 semantik hatası düzeltildi** (`upload.js`):
  - Tanınmayan PDF yüklemesinde artık HTTP **422** dönüyor.
- **`dynamic_deepseek.js` prefix hatası düzeltildi**:
  - `deepseek.js` olarak kaydedilen dinamik extractor dosyası `dynamic_deepseek.js` olarak yeniden adlandırıldı.
- **Kurulum/kaldırma scriptleri düzeltildi**:
  - `ingest-task-uninstall.js` ve `backup-task-uninstall.js`: Görev kurulu değilken çökme yerine temiz çıkış yapıyor.
  - `kur.ps1` kurulum menüsündeki DeepSeek model adları güncellendi.
- **`app.js` banner metnindeki hardcoded "DeepSeek LLM" düzeltildi**: artık sağlayicıdan bağımsız "Yapay Zeka (LLM)" yazıyor.

## [1.5.5] - 2026-08-12

### Eklendi & İyileştirildi

- **Şüpheli / Hatalı Durumlarda Yapay Zeka (LLM Auto-Parser) Fallback Desteği**:
  - Statik parser'ların `SUPHELI` veya `HATALI` sonuç ürettiği şablonlarda Yapay Zeka (LLM Auto-Parser) otomatik tetiklenerek daha tutarlı/başarılı bir parser üretme ve belgeyi `BASARILI` duruma yükseltme imkanı eklendi.
- **Kalem Açıklamalarından Üstbilgi Metadata Temizliği (`gibStandardInvoice.js`)**:
  - e-Arşiv fatura şablonlarında satıcı adres ve başlık alanlarının (`Pazarlama Limited...`, `VKN:`, `Vergi Dairesi:`, `Senaryo:`, `Fatura Tarihi:` vb.) kalem 1 açıklamasına sızması engellendi.

## [1.5.4] - 2026-08-12

### Düzeltildi

- **Web Arayüzü PDF Yükleme Çökme Hatası Düzeltildi**:
  - `src/web/app.js` dosyasındaki `ReferenceError: dosyaAd is not defined` hatası giderildi (`f.name` referansıyla güncellendi).
- **Kurulum Sihirbazına Etkileşimli Yapay Zeka (DeepSeek / LLM API Key) Adımı Eklendi**:
  - `KUR.bat` / `kur.ps1` çalıştığında artık kullanıcıya Yapay Zeka (LLM Auto-Parser) sağlayıcısı (DeepSeek / OpenAI / GLM) ve API Key soruluyor.
  - `service-install.js` scripti `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `GLM_API_KEY` ve `LLM_PROVIDER` ortam değişkenlerini Windows Servisine otomatik olarak tanımlıyor.

### Eklendi

- **Otomatik Ön Yüz Testi ve Yayınlama Öncesi Doğrulama Güvencesi**:
  - `test/webApp.test.js` eklenerek `index.html` ve `app.js` dosyalarının statik, DOM ID ve değişken referans doğrulamaları `npm test` kapsamına alındı.
  - `package-win.ps1` paketleme scripti öncesine otomatik `npm test` kontrolü yerleştirilerek doğrulanmamış sürümlerin paketlenmesi engellendi.

## [1.5.3] - 2026-08-11

### Eklendi

- **Akıllı Fallback (Smart Fallback) Mimarisi (`deepseek-v4-flash` → `deepseek-v4-pro`)**:
  - Bilinmeyen fatura şablonları için ilk aşamada süper hızlı `deepseek-v4-flash` çalıştırılır (%95+ hız avantajı, ~1-2 saniye).
  - Üretilen koddaki sözdizim/doğrulama yetersiz kalırsa otomatik olarak derin analiz kabiliyetine sahip `deepseek-v4-pro` modeline düşülür.

## [1.5.2] - 2026-08-10

### Eklendi

- **Web Arayüzünde AI Auto-Parser Görsel İbareleri ve Rozetleri**:
  - Belgeler tablosunda ve Gözden Geçir sekmesinde AI ile parse edilmiş kayıtların yanında mor `🤖 AI Parser` rozeti gösterimi.
  - PDF Yükle sekmesinde Yapay Zeka Auto-Parser desteği aktif bilgilendirme kartı.
  - Belge Detay modalında AI Parser ile üretilmiş şablonlar için özel uyarı paneli.

## [1.5.1] - 2026-08-10

### Güncellendi

- **DeepSeek V4 Model İsimlendirmeleri**:
  - Legacy olan `deepseek-chat` ve `deepseek-reasoner` isimlendirmeleri güncel DeepSeek V4 modelleri (`deepseek-v4-flash` ve `deepseek-v4-pro`) ile güncellendi.

## [1.5.0] - 2026-08-10

### Eklendi

- **Dinamik LLM Parser Jeneratörü (Auto-Parser)**:
  - Tanınmayan e-fatura/e-irsaliye şablonlarında otomatik olarak LLM sunucusu çağrılarak o şablona özel yerel JavaScript extractor kütüphanesi üretilmesi ve diske kaydedilmesi.
- **KVKK Anonymizer (`src/ingest/anonymize.js`)**:
  - LLM API'sine kişisel/ticari veri sızmasını önlemek amacıyla TCKN, VKN, ETTN UUID, Fatura No, Vergi Dairesi, E-posta, Telefon, Tarih, Tutarlar ve Alıcı Unvan/Adres satırlarının `[VKN_TCKN]`, `[EPOSTA]` vb. biçimde maskelenmesi.
- **Net Satır Maliyeti & İskonto Bazlı Kâr Hesaplaması**:
  - DB şemasına `items.iskonto_orani`, `items.iskonto_tutari`, `items.net_satir_tutari` ve `documents.kdv_matrahi` sütunları eklendi (Migration `0003_iskonto_ve_matrah.sql`).
  - Kâr marjı ve Satış Fiyatı hesabı ticari maliyet standartlarına göre **Net Satır Maliyeti** ($[Miktar \times Birim Fiyat] - İskonto$) üzerinden yapılacak şekilde güncellendi.
- **REST API Endpoints (`/api/extractors`)**:
  - Dinamik parser'ları listeleme, silme ve el ile tetikleme endpoints.

## [1.4.1] - 2026-07-14

### Düzeltildi

- **Kelime içi boşluk artefaktları onarılıyor** ("HO RTUM" → "HORTUM"):
  `pdftotext -layout`, geniş harf aralıklı (kerning) fontlarda kelime
  içine boşluk sokuyordu. Aynı PDF'in `-raw` çıktısı referans alınarak
  bölünmüş kelimeler birleştiriliyor (`src/ingest/repairKerning.js`);
  gerçek boşluklara ve sayısal değerlere dokunulmaz. Unvan, vergi dairesi,
  notlar ve kalem açıklamalarına uygulanır.
- **Kalem araması boşluk duyarsız**: açıklamadaki ve aranan metindeki
  boşluklar atılarak da karşılaştırılıyor — daha önce işlenmiş bölünmüş
  kayıtlar ("HO RTUM") ve bitişik yazımlar da bulunur. (Arama zaten
  `tr_lower` ile Türkçe harf duyarsızdı.)

## [1.4.0] - 2026-07-14

### Eklendi

- **Tek PDF'te birden fazla e-Fatura desteği**: art arda eklenmiş faturalar
  içeren dosyalar sayfa (form feed) bazında belgelere ayrılır, her fatura
  ayrı kayıt olarak işlenir (`src/ingest/splitDocuments.js`). Kimliksiz
  taşma sayfaları (IBAN dipnotu vb.) ait oldukları belgede kalır; çok
  sayfalı tek fatura bölünmez. CLI çıktısı, `/api/upload` yanıtı
  (`belgeler` dizisi) ve panel yükleme tablosu belge başına sonuç gösterir.
- **İskonto sütunlu ticari fatura şablonu** (gerçek çok faturalı örnekle
  doğrulandı):
  - "SA YIN" gibi harf aralığı boşlukları, ":" ayraçlı toplam etiketleri
  - Birden çok "Hesaplanan KDV(%X)" satırı toplanır (çok oranlı faturalar)
  - Dikey hizalama bozulmasıyla komşu satırlara dağılan KDV/tutar hücreleri
    tamamlanır (eksik değer %oran üzerinden türetilir)
  - "Takım" ve "M" (metre) birimleri; birim hücresi alt satıra taşan
    kalemler ("80.000 / Adet")
  - Açıklama satırlarına karışan taşma hücreleri (yalnız sayı/TL sütunları)
    ayıklanır
- **`documents.toplam_iskonto` kolonu** (migration 0002): belge geneli
  iskonto saklanır; doğrulama, kalem tutarları iskontolu + başlık toplamı
  iskontosuz yazan şablonları artık ŞÜPHELİ saymaz.

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

[1.6.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.5.5...v1.6.0
[1.5.5]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.5.4...v1.5.5
[1.5.4]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/yusufarbc/efatura-irsaliye-arsivi/releases/tag/v1.0.0
