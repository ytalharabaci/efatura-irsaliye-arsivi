'use strict';

// Tek bir PDF'i işleyen ortak ingest mantığı. Kaynaklar güven sırasıyla:
//   1. PDF'e gömülü UBL-TR XML (varsa doğrudan resmi belge)
//   2. pdftotext → belge ayrıştırma (bir dosyada birden çok fatura olabilir)
//      → tüm extractor'lar (statik + LLM üretimi) → en iyi skor
//      → GİB karekodu (QR) ile başlık doğrulama/düzeltme
//   3. Sonuç yetersizse LLM: maskeli metinden doğrulamalı parser üretimi;
//      o da olmazsa (yalnız yerel LLM'de) doğrudan JSON çıkarım
// → DB'ye upsert. Hem CLI (ingestRunner) hem web yüklemesi (POST /api/upload)
// bu modülü kullanır.

const fs = require('node:fs');
const path = require('node:path');
const { pdfToText, pdfToTextRaw } = require('./pdfToText');
const { splitIntoDocuments } = require('./splitDocuments');
const { generateValidatedParser, resolveLlmConfig, hasUsableConfig } = require('./llmParserGenerator');
const { directExtract, directExtractEnabled } = require('./llmDirectExtract');
const {
  dispatchAll,
  registerDynamicExtractor,
  recordDynamicOutcome,
  templateFingerprint,
  findByFingerprint,
  dynamicDir,
} = require('./extractors/index');
const { validateDocument } = require('./validate');
const { readPdfQrs, findQrForSegment, mergeQrIntoHeader } = require('./qrReader');
const { readEmbeddedUbl } = require('./embeddedXml');

// Toplu sonuç için durum önceliği: en kötü durum dosyanın durumu olur.
const DURUM_SIRASI = { BASARILI: 0, SUPHELI: 1, TANINMAYAN: 2, HATALI: 3 };

const KAYNAK_ETIKETI = {
  xml: '📄 Gömülü UBL XML',
  dynamic: '🤖 Yapay Zeka Özel Parser',
  'llm-direct': '🤖 Yapay Zeka doğrudan çıkarım (yerel LLM)',
};

