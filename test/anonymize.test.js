'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { anonymizePdfText } = require('../src/ingest/anonymize');

test('anonymizePdfText: TCKN, VKN, ETTN ve Fatura No maskelenmeli', () => {
  const sample = `
                                                               E-Fatura

Vergi Dairesi: Kadıköy Vergi Dairesi
TCKN: 12345678901
VKN: 9876543210
Fatura No: GIB2026000000001
ETTN: 12345678-1234-1234-1234-123456789012
E-Posta: ahmet@example.com
Tel: +90 212 555 0000
Düzenleme Tarihi: 30-06-2026

SAYIN
Ahmet Yılmaz Teknoloji A.Ş.
Atatürk Mah. Ihlamur Sok. No:5 Kadıköy Istanbul

1                                 Siber Güvenlik Hizmeti Bedeli       1 Adet       15.000,00 TL         %20,00         3.000,00 TL             15.000,00 TL
`;

  const anonymized = anonymizePdfText(sample);

  assert.ok(!anonymized.includes('12345678901'), 'TCKN gizlenmeli');
  assert.ok(!anonymized.includes('9876543210'), 'VKN gizlenmeli');
  assert.ok(!anonymized.includes('GIB2026000000001'), 'Fatura No gizlenmeli');
  assert.ok(!anonymized.includes('12345678-1234-1234-1234-123456789012'), 'ETTN gizlenmeli');
  assert.ok(!anonymized.includes('ahmet@example.com'), 'E-Posta gizlenmeli');
  assert.ok(!anonymized.includes('+90 212 555 0000'), 'Telefon gizlenmeli');
  assert.ok(!anonymized.includes('30-06-2026'), 'Tarih gizlenmeli');
  assert.ok(!anonymized.includes('15.000,00 TL'), 'Tutar gizlenmeli');

  assert.ok(anonymized.includes('[VKN_TCKN]'), 'VKN_TCKN etiketini içermeli');
  assert.ok(anonymized.includes('[BELGE_NO]'), 'BELGE_NO etiketini içermeli');
  assert.ok(anonymized.includes('[ETTN_UUID]'), 'ETTN_UUID etiketini içermeli');
  assert.ok(anonymized.includes('[EPOSTA]'), 'EPOSTA etiketini içermeli');
  assert.ok(anonymized.includes('[TELEFON]'), 'TELEFON etiketini içermeli');
  assert.ok(anonymized.includes('[DATE]'), 'DATE etiketini içermeli');
  assert.ok(anonymized.includes('[MONEY_VAL]'), 'MONEY_VAL etiketini içermeli');
});
