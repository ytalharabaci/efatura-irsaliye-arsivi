'use strict';

// Regresyon kalkanı: fixture korpusunda alan bazlı doğruluk düşmemeli.
// Expected dosyaları gözden geçirilmiş doğru değerlerdir; bir iyileştirme
// expected'ı değiştiriyorsa dosya bilinçli olarak güncellenmelidir.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../scripts/eval-parsers');

test('eval: tüm fixture alanları expected ile eşleşir', async () => {
  const rapor = await evaluate();
  const hatalar = rapor.fixtures.flatMap((f) => f.hatalar.map((h) => `${f.ad} ${h.alan}: beklenen ${JSON.stringify(h.beklenen)}, bulunan ${JSON.stringify(h.gercek)}`));
  assert.ok(rapor.toplam > 900, 'korpus boş olmamalı');
  assert.deepEqual(hatalar, []);
});
