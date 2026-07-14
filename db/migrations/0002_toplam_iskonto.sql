-- Belge geneli iskonto tutarı (ör. "Toplam İskonto(%15,00): 5.782,50 TL").
-- Kalem tutarları iskontolu, başlıktaki "Mal / Hizmet Toplam Tutarı"
-- iskontosuz yazılan şablonlarda doğrulama bu kolona bakar.

ALTER TABLE documents ADD COLUMN toplam_iskonto REAL;
