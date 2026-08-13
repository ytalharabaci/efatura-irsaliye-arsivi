PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Satıcı / alıcı taraf bilgileri: aynı firma tüm faturalarda tek kayıt olarak tutulur.
-- vkn_tckn UNIQUE: aynı VKN/TCKN ile birden fazla taraf kaydı olamaz.
-- NULL vkn_tckn için SQLite UNIQUE birden fazla NULL'a izin verir (bu kasıtlıdır:
-- VKN bilinmiyorsa her faturada ayrı taraf satırı açılır).
CREATE TABLE IF NOT EXISTS taraflar (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  unvan         TEXT    NOT NULL,
  vkn_tckn      TEXT    UNIQUE,
  vergi_dairesi TEXT,
  adres         TEXT,
  eposta        TEXT,
  telefon       TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  belge_tipi                  TEXT    NOT NULL CHECK(belge_tipi IN ('FATURA','IRSALIYE')),
  belge_no                    TEXT,
  ettn                        TEXT    UNIQUE,
  duzenleme_tarihi            TEXT,
  duzenleme_zamani            TEXT,
  senaryo                     TEXT,
  fatura_tipi                 TEXT,
  -- Taraf referansları: documents → taraflar FK (CASCADE silme yok; taraf silinince NULL'a düşmez)
  satici_id                   INTEGER REFERENCES taraflar(id),
  alici_id                    INTEGER REFERENCES taraflar(id),
  -- Tutar alanları
  mal_hizmet_toplam_tutari    REAL,
  toplam_iskonto              REAL,
  kdv_matrahi                 REAL,
  hesaplanan_kdv_toplam       REAL,
  vergiler_dahil_toplam_tutar REAL,
  odenecek_tutar              REAL,
  notlar                      TEXT,
  kaynak_dosya                TEXT    NOT NULL,
  parse_durumu                TEXT    NOT NULL CHECK(parse_durumu IN ('BASARILI','SUPHELI','HATALI')),
  parse_notu                  TEXT,
  olusturma_tarihi            TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sira_no          INTEGER,
  aciklama         TEXT,
  miktar           REAL,
  birim            TEXT,
  birim_fiyat      REAL,
  iskonto_orani    REAL,
  iskonto_tutari   REAL,
  net_satir_tutari REAL,
  kdv_orani        REAL,
  kdv_tutari       REAL,
  mal_hizmet_tutari REAL
);

-- İndeksler
CREATE INDEX IF NOT EXISTS idx_taraflar_vkn_tckn ON taraflar(vkn_tckn);
CREATE INDEX IF NOT EXISTS idx_taraflar_unvan    ON taraflar(unvan);

CREATE INDEX IF NOT EXISTS idx_documents_ettn         ON documents(ettn);
CREATE INDEX IF NOT EXISTS idx_documents_tarih        ON documents(duzenleme_tarihi);
CREATE INDEX IF NOT EXISTS idx_documents_satici_id    ON documents(satici_id);
CREATE INDEX IF NOT EXISTS idx_documents_alici_id     ON documents(alici_id);
CREATE INDEX IF NOT EXISTS idx_documents_parse_durumu ON documents(parse_durumu);

CREATE INDEX IF NOT EXISTS idx_items_aciklama   ON items(aciklama);
CREATE INDEX IF NOT EXISTS idx_items_document   ON items(document_id);
