'use strict';

// Deterministik doğruluk kaynakları: GİB karekodu (QR) ve PDF'e gömülü
// UBL-TR XML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseQrPayload, qrToHeader, mergeQrIntoHeader, findQrForSegment, readPdfQrs } = require('../src/ingest/qrReader');
const { ublToResult, parseXml, readEmbeddedUbl } = require('../src/ingest/embeddedXml');
const { extract } = require('../src/ingest/extractors/gibStandardInvoice');
const { validateDocument } = require('../src/ingest/validate');

const QR_METNI = JSON.stringify({
  vkntckn: '12345678901',
  avkntckn: '1234567890',
  senaryo: 'TICARIFATURA',
  tip: 'SATIS',
  tarih: '2026-06-30',
  no: 'RF02026000000007',
  ettn: 'A1B2C3D4-E5F6-47A8-9B0C-D1E2F3A4B5C6',
  parabirimi: 'TRY',
  malhizmettoplam: '15000.00',
  'kdvmatrah(20)': '15000.00',
  'hesaplanankdv(20)': '3000.00',
  vergidahil: '18000.00',
  odenecek: '18000.00',
});

test('QR: GİB karekod JSON\'u başlık alanlarına çevrilir', () => {
  const qr = parseQrPayload(QR_METNI);
  const { header, paraBirimi } = qrToHeader(qr);
  assert.equal(paraBirimi, 'TRY');
  assert.equal(header.belge_no, 'RF02026000000007');
  assert.equal(header.ettn, 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6');
  assert.equal(header.satici_vkn_tckn, '12345678901');
  assert.equal(header.duzenleme_tarihi, '2026-06-30');
  assert.equal(header.mal_hizmet_toplam_tutari, 15000);
  assert.equal(header.hesaplanan_kdv_toplam, 3000);
  assert.equal(header.odenecek_tutar, 18000);
});

test('QR: birden çok KDV oranı toplanır; TR biçimli sayı ve tarih kabul edilir', () => {
  const qr = parseQrPayload(JSON.stringify({
    no: 'X', ettn: 'e', tarih: '30.06.2026', 'hesaplanankdv(20)': '100,00', 'hesaplanankdv(10)': '5,50',
  }));
  const { header } = qrToHeader(qr);
  assert.equal(header.hesaplanan_kdv_toplam, 105.5);
  assert.equal(header.duzenleme_tarihi, '2026-06-30');
});

test('QR: fatura karekodu olmayan içerik yok sayılır', () => {
  assert.equal(parseQrPayload('https://example.com'), null);
  assert.equal(parseQrPayload('{"foo":1}'), null);
});

test('QR birleştirme: çelişen alan karekoda göre düzeltilir, boş alan doldurulur', () => {
  const metin = fs.readFileSync(path.join(__dirname, 'fixtures', 'gib_standard_invoice_sample.txt'), 'utf8');
  const sonuc = extract(metin);
  const { header: qrHeader } = qrToHeader(parseQrPayload(QR_METNI));
  // Extractor'ın yanlış okuduğu bir alanı ve boş bir alanı taklit et
  const bozuk = { ...sonuc.header, odenecek_tutar: 1800, duzenleme_zamani: null, belge_no: null };
  const { header, notlar } = mergeQrIntoHeader(bozuk, qrHeader);
  assert.equal(header.odenecek_tutar, 18000);
  assert.equal(header.belge_no, 'RF02026000000007');
  assert.ok(notlar.some((n) => n.includes('odenecek_tutar düzeltildi')));
  assert.ok(notlar.some((n) => n.includes('belge_no dolduruldu')));
  assert.equal(validateDocument(header, sonuc.items).durum, 'BASARILI');
});

test('QR eşleştirme: segment ETTN veya belge no ile bulunur', () => {
  const q1 = { header: { ettn: 'aaa', belge_no: 'N1' } };
  const q2 = { header: { ettn: 'bbb', belge_no: 'N2' } };
  assert.equal(findQrForSegment([q1, q2], 'ETTN: BBB', false), q2);
  assert.equal(findQrForSegment([q1, q2], 'Fatura No: N1', false), q1);
  assert.equal(findQrForSegment([q1, q2], 'kimliksiz', false), null);
  assert.equal(findQrForSegment([q1], 'kimliksiz', true), q1);
});

test('QR / XML: okunamayan dosyada sessizce boş döner', async () => {
  assert.deepEqual(await readPdfQrs(path.join(__dirname, 'yok.pdf')), []);
  assert.deepEqual(await readEmbeddedUbl(path.join(__dirname, 'yok.pdf')), []);
});

const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>ABC2026000000042</cbc:ID>
  <cbc:UUID>F47AC10B-58CC-4372-A567-0E02B2C3D479</cbc:UUID>
  <cbc:IssueDate>2026-05-09</cbc:IssueDate>
  <cbc:IssueTime>18:31:00.0000000+03:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:Note>Yalnız: Bin İki Yüz TL</cbc:Note>
  <!-- satıcı -->
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="MERSISNO">0111</cbc:ID></cac:PartyIdentification>
    <cac:PartyIdentification><cbc:ID schemeID="VKN">1234567890</cbc:ID></cac:PartyIdentification>
    <cac:PartyName><cbc:Name>Örnek Yazılım A.Ş. &amp; Ortakları</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Örnek Cad.</cbc:StreetName><cbc:BuildingNumber>5</cbc:BuildingNumber>
      <cbc:CitySubdivisionName>Kadıköy</cbc:CitySubdivisionName><cbc:CityName>İstanbul</cbc:CityName>
      <cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>Kadıköy</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:Contact><cbc:Telephone>02160000000</cbc:Telephone><cbc:ElectronicMail>info@ornek.example</cbc:ElectronicMail></cac:Contact>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="TCKN">10000000146</cbc:ID></cac:PartyIdentification>
    <cac:Person><cbc:FirstName>Ali</cbc:FirstName><cbc:FamilyName>Veli</cbc:FamilyName></cac:Person>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="TRY">200.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="TRY">1000.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="TRY">200.00</cbc:TaxAmount>
      <cbc:Percent>20</cbc:Percent><cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="TRY">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">1200.00</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="TRY">0.00</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="TRY">1200.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">4</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">1000.00</cbc:LineExtensionAmount>
    <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:MultiplierFactorNumeric>0.0</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="TRY">0</cbc:Amount></cac:AllowanceCharge>
    <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">200.00</cbc:TaxAmount>
      <cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">200.00</cbc:TaxAmount><cbc:Percent>20</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
    <cac:Item><cbc:Name><![CDATA[Klavye <USB>]]></cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">250.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

test('UBL-TR: XML ağacı ad alanı önekleri atılarak kurulur', () => {
  const doc = parseXml(UBL);
  assert.equal(doc.name, 'Invoice');
  assert.ok(doc.children.some((c) => c.name === 'InvoiceLine'));
});

test('UBL-TR: fatura başlık ve kalemleri resmi XML\'den okunur', () => {
  const { header, items } = ublToResult(UBL);
  assert.equal(header.belge_tipi, 'FATURA');
  assert.equal(header.belge_no, 'ABC2026000000042');
  assert.equal(header.ettn, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
  assert.equal(header.senaryo, 'TICARIFATURA');
  assert.equal(header.fatura_tipi, 'SATIS');
  assert.equal(header.duzenleme_tarihi, '2026-05-09');
  assert.equal(header.duzenleme_zamani, '18:31:00');
  assert.equal(header.satici_unvan, 'Örnek Yazılım A.Ş. & Ortakları');
  assert.equal(header.satici_vkn_tckn, '1234567890');
  assert.equal(header.satici_vergi_dairesi, 'Kadıköy');
  assert.match(header.satici_adres, /Örnek Cad\. No:5 Kadıköy İstanbul Türkiye/);
  assert.equal(header.satici_eposta, 'info@ornek.example');
  assert.equal(header.alici_unvan, 'Ali Veli');
  assert.equal(header.alici_vkn_tckn, '10000000146');
  assert.equal(header.mal_hizmet_toplam_tutari, 1000);
  assert.equal(header.hesaplanan_kdv_toplam, 200);
  assert.equal(header.vergiler_dahil_toplam_tutar, 1200);
  assert.equal(header.odenecek_tutar, 1200);
  assert.equal(header.notlar, 'Yalnız: Bin İki Yüz TL');

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    sira_no: 1, aciklama: 'Klavye <USB>', miktar: 4, birim: 'Adet', birim_fiyat: 250,
    iskonto_orani: 0, iskonto_tutari: 0, net_satir_tutari: 1000, kdv_orani: 20, kdv_tutari: 200,
    mal_hizmet_tutari: 1000,
  });

  const v = validateDocument(header, items);
  assert.equal(v.durum, 'BASARILI');
  assert.equal(v.skor, 100);
});

test('UBL-TR: fatura/irsaliye olmayan XML yok sayılır', () => {
  assert.equal(ublToResult('<?xml version="1.0"?><Catalog><Item/></Catalog>'), null);
});
