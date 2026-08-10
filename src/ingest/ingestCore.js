'use strict';

// Tek bir PDF'i işleyen ortak ingest mantığı: pdftotext → belge ayrıştırma
// (bir dosyada art arda birden çok fatura olabilir) → extractor → doğrulama →
// DB'ye upsert. Hem CLI (ingestRunner) hem web yüklemesi (POST /api/upload)
// bu modülü kullanır.

const { pdfToText, pdfToTextRaw } = require('./pdfToText');
const { splitIntoDocuments } = require('./splitDocuments');
const { anonymizePdfText } = require('./anonymize');
const { generateParserFromLayout } = require('./llmParserGenerator');
const { dispatch, registerDynamicExtractor } = require('./extractors/index');
const { repairDocumentText } = require('./repairKerning');
const { validateDocument } = require('./validate');

// Toplu sonuç için durum önceliği: en kötü durum dosyanın durumu olur.
const DURUM_SIRASI = { BASARILI: 0, SUPHELI: 1, TANINMAYAN: 2, HATALI: 3 };

/**
 * Tek bir belge segmentini (bir faturanın metni) işler.
 * @returns {Promise<{durum: string, mesaj: string|null, document_id?: number, belge_no?: string|null, ettn?: string|null, kalem_sayisi?: number, extractor?: string}>}
 */
async function ingestSegment(db, segmentText, kaynak_dosya, rawText, options = {}) {
  let dispatched = dispatch(segmentText);

  // Eğer hiçbir extractor tanıyamadıysa ve LLM API Anahtarı mevcutsa veya otomatik üretme aktifse:
  const hasLlmKey = Boolean(options.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
  const allowAutoLlm = options.autoGenerateParser !== false && (hasLlmKey || process.env.ENABLE_LLM_AUTO_PARSER === 'true');

  if (!dispatched && allowAutoLlm && hasLlmKey) {
    try {
      console.log('[Ingest] Tanınmayan şablon algılandı, KVKK maskelemesi yapılarak LLM ile parser yazdırılıyor...');
      const anonymized = anonymizePdfText(segmentText);
      const genResult = await generateParserFromLayout(anonymized, options);

      if (genResult.success && genResult.code) {
        const extractorName = `dynamic_${Date.now()}`;
        registerDynamicExtractor(extractorName, genResult.code);
        console.log(`[Ingest] Yeni extractor başarıyla diske kaydedildi: ${extractorName}`);
        dispatched = dispatch(segmentText);
      } else {
        console.error('[Ingest] LLM Parser üretimi başarısız oldu:', genResult.error);
      }
    } catch (err) {
      console.error('[Ingest] LLM Parser üretimi sırasında istisna oluştu:', err.message);
    }
  }

  if (!dispatched) {
    return { durum: 'TANINMAYAN', mesaj: 'Hiçbir extractor bu formatı tanımadı — yeni şablon/extractor gerekebilir' };
  }

  // Kerning artefaktlarını (-layout'un kelime içine soktuğu boşluklar)
  // -raw çıktısını referans alarak onar: "HO RTUM" → "HORTUM".
  repairDocumentText(dispatched.result, rawText);

  const { header, items } = dispatched.result;
  const validation = validateDocument(header, items);

  const isDynamic = Boolean(dispatched.name && dispatched.name.startsWith('dynamic_'));
  let parseNotu = validation.notlar.length ? validation.notlar.join('; ') : '';
  if (isDynamic) {
    parseNotu = parseNotu ? `🤖 Yapay Zeka Özel Parser; ${parseNotu}` : '🤖 Yapay Zeka Özel Parser';
  }

  header.parse_durumu = validation.durum;
  header.parse_notu = parseNotu || null;
  header.kaynak_dosya = kaynak_dosya;

  let document_id;
  if (db) document_id = upsertDocument(db, header, items);

  return {
    durum: validation.durum,
    mesaj: header.parse_notu,
    document_id,
    belge_no: header.belge_no ?? null,
    ettn: header.ettn ?? null,
    kalem_sayisi: items.length,
    extractor: dispatched.name,
    is_dynamic_parser: isDynamic,
  };
}

/**
 * @param {object|null} db - DatabaseSync; null ise DB'ye yazılmaz (dry-run)
 * @param {string} pdfPath - PDF'in diskteki tam yolu
 * @param {string} kaynak_dosya - DB'ye yazılacak kaynak dosya etiketi
 * @param {object} [options] - Opsiyonel ingest/LLM parametreleri
 * @returns {Promise<{durum: 'BASARILI'|'SUPHELI'|'HATALI'|'TANINMAYAN', mesaj: string|null, belge_sayisi: number, belgeler: object[], document_id?: number, belge_no?: string|null, ettn?: string|null, kalem_sayisi?: number, extractor?: string}>}
 *   Dosyada birden çok fatura varsa `belgeler` her biri için ayrı sonuç
 *   içerir; üst seviye alanlar geriye dönük uyumluluk için ilk belgeden
 *   (durum ise en kötüsünden) türetilir.
 */
async function ingestPdf(db, pdfPath, kaynak_dosya, options = {}) {
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
  const belgeler = [];
  for (const seg of segments) {
    const bResult = await ingestSegment(db, seg, kaynak_dosya, rawText, options);
    belgeler.push(bResult);
  }

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

module.exports = { ingestPdf, upsertDocument, saveError, findOrCreateTaraf };
