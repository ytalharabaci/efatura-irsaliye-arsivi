'use strict';

// Bazı entegratörler fatura PDF'ine belgenin UBL-TR XML'ini ek (embedded
// file) olarak koyar. XML varsa metin ayrıştırmaya hiç gerek kalmaz: alanlar
// doğrudan resmi belgeden okunur (en yüksek güven).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolvePopplerBin } = require('./pdfToText');

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Küçük, bağımlılıksız XML ağacı ayrıştırıcısı (UBL için yeterli: eleman,
// öznitelik, metin, CDATA; yorum/PI/DOCTYPE atlanır). Ad alanı önekleri
// atılır: "cbc:ID" → "ID".
// ---------------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function localName(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3]);
      }
      const node = { name: localName(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  return root.children[0] || null;
}

/** Yol boyunca (yerel adlarla) ilk eşleşen düğüm: child(n, 'AccountingSupplierParty', 'Party') */
function child(node, ...names) {
  let cur = node;
  for (const n of names) {
    if (!cur) return null;
    cur = cur.children.find((c) => c.name === n) || null;
  }
  return cur;
}

function children(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}

function text(node, ...names) {
  const n = names.length ? child(node, ...names) : node;
  const t = n ? n.text.trim() : '';
  return t || null;
}

function num(node, ...names) {
  const t = text(node, ...names);
  if (t == null) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// UN/ECE birim kodları → şablonlarda görülen Türkçe birim adları
const BIRIM_KODLARI = {
  C62: 'Adet', NIU: 'Adet', H87: 'Adet', KGM: 'Kg', GRM: 'Gram', LTR: 'Litre', MTR: 'Metre',
  MTK: 'm2', MTQ: 'm3', TNE: 'Ton', HUR: 'Saat', DAY: 'Gün', MON: 'Ay', BX: 'Kutu', PA: 'Paket', SET: 'Takım',
};

function partyFields(party) {
  if (!party) return {};
  let vkn = null;
  for (const pid of children(party, 'PartyIdentification')) {
    const idNode = child(pid, 'ID');
    const scheme = idNode?.attrs?.schemeID?.toUpperCase();
    if (scheme === 'VKN' || scheme === 'TCKN') { vkn = text(idNode); break; }
  }
  const kisi = child(party, 'Person');
  const kisiAdi = kisi ? [text(kisi, 'FirstName'), text(kisi, 'MiddleName'), text(kisi, 'FamilyName')].filter(Boolean).join(' ') : null;
  const adr = child(party, 'PostalAddress');
  const adres = adr
    ? [
      text(adr, 'StreetName'), text(adr, 'BuildingName'), text(adr, 'BuildingNumber') && `No:${text(adr, 'BuildingNumber')}`,
      text(adr, 'Room') && `D:${text(adr, 'Room')}`, text(adr, 'CitySubdivisionName'),
      [text(adr, 'PostalZone'), text(adr, 'CityName')].filter(Boolean).join(' '), text(adr, 'Country', 'Name'),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null
    : null;
  return {
    unvan: text(party, 'PartyName', 'Name') || kisiAdi,
    vkn_tckn: vkn,
    vergi_dairesi: text(party, 'PartyTaxScheme', 'TaxScheme', 'Name'),
    adres,
    eposta: text(party, 'Contact', 'ElectronicMail'),
    telefon: text(party, 'Contact', 'Telephone'),
  };
}

/** KDV (vergi kodu 0015) alt toplamlarından oran/tutar. */
function kdvFromTaxTotal(taxTotal) {
  let tutar = null;
  let oran = null;
  for (const sub of children(taxTotal, 'TaxSubtotal')) {
    const kod = text(sub, 'TaxCategory', 'TaxScheme', 'TaxTypeCode');
    if (kod && kod !== '0015') continue;
    tutar = (tutar ?? 0) + (num(sub, 'TaxAmount') ?? 0);
    oran = num(sub, 'Percent') ?? oran;
  }
  return { tutar: tutar == null ? null : Math.round(tutar * 100) / 100, oran };
}

/**
 * UBL-TR Invoice / DespatchAdvice XML'ini extractor sonucuna çevirir.
 * @returns {{ header: object, items: object[] } | null}
 */
function ublToResult(xml) {
  const doc = parseXml(xml);
  if (!doc || !['Invoice', 'DespatchAdvice'].includes(doc.name)) return null;
  const irsaliye = doc.name === 'DespatchAdvice';

  const satici = partyFields(child(doc, irsaliye ? 'DespatchSupplierParty' : 'AccountingSupplierParty', 'Party'));
  const alici = partyFields(child(doc, irsaliye ? 'DeliveryCustomerParty' : 'AccountingCustomerParty', 'Party'));
  const mt = child(doc, 'LegalMonetaryTotal');
  const zaman = text(doc, 'IssueTime');

  const kdvToplam = children(doc, 'TaxTotal').reduce((acc, tt) => {
    const k = kdvFromTaxTotal(tt).tutar;
    return k == null ? acc : (acc ?? 0) + k;
  }, null);

  const header = {
    belge_tipi: irsaliye ? 'IRSALIYE' : 'FATURA',
    belge_no: text(doc, 'ID'),
    ettn: text(doc, 'UUID')?.toLowerCase() ?? null,
    duzenleme_tarihi: text(doc, 'IssueDate'),
    duzenleme_zamani: zaman ? zaman.slice(0, 8) : null,
    senaryo: text(doc, 'ProfileID'),
    fatura_tipi: text(doc, irsaliye ? 'DespatchAdviceTypeCode' : 'InvoiceTypeCode'),
    satici_unvan: satici.unvan ?? null,
    satici_vkn_tckn: satici.vkn_tckn ?? null,
    satici_vergi_dairesi: satici.vergi_dairesi ?? null,
    satici_adres: satici.adres ?? null,
    satici_eposta: satici.eposta ?? null,
    satici_telefon: satici.telefon ?? null,
    alici_unvan: alici.unvan ?? null,
    alici_vkn_tckn: alici.vkn_tckn ?? null,
    alici_vergi_dairesi: alici.vergi_dairesi ?? null,
    alici_adres: alici.adres ?? null,
    alici_eposta: alici.eposta ?? null,
    alici_telefon: alici.telefon ?? null,
    mal_hizmet_toplam_tutari: num(mt, 'LineExtensionAmount'),
    toplam_iskonto: num(mt, 'AllowanceTotalAmount') ?? 0,
    kdv_matrahi: num(mt, 'TaxExclusiveAmount'),
    hesaplanan_kdv_toplam: kdvToplam,
    vergiler_dahil_toplam_tutar: num(mt, 'TaxInclusiveAmount'),
    odenecek_tutar: num(mt, 'PayableAmount'),
    notlar: children(doc, 'Note').map((n) => text(n)).filter(Boolean).join(' ') || null,
  };

  const satirlar = children(doc, irsaliye ? 'DespatchLine' : 'InvoiceLine');
  const items = satirlar.map((line, i) => {
    const miktarNode = child(line, irsaliye ? 'DeliveredQuantity' : 'InvoicedQuantity');
    const birimKodu = miktarNode?.attrs?.unitCode;
    const item = child(line, 'Item');
    const aciklama = [text(item, 'Name'), text(item, 'Description')].filter(Boolean).join(' ') || null;
    let iskontoTutari = 0;
    let iskontoOrani = 0;
    for (const ac of children(line, 'AllowanceCharge')) {
      if (text(ac, 'ChargeIndicator') === 'true') continue;
      iskontoTutari += num(ac, 'Amount') ?? 0;
      const carpan = num(ac, 'MultiplierFactorNumeric');
      if (carpan != null) iskontoOrani = Math.round(carpan * 10000) / 100;
    }
    const tutar = num(line, 'LineExtensionAmount');
    const kdv = kdvFromTaxTotal(child(line, 'TaxTotal'));
    return {
      sira_no: parseInt(text(line, 'ID'), 10) || i + 1,
      aciklama,
      miktar: miktarNode ? num(miktarNode) : null,
      birim: birimKodu ? (BIRIM_KODLARI[birimKodu] || birimKodu) : null,
      birim_fiyat: num(line, 'Price', 'PriceAmount'),
      iskonto_orani: iskontoOrani,
      iskonto_tutari: Math.round(iskontoTutari * 100) / 100,
      net_satir_tutari: tutar,
      kdv_orani: kdv.oran,
      kdv_tutari: kdv.tutar,
      mal_hizmet_tutari: tutar,
    };
  });

  return { header, items };
}

/**
 * PDF'e gömülü UBL XML eklerini çıkarır ve ayrıştırır.
 * @returns {Promise<Array<{ dosya: string, result: { header, items } }>>}
 */
async function readEmbeddedUbl(pdfPath) {
  if (process.env.EMBEDDED_XML_DISABLED === 'true') return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efatura-xml-'));
  try {
    await execFileAsync(resolvePopplerBin('pdfdetach'), ['-saveall', '-o', dir, pdfPath], {
      maxBuffer: 1024 * 1024, timeout: 30000,
    });
    const sonuclar = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.xml$/i.test(f)) continue;
      const xml = fs.readFileSync(path.join(dir, f), 'utf8');
      const result = ublToResult(xml);
      if (result) sonuclar.push({ dosya: f, result });
    }
    return sonuclar;
  } catch {
    // pdfdetach yok ya da ek yok — metin ayrıştırmaya devam edilir.
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { parseXml, ublToResult, readEmbeddedUbl };
