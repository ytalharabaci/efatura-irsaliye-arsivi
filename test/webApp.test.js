'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('Web App Frontend: index.html ve app.js statik ve sözdizim doğrulaması', () => {
  const htmlPath = path.join(__dirname, '..', 'src', 'web', 'index.html');
  const jsPath = path.join(__dirname, '..', 'src', 'web', 'app.js');

  assert.ok(fs.existsSync(htmlPath), 'index.html mevcut olmalı');
  assert.ok(fs.existsSync(jsPath), 'app.js mevcut olmalı');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const jsContent = fs.readFileSync(jsPath, 'utf8');

  // 1. JS Sözdizimi Kontrolü (Node.js vm.Script ile derle)
  let script;
  assert.doesNotThrow(() => {
    script = new vm.Script(jsContent, { filename: 'app.js' });
  }, 'app.js geçerli JavaScript sözdizimine sahip olmalı');

  // 2. index.html İçi DOM ID'lerinin app.js Tarafından Bulunabilirliği
  // app.js içinde `$('id-adi')` ile çağrılan tüm ID'leri ayıkla
  const idMatches = [...jsContent.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const uniqueIds = [...new Set(idMatches)];

  const missingIds = [];
  uniqueIds.forEach((id) => {
    // Dinamik oluşturulan elementler hariç index.html içinde bulunmalı
    const isDynamic = ['yukle-tbody', 'edit-header', 'edit-items-table'].includes(id);
    if (!isDynamic && !htmlContent.includes(`id="${id}"`)) {
      missingIds.push(id);
    }
  });

  assert.deepEqual(missingIds, [], `index.html içinde eksik olan ID'ler: ${missingIds.join(', ')}`);

  // 3. Tanımlanmamış Değişken (ReferenceError) Taraması
  // Şablon stringler içinde ${esc(degişken)} kullanımı
  const templateVars = [...jsContent.matchAll(/\$\{esc\(([a-zA-Z0-9_.]+)\)\}/g)].map((m) => m[1]);
  assert.ok(templateVars.length > 0, 'Şablon değişkenleri bulunabilmeli');
  assert.ok(!templateVars.includes('dosyaAd'), 'dosyaAd gibi tanımlanmamış değişkenler bulunmamalı');
});