function envInt(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function llmAllowed(options) {
  if (options.autoGenerateParser === false || process.env.ENABLE_LLM_AUTO_PARSER === 'false') return false;
  return hasUsableConfig(resolveLlmConfig(options));
}

// Aynı şablon için LLM'i her belgede yeniden çağırmamak: başarısız üretim
// parmak izi bazında kaydedilir, bekleme süresi dolana kadar tekrar denenmez.
function basarisizKayitYolu() {
  return path.join(dynamicDir(), '_basarisiz.json');
}

function readBasarisiz() {
  try { return JSON.parse(fs.readFileSync(basarisizKayitYolu(), 'utf8')); } catch { return {}; }
}

function recentlyFailed(fp) {
  const kayit = readBasarisiz()[fp];
  if (!kayit) return false;
  const beklemeMs = envInt('LLM_RETRY_COOLDOWN_HOURS', 24) * 3600 * 1000;
  return Date.now() - Date.parse(kayit.sonDeneme) < beklemeMs;
}

function recordFailure(fp, hata) {
  try {
    const kayitlar = readBasarisiz();
    kayitlar[fp] = { sayi: (kayitlar[fp]?.sayi || 0) + 1, sonDeneme: new Date().toISOString(), hata: String(hata).slice(0, 300) };
    fs.mkdirSync(dynamicDir(), { recursive: true });
    fs.writeFileSync(basarisizKayitYolu(), JSON.stringify(kayitlar, null, 2), 'utf8');
  } catch { /* opsiyonel */ }
}

/** Adayın başlığını karekodla doğrular/düzeltir ve yeniden doğrular. */
function applyQr(aday, qr) {
  if (!aday || !qr) return aday;
  const { header, notlar } = mergeQrIntoHeader(aday.result.header, qr.header);
  const result = { ...aday.result, header };
  return {
    ...aday,
    result,
    validation: validateDocument(header, result.items),
    qrNotlari: notlar,
    qrDogrulandi: true,
  };
}

function better(a, b) {
  if (!b) return true;
  return a.validation.skor > b.validation.skor;
}

/**
 * Bir belge segmentinden en iyi çıkarım sonucunu üretir (DB'ye yazmaz).
 * Eval betiği ve web "parser üret" akışı da bunu kullanır.
 *
 * @param {string} text - segment metni (pdftotext -layout)
 * @param {object} [ctx]
 * @param {string|null} [ctx.rawText] - kerning onarımı için -raw metin
 * @param {object|null} [ctx.qr] - bu segmentin karekodu (readPdfQrs çıktısı)
 * @param {object} [ctx.options] - LLM seçenekleri; autoGenerateParser:false LLM'i kapatır
 * @returns {Promise<null | { name, type, result, validation, qrNotlari?, qrDogrulandi?, llmUretildi? }>}
 */
async function extractSegment(text, { rawText = null, qr = null, options = {}, log = console.log } = {}) {
  const adaylar = dispatchAll(text, { rawText }).map((a) => applyQr(a, qr));
  adaylar.sort((a, b) => b.validation.skor - a.validation.skor);
  let best = adaylar[0] || null;

  const esik = envInt('LLM_MIN_SKOR', 70);
  const yetersiz = () => !best || best.validation.durum !== 'BASARILI' || best.validation.skor < esik;

  if (yetersiz() && llmAllowed(options)) {
    const fp = templateFingerprint(text);
    const mevcut = findByFingerprint(fp);
    const sebep = !best ? 'Tanınmayan şablon' : `${best.name} → ${best.validation.durum} (skor ${best.validation.skor})`;

    if (!options.force && recentlyFailed(fp)) {
      log(`[Ingest] ${sebep}; bu şablon için LLM üretimi yakın zamanda başarısız oldu, atlanıyor.`);
    } else {
      log(`[Ingest] ${sebep}; maskeli metinden LLM ile parser üretiliyor...`);
      try {
        const gen = await generateValidatedParser({
          text, rawText, baselineSkor: best?.validation.skor ?? 0, options, log,
        });
        if (gen.success) {
          const name = mevcut ? mevcut.name : `dynamic_${fp}`;
          registerDynamicExtractor(name, gen.code, {
            fingerprint: fp, provider: gen.provider, model: gen.model,
            skor: gen.validation.skor, denemeSayisi: gen.attempts,
          });
          log(`[Ingest] Parser kaydedildi: ${name} (skor ${gen.validation.skor}, ${gen.attempts} deneme)`);
          const aday = applyQr({ name, type: 'dynamic', result: gen.result, validation: gen.validation, llmUretildi: true }, qr);
          if (better(aday, best)) best = aday;
        } else {
          log(`[Ingest] LLM parser üretimi başarısız: ${gen.error}`);
          recordFailure(fp, gen.error);
        }
      } catch (err) {
        log(`[Ingest] LLM parser üretimi sırasında hata: ${err.message}`);
        recordFailure(fp, err.message);
      }
    }

    if (yetersiz() && directExtractEnabled(options)) {
      const d = await directExtract(text, { rawText, options });
      if (d.success) {
        const aday = applyQr({ name: 'llm_direct', type: 'llm-direct', result: d.result, validation: d.validation }, qr);
        if (better(aday, best)) best = aday;
      } else {
        log(`[Ingest] Doğrudan çıkarım yapılamadı: ${d.error}`);
      }
    }
  }

  return best;
}

/** Seçilen adayı parse notlarıyla birlikte DB'ye yazar ve belge sonucunu döndürür. */
function finalizeSegment(db, aday, kaynak_dosya) {
  const { validation } = aday;
  const header = { ...aday.result.header };
  const items = aday.result.items;

  const parcalar = [];
  if (KAYNAK_ETIKETI[aday.type]) parcalar.push(KAYNAK_ETIKETI[aday.type]);
  if (aday.qrDogrulandi) {
    parcalar.push(aday.qrNotlari && aday.qrNotlari.length ? aday.qrNotlari.join('; ') : 'QR doğrulandı');
  }
  parcalar.push(...validation.notlar);
  parcalar.push(...validation.uyarilar.filter((u) => !/kontrol basamağı|Eksik alan/.test(u)).map((u) => `Uyarı: ${u}`));

  header.parse_durumu = validation.durum;
  header.parse_notu = parcalar.length ? parcalar.join('; ') : null;
  header.kaynak_dosya = kaynak_dosya;

  let document_id;
  if (db) document_id = upsertDocument(db, header, items);
  if (aday.type === 'dynamic' && !aday.llmUretildi) recordDynamicOutcome(aday.name, validation.durum === 'BASARILI');

  return {
    durum: validation.durum,
    mesaj: header.parse_notu,
    document_id,
    belge_no: header.belge_no ?? null,
    ettn: header.ettn ?? null,
    kalem_sayisi: items.length,
    extractor: aday.name,
    kaynak: aday.type,
    skor: validation.skor,
    is_dynamic_parser: aday.type === 'dynamic' || aday.type === 'llm-direct',
  };
}

/**
 * Tek bir belge segmentini (bir faturanın metni) işler.
 * @returns {Promise<{durum: string, mesaj: string|null, document_id?: number, belge_no?: string|null, ettn?: string|null, kalem_sayisi?: number, extractor?: string}>}
 */
async function ingestSegment(db, segmentText, kaynak_dosya, rawText, options = {}, qr = null) {
  const aday = await extractSegment(segmentText, { rawText, qr, options });
  if (!aday) {
    return { durum: 'TANINMAYAN', mesaj: 'Hiçbir extractor bu formatı tanımadı — yeni şablon/extractor gerekebilir' };
  }
  return finalizeSegment(db, aday, kaynak_dosya);
}

/**
 * @param {object|null} db - DatabaseSync; null ise DB'ye yazılmaz (dry-run)
 * @param {string} pdfPath - PDF'in diskteki tam yolu
 * @param {string} kaynak_dosya - DB'ye yazılacak kaynak dosya etiketi
 * @param {object} [options] - Opsiyonel ingest/LLM parametreleri
 *   (embeddedXml:false / qr:false ilgili kaynağı kapatır)
 * @returns {Promise<{durum: 'BASARILI'|'SUPHELI'|'HATALI'|'TANINMAYAN', mesaj: string|null, belge_sayisi: number, belgeler: object[], document_id?: number, belge_no?: string|null, ettn?: string|null, kalem_sayisi?: number, extractor?: string}>}
 *   Dosyada birden çok fatura varsa `belgeler` her biri için ayrı sonuç
 *   içerir; üst seviye alanlar geriye dönük uyumluluk için ilk belgeden
 *   (durum ise en kötüsünden) türetilir.
 */
async function ingestPdf(db, pdfPath, kaynak_dosya, options = {}) {
  const belgeler = [];

  // 1. Gömülü UBL XML: varsa metin ayrıştırmaya gerek yok.
  const xmlBelgeleri = options.embeddedXml === false ? [] : await readEmbeddedUbl(pdfPath);
  if (xmlBelgeleri.length) {
    for (const { result } of xmlBelgeleri) {
      const validation = validateDocument(result.header, result.items);
      belgeler.push(finalizeSegment(db, { name: 'embeddedUbl', type: 'xml', result, validation }, kaynak_dosya));
    }
    return aggregate(belgeler);
  }

  let text;
  try {
    text = await pdfToText(pdfPath);
  } catch (err) {
    if (db) saveError(db, kaynak_dosya, err.message);
    return { durum: 'HATALI', mesaj: err.message, belge_sayisi: 0, belgeler: [] };
  }

  // Kerning onarımı için -raw çıktısı; alınamazsa onarımsız devam edilir.
  let rawText = null;
  try {
    rawText = await pdfToTextRaw(pdfPath);
  } catch { /* onarım opsiyonel */ }

  const segments = splitIntoDocuments(text);
  const qrs = options.qr === false ? [] : await readPdfQrs(pdfPath, { maxPages: Math.min(50, (text.match(/\f/g) || []).length + 1) });
  for (const seg of segments) {
    const qr = findQrForSegment(qrs, seg, segments.length === 1);
    const bResult = await ingestSegment(db, seg, kaynak_dosya, rawText, options, qr);
    belgeler.push(bResult);
  }

  return aggregate(belgeler);
}

function aggregate(belgeler) {
  if (belgeler.length === 1) {
    return { ...belgeler[0], belge_sayisi: 1, belgeler };
  }

  const durum = belgeler.reduce(
    (worst, b) => (DURUM_SIRASI[b.durum] > DURUM_SIRASI[worst] ? b.durum : worst),
    'BASARILI'
  );
  const sorunlar = belgeler
    .filter((b) => b.mesaj)
    .map((b) => `${b.belge_no ?? b.ettn ?? '?'}: ${b.mesaj}`);
  const kalemToplam = belgeler.reduce((sum, b) => sum + (b.kalem_sayisi ?? 0), 0);

  return {
    durum,
    mesaj: sorunlar.length ? sorunlar.join(' | ') : `${belgeler.length} belge çıkarıldı`,
    belge_sayisi: belgeler.length,
    belgeler,
    document_id: belgeler[0].document_id,
    belge_no: belgeler[0].belge_no ?? null,
    ettn: belgeler[0].ettn ?? null,
    kalem_sayisi: kalemToplam,
    extractor: belgeler[0].extractor,
  };
}

/**
 * VKN/TCKN'ye göre taraflar tablosunda arar; varsa günceller (yeni bilgi
 * varsa doldurur), yoksa oluşturur. Böylece aynı satıcı/alıcı her faturada
 * tekrar tekrar yazılmaz. VKN/TCKN yoksa eşleştirme güvenilir olmadığından
 * her seferinde yeni bir kayıt açılır.
 */
function findOrCreateTaraf(db, fields) {
  const unvan = fields.unvan ?? null;
  const vkn_tckn = fields.vkn_tckn ?? null;
  const vergi_dairesi = fields.vergi_dairesi ?? null;
  const adres = fields.adres ?? null;
  const eposta = fields.eposta ?? null;
  const telefon = fields.telefon ?? null;

  if (!unvan && !vkn_tckn) return null;

  if (vkn_tckn) {
    const existing = db.prepare('SELECT id FROM taraflar WHERE vkn_tckn = ?').get(vkn_tckn);
    if (existing) {
      // unvan da COALESCE ile: bu belgeden unvan çıkarılamadıysa mevcut
      // unvanı NULL ile ezme (unvan NOT NULL — aksi halde hata da atar)
      db.prepare(`
        UPDATE taraflar SET
          unvan = COALESCE(:unvan, unvan),
          vergi_dairesi = COALESCE(:vergi_dairesi, vergi_dairesi),
          adres = COALESCE(:adres, adres),
          eposta = COALESCE(:eposta, eposta),
          telefon = COALESCE(:telefon, telefon)
        WHERE id = :id
      `).run({ unvan, vergi_dairesi, adres, eposta, telefon, id: existing.id });
      return existing.id;
    }
  }

  const result = db.prepare(`
    INSERT INTO taraflar (unvan, vkn_tckn, vergi_dairesi, adres, eposta, telefon)
    VALUES (:unvan, :vkn_tckn, :vergi_dairesi, :adres, :eposta, :telefon)
  `).run({ unvan: unvan || vkn_tckn, vkn_tckn, vergi_dairesi, adres, eposta, telefon });

  return Number(result.lastInsertRowid);
}

/** @returns {number} eklenen belgenin id'si */
function upsertDocument(db, header, items) {
  const satici_id = findOrCreateTaraf(db, {
    unvan: header.satici_unvan,
    vkn_tckn: header.satici_vkn_tckn,
    vergi_dairesi: header.satici_vergi_dairesi,
    adres: header.satici_adres,
    eposta: header.satici_eposta,
    telefon: header.satici_telefon,
  });
  const alici_id = findOrCreateTaraf(db, {
    unvan: header.alici_unvan,
    vkn_tckn: header.alici_vkn_tckn,
    vergi_dairesi: header.alici_vergi_dairesi,
    adres: header.alici_adres,
    eposta: header.alici_eposta,
    telefon: header.alici_telefon,
  });

  const insertDoc = db.prepare(`
    INSERT INTO documents (
      belge_tipi, belge_no, ettn, duzenleme_tarihi, duzenleme_zamani,
      senaryo, fatura_tipi, satici_id, alici_id,
      mal_hizmet_toplam_tutari, toplam_iskonto, kdv_matrahi, hesaplanan_kdv_toplam, vergiler_dahil_toplam_tutar, odenecek_tutar,
      notlar, kaynak_dosya, parse_durumu, parse_notu
    ) VALUES (
      :belge_tipi, :belge_no, :ettn, :duzenleme_tarihi, :duzenleme_zamani,
      :senaryo, :fatura_tipi, :satici_id, :alici_id,
      :mal_hizmet_toplam_tutari, :toplam_iskonto, :kdv_matrahi, :hesaplanan_kdv_toplam, :vergiler_dahil_toplam_tutar, :odenecek_tutar,
      :notlar, :kaynak_dosya, :parse_durumu, :parse_notu
    )
  `);

  const insertItem = db.prepare(`
    INSERT INTO items (document_id, sira_no, aciklama, miktar, birim, birim_fiyat, iskonto_orani, iskonto_tutari, net_satir_tutari, kdv_orani, kdv_tutari, mal_hizmet_tutari)
    VALUES (:document_id, :sira_no, :aciklama, :miktar, :birim, :birim_fiyat, :iskonto_orani, :iskonto_tutari, :net_satir_tutari, :kdv_orani, :kdv_tutari, :mal_hizmet_tutari)
  `);

  db.exec('BEGIN');
  try {
    // Aynı ETTN varsa sil-yeniden-yaz. DELETE, INSERT ile aynı transaction
    // içinde: insert başarısız olursa eski kayıt da geri gelir.
    if (header.ettn) {
      db.prepare('DELETE FROM documents WHERE ettn = ?').run(header.ettn);
    }
    // Aynı dosya daha önce HATALI olarak kaydedildiyse (ETTN'siz), bu başarılı
    // parse o kaydın yerini alır — mükerrer satır birikmesin.
    db.prepare("DELETE FROM documents WHERE kaynak_dosya = ? AND parse_durumu = 'HATALI'")
      .run(header.kaynak_dosya);

    const result = insertDoc.run({
      belge_tipi: header.belge_tipi ?? 'FATURA',
      belge_no: header.belge_no ?? null,
      ettn: header.ettn ?? null,
      duzenleme_tarihi: header.duzenleme_tarihi ?? null,
      duzenleme_zamani: header.duzenleme_zamani ?? null,
      senaryo: header.senaryo ?? null,
      fatura_tipi: header.fatura_tipi ?? null,
      satici_id: satici_id ?? null,
      alici_id: alici_id ?? null,
      mal_hizmet_toplam_tutari: header.mal_hizmet_toplam_tutari ?? null,
      toplam_iskonto: header.toplam_iskonto ?? null,
      kdv_matrahi: header.kdv_matrahi ?? null,
      hesaplanan_kdv_toplam: header.hesaplanan_kdv_toplam ?? null,
      vergiler_dahil_toplam_tutar: header.vergiler_dahil_toplam_tutar ?? null,
      odenecek_tutar: header.odenecek_tutar ?? null,
      notlar: header.notlar ?? null,
      kaynak_dosya: header.kaynak_dosya,
      parse_durumu: header.parse_durumu ?? 'BASARILI',
      parse_notu: header.parse_notu ?? null,
    });
    const document_id = Number(result.lastInsertRowid);
    for (const item of items) {
      insertItem.run({
        sira_no: item.sira_no ?? null,
        aciklama: item.aciklama ?? null,
        miktar: item.miktar ?? null,
        birim: item.birim ?? null,
        birim_fiyat: item.birim_fiyat ?? null,
        iskonto_orani: item.iskonto_orani ?? 0,
        iskonto_tutari: item.iskonto_tutari ?? 0,
        net_satir_tutari: item.net_satir_tutari ?? null,
        kdv_orani: item.kdv_orani ?? null,
        kdv_tutari: item.kdv_tutari ?? null,
        mal_hizmet_tutari: item.mal_hizmet_tutari ?? null,
        document_id,
      });
    }
    db.exec('COMMIT');
    return document_id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function saveError(db, kaynak_dosya, mesaj) {
  // Dosya adından belge tipini tahmin et; bilinmiyorsa FATURA varsayılan
  const lower = kaynak_dosya.toLowerCase();
  const belge_tipi = lower.includes('irsaliye') ? 'IRSALIYE' : 'FATURA';
  db.exec('BEGIN');
  try {
    // Aynı dosyanın önceki HATALI kaydı varsa yenisiyle değiştir (tekrar
    // ingest'te mükerrer HATALI satırları birikmesin)
    db.prepare("DELETE FROM documents WHERE kaynak_dosya = ? AND parse_durumu = 'HATALI'")
      .run(kaynak_dosya);
    db.prepare(`
      INSERT INTO documents (belge_tipi, kaynak_dosya, parse_durumu, parse_notu)
      VALUES (?, ?, 'HATALI', ?)
    `).run(belge_tipi, kaynak_dosya, mesaj);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { ingestPdf, extractSegment, upsertDocument, saveError, findOrCreateTaraf };
