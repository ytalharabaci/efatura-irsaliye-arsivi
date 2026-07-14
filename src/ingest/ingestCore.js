'use strict';

// Tek bir PDF'i işleyen ortak ingest mantığı: pdftotext → belge ayrıştırma
// (bir dosyada art arda birden çok fatura olabilir) → extractor → doğrulama →
// DB'ye upsert. Hem CLI (ingestRunner) hem web yüklemesi (POST /api/upload)
// bu modülü kullanır.

const { pdfToText } = require('./pdfToText');
const { splitIntoDocuments } = require('./splitDocuments');
const { dispatch } = require('./extractors/index');
const { validateDocument } = require('./validate');

// Toplu sonuç için durum önceliği: en kötü durum dosyanın durumu olur.
const DURUM_SIRASI = { BASARILI: 0, SUPHELI: 1, TANINMAYAN: 2, HATALI: 3 };

/**
 * Tek bir belge segmentini (bir faturanın metni) işler.
 * @returns {{durum: string, mesaj: string|null, document_id?: number, belge_no?: string|null, ettn?: string|null, kalem_sayisi?: number, extractor?: string}}
 */
function ingestSegment(db, segmentText, kaynak_dosya) {
  const dispatched = dispatch(segmentText);
  if (!dispatched) {
    return { durum: 'TANINMAYAN', mesaj: 'Hiçbir extractor bu formatı tanımadı — yeni şablon/extractor gerekebilir' };
  }

  const { header, items } = dispatched.result;
  const validation = validateDocument(header, items);

  header.parse_durumu = validation.durum;
  header.parse_notu = validation.notlar.length ? validation.notlar.join('; ') : null;
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
  };
}

/**
 * @param {object|null} db - DatabaseSync; null ise DB'ye yazılmaz (dry-run)
 * @param {string} pdfPath - PDF'in diskteki tam yolu
 * @param {string} kaynak_dosya - DB'ye yazılacak kaynak dosya etiketi
 * @returns {Promise<{durum: 'BASARILI'|'SUPHELI'|'HATALI'|'TANINMAYAN', mesaj: string|null, belge_sayisi: number, belgeler: object[], document_id?: number, belge_no?: string|null, ettn?: string|null, kalem_sayisi?: number, extractor?: string}>}
 *   Dosyada birden çok fatura varsa `belgeler` her biri için ayrı sonuç
 *   içerir; üst seviye alanlar geriye dönük uyumluluk için ilk belgeden
 *   (durum ise en kötüsünden) türetilir.
 */
async function ingestPdf(db, pdfPath, kaynak_dosya) {
  let text;
  try {
    text = await pdfToText(pdfPath);
  } catch (err) {
    if (db) saveError(db, kaynak_dosya, err.message);
    return { durum: 'HATALI', mesaj: err.message, belge_sayisi: 0, belgeler: [] };
  }

  const segments = splitIntoDocuments(text);
  const belgeler = segments.map((seg) => ingestSegment(db, seg, kaynak_dosya));

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
      mal_hizmet_toplam_tutari, toplam_iskonto, hesaplanan_kdv_toplam, vergiler_dahil_toplam_tutar, odenecek_tutar,
      notlar, kaynak_dosya, parse_durumu, parse_notu
    ) VALUES (
      :belge_tipi, :belge_no, :ettn, :duzenleme_tarihi, :duzenleme_zamani,
      :senaryo, :fatura_tipi, :satici_id, :alici_id,
      :mal_hizmet_toplam_tutari, :toplam_iskonto, :hesaplanan_kdv_toplam, :vergiler_dahil_toplam_tutar, :odenecek_tutar,
      :notlar, :kaynak_dosya, :parse_durumu, :parse_notu
    )
  `);

  const insertItem = db.prepare(`
    INSERT INTO items (document_id, sira_no, aciklama, miktar, birim, birim_fiyat, kdv_orani, kdv_tutari, mal_hizmet_tutari)
    VALUES (:document_id, :sira_no, :aciklama, :miktar, :birim, :birim_fiyat, :kdv_orani, :kdv_tutari, :mal_hizmet_tutari)
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
      belge_tipi: header.belge_tipi,
      belge_no: header.belge_no,
      ettn: header.ettn,
      duzenleme_tarihi: header.duzenleme_tarihi,
      duzenleme_zamani: header.duzenleme_zamani,
      senaryo: header.senaryo,
      fatura_tipi: header.fatura_tipi,
      satici_id,
      alici_id,
      mal_hizmet_toplam_tutari: header.mal_hizmet_toplam_tutari,
      toplam_iskonto: header.toplam_iskonto ?? null,
      hesaplanan_kdv_toplam: header.hesaplanan_kdv_toplam,
      vergiler_dahil_toplam_tutar: header.vergiler_dahil_toplam_tutar,
      odenecek_tutar: header.odenecek_tutar,
      notlar: header.notlar,
      kaynak_dosya: header.kaynak_dosya,
      parse_durumu: header.parse_durumu,
      parse_notu: header.parse_notu,
    });
    const document_id = Number(result.lastInsertRowid);
    for (const item of items) {
      insertItem.run({ ...item, document_id });
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
