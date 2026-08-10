'use strict';

const path = require('path');
const fs = require('fs');
// node:sqlite Node 22.5+ ile gelir (experimental), Node 24'te kullanılabilir
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'arsiv.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new DatabaseSync(DB_PATH);

  // WAL modu ve FK'ları etkinleştir
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  // Ingest + sunucu aynı anda yazarsa "database is locked" yerine 5 sn bekle
  _db.exec('PRAGMA busy_timeout = 5000');

  // SQLite'ın yerleşik lower() fonksiyonu yalnızca ASCII bilir; Türkçe
  // İ/ı/Ş/Ğ... için harf duyarsız arama bu fonksiyonla yapılır:
  //   WHERE tr_lower(kolon) LIKE tr_lower(?)
  _db.function('tr_lower', { deterministic: true }, (s) =>
    s == null ? null : String(s).toLocaleLowerCase('tr-TR')
  );

  // schema.sql yalnızca gerçekten taze (boş) bir veritabanında bir kez
  // çalıştırılır. Sonraki tüm yapısal değişiklikler db/migrations/ altından
  // gelir — schema.sql'i her süreç başlangıcında tekrar çalıştırmak,
  // migration'ların değiştirdiği/kaldırdığı sütunlar üzerinde (ör. index)
  // hataya yol açar.
  const isFreshDb = !_db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'"
  ).get();
  if (isFreshDb) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    _db.exec(schema);
  }

  runMigrations(_db);

  return _db;
}

/**
 * db/migrations/ altındaki .sql dosyalarını dosya adına göre sırayla,
 * daha önce uygulanmamış olanları çalıştırır (schema.sql'in kapsadığı ilk
 * kurulumdan SONRA yapılan şema değişiklikleri buraya eklenir).
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      uygulama_tarihi TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );

  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err.message.includes('duplicate column name')) {
        db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(file);
      } else {
        throw new Error(`Migration başarısız (${file}): ${err.message}`);
      }
    }
  }
}

module.exports = { getDb };
