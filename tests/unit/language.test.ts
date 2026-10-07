import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChapterLanguages, detectLanguage, languageName } from '../../src/modules/language';

const GERMAN =
  'Jede Überschrift wird ein Kapitel. Das Plugin teilt eine Notiz an ihren Überschriften, so dass man direkt zu dem Teil springen kann, den man hören möchte.';
const ENGLISH =
  'Every heading is a chapter. The plugin splits a note at its headings, so you can jump straight to the part you want, just like in an audiobook.';

test('German and English paragraphs are told apart', () => {
  assert.equal(detectLanguage(GERMAN), 'de');
  assert.equal(detectLanguage(ENGLISH), 'en');
});

test('a short heading is unknown on its own', () => {
  assert.equal(detectLanguage('Listen faster'), null);
  assert.equal(detectLanguage('## Überschrift'), null);
});

test('short chapters take the language of the note around them', () => {
  const langs = detectChapterLanguages(['Schneller hören', GERMAN, 'Fazit']);
  assert.deepEqual(langs, ['de', 'de', 'de']);
});

test('a long chapter keeps its own language inside a note in another one', () => {
  const langs = detectChapterLanguages([GERMAN, ENGLISH, GERMAN]);
  assert.deepEqual(langs, ['de', 'en', 'de']);
});

test('language names are spelled out', () => {
  assert.equal(languageName('de'), 'German');
  assert.equal(languageName('xx'), 'XX');
});
