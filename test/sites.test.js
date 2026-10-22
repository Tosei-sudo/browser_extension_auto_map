import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invalidPatterns, isExcluded } from '../src/lib/sites.js';

test('URL が正規表現に合うサイトでは稼働しない', () => {
  const patterns = ['^https://mail\\.google\\.com/', 'EXAMPLE\\.org'];
  assert.equal(isExcluded('https://mail.google.com/mail/u/0/', patterns), true);
  assert.equal(isExcluded('https://www.example.org/page', patterns), true); // 大文字小文字は区別しない
  assert.equal(isExcluded('https://maps.google.com/', patterns), false);
  assert.equal(isExcluded('https://example.com/', []), false);
});

test('読めない正規表現と空行は無視する', () => {
  assert.equal(isExcluded('https://a.com/', ['(', '', '  ']), false);
  assert.equal(isExcluded('https://a.com/', ['(', 'a\\.com']), true);
  assert.deepEqual(invalidPatterns(['(', 'ok', '']), ['(']);
});
