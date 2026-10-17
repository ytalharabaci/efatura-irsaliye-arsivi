'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTrNumber, parseTrPercent, parseTrDate } = require('../src/ingest/normalize');

test('parseTrNumber: binlik ayraçlı sayı', () => {
  assert.equal(parseTrNumber('15.000,00'), 15000);
  assert.equal(parseTrNumber('3.000,00'), 3000);
  assert.equal(parseTrNumber('18.000,00'), 18000);
});

test('parseTrNumber: TL birimi olan sayı', () => {
  assert.equal(parseTrNumber('15.000 TL'), 15000);
  assert.equal(parseTrNumber('3.000,00 TL'), 3000);
});

test('parseTrNumber: basit sayı', () => {
  assert.equal(parseTrNumber('1'), 1);
  assert.equal(parseTrNumber('0'), 0);
});

test('parseTrNumber: null/geçersiz', () => {
  assert.equal(parseTrNumber(null), null);
  assert.equal(parseTrNumber('abc'), null);
});

test('parseTrPercent: yüzde string', () => {
  assert.equal(parseTrPercent('%20,00'), 20);
  assert.equal(parseTrPercent('20,00'), 20);
  assert.equal(parseTrPercent('%8'), 8);
});

test('parseTrDate: GG-AA-YYYY → YYYY-MM-DD', () => {
  assert.equal(parseTrDate('30-06-2026'), '2026-06-30');
  assert.equal(parseTrDate('01-01-2024'), '2024-01-01');
});

test('parseTrDate: geçersiz format', () => {
  assert.equal(parseTrDate('2026-06-30'), null);
  assert.equal(parseTrDate(''), null);
  assert.equal(parseTrDate(null), null);
});

test('parseTrDate: nokta/eğik çizgi ayraçlı ve boşluklu biçimler', () => {
  assert.equal(parseTrDate('10.04.2026'), '2026-04-10');
  assert.equal(parseTrDate('09/05/2026'), '2026-05-09');
  assert.equal(parseTrDate('09 - 05 - 2026'), '2026-05-09');
  assert.equal(parseTrDate('9-5-2026'), '2026-05-09');
});

test('parseTrDate: takvimde olmayan tarih null', () => {
  assert.equal(parseTrDate('31-02-2026'), null);
  assert.equal(parseTrDate('00-01-2026'), null);
});

test('parseTrNumber: döviz sonekleri ve ondalık nokta sezgisi', () => {
  assert.equal(parseTrNumber('1.250,50 USD'), 1250.5);
  assert.equal(parseTrNumber('99,90EUR'), 99.9);
  assert.equal(parseTrNumber('80.000'), 80000);
  assert.equal(parseTrNumber('1.250.000'), 1250000);
  assert.equal(parseTrNumber('85.5'), 85.5);
  assert.equal(parseTrNumber('0.21'), 0.21);
});

test('isValidVkn / isValidTckn: kontrol basamakları', () => {
  const { isValidVkn, isValidTckn, isValidVknTckn, isUuid } = require('../src/ingest/normalize');
  assert.equal(isValidVkn('1234567890'), true);
  assert.equal(isValidVkn('1234567891'), false);
  assert.equal(isValidVkn('1111111111'), false);
  assert.equal(isValidVkn('123'), false);
  assert.equal(isValidTckn('10000000146'), true);
  assert.equal(isValidTckn('12345678901'), false);
  assert.equal(isValidTckn('01234567890'), false);
  assert.equal(isValidVknTckn('10000000146'), true);
  assert.equal(isUuid('a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6'), true);
  assert.equal(isUuid('[ETTN_UUID]'), false);
});
