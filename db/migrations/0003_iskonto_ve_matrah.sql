-- Kalemler için iskonto ve net satır matrahı; Belgeler için KDV hariç net matrah.
ALTER TABLE items ADD COLUMN iskonto_orani REAL DEFAULT 0;
ALTER TABLE items ADD COLUMN iskonto_tutari REAL DEFAULT 0;
ALTER TABLE items ADD COLUMN net_satir_tutari REAL;

ALTER TABLE documents ADD COLUMN kdv_matrahi REAL;
