import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitIntoChapters } from '../../src/modules/chapter-split';
import { filterMarkdown } from '../../src/utils';
import { DEFAULT_SETTINGS } from '../../src/modules/settings-data';

const clean = (md: string) => filterMarkdown(md, DEFAULT_SETTINGS.textFiltering, DEFAULT_SETTINGS.symbolReplacement);
const split = (md: string, readHeadings = true) => splitIntoChapters(md, { noteTitle: 'My note', readHeadings, clean });

test('one chapter per heading, opening text first', () => {
  const chapters = split('Opening words.\n\n# One\n\nFirst body.\n\n## Two\n\nSecond body.\n');
  assert.deepEqual(chapters.map((c) => c.title), ['My note', 'One', 'Two']);
  assert.deepEqual(chapters.map((c) => c.level), [0, 1, 2]);
  assert.equal(chapters[0].text, 'My note.\n\nOpening words.');
  assert.equal(chapters[1].text, 'One.\n\nFirst body.');
  assert.ok(chapters.every((c) => c.hasTitle && !c.empty));
});

test('properties at the top are neither read nor counted as a chapter', () => {
  const chapters = split('---\ntags: [a]\ntitle: x\n---\n# One\n\nBody.\n');
  assert.deepEqual(chapters.map((c) => c.title), ['One']);
  assert.equal(chapters[0].line, 4);
});

test('a note without headings is a single chapter and its name is not announced', () => {
  const chapters = split('Just some text.\n\nMore text.');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, 'My note');
  assert.equal(chapters[0].hasTitle, false);
  assert.equal(chapters[0].text, 'Just some text.\n\nMore text.');
});

test('a # inside a code block is not a heading', () => {
  const chapters = split('# Real\n\nText.\n\n```bash\n# not a heading\necho hi\n```\n\nAfter.\n');
  assert.deepEqual(chapters.map((c) => c.title), ['Real']);
  assert.equal(chapters[0].text, 'Real.\n\nText.\n\nAfter.');
});

test('repeated titles get distinct keys', () => {
  const chapters = split('## Notes\n\nA.\n\n## Other\n\nB.\n\n## Notes\n\nC.\n');
  assert.deepEqual(chapters.map((c) => c.key), ['notes', 'other', 'notes~1']);
});

test('titles are cleaned of Markdown and closing hashes', () => {
  const chapters = split('## The **big** [[Idea|idea]] ##\n\nBody.\n');
  assert.equal(chapters[0].title, 'The big idea');
});

test('a title that already ends in punctuation gets no extra full stop', () => {
  const chapters = split('## Why does it work?\n\nBecause.\n');
  assert.equal(chapters[0].text, 'Why does it work?\n\nBecause.');
});

test('with headings off, only the body is read and an image-only section is empty', () => {
  const chapters = split('## Pictures\n\n![[photo.png]]\n\n## Words\n\nHello.\n', false);
  assert.equal(chapters[0].empty, true);
  assert.equal(chapters[1].text, 'Hello.');
  assert.equal(chapters[1].hasTitle, false);
});

test('a heading with nothing under it still says its title', () => {
  const chapters = split('# Part one\n\n## Detail\n\nText.\n');
  assert.equal(chapters[0].text, 'Part one.');
  assert.equal(chapters[0].empty, false);
});

test('each spoken paragraph points back at its note lines', () => {
  const md = '---\ntags: [a]\n---\nOpening.\n\n# One\n\nFirst body.\n\n- bullet a\n- bullet b\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nLast.\n';
  const chapters = split(md);
  // Opening text: title (note name) + one paragraph on line 3; the chapter ends before the heading on line 5.
  assert.deepEqual([chapters[0].line, chapters[0].endLine], [0, 4]);
  assert.deepEqual(chapters[0].paragraphLines, [[3, 3], [3, 3]]);
  // "One": heading line 5, body paragraphs on 7, the two bullets (one block, two spoken paragraphs) on 9-10,
  // the fenced code is skipped by the filters, "Last." on 18.
  const one = chapters[1];
  assert.deepEqual([one.line, one.endLine], [5, 19]); // the trailing newline is an empty last line
  assert.deepEqual(one.paragraphLines, [[5, 5], [7, 7], [9, 10], [9, 10], [18, 18]]);
  assert.equal(one.text.split(/\n\s*\n/).length, one.paragraphLines!.length);
});

test('a chapter whose spoken paragraphs cannot be matched reports no paragraph lines', () => {
  // Cleaning the whole body yields one paragraph; cleaning each block alone yields two.
  const odd = (md: string) => (md.includes('\n\n') ? 'joined paragraph' : md);
  const chapters = splitIntoChapters('# One\n\nA.\n\nB.\n', { noteTitle: 'n', readHeadings: false, clean: odd });
  assert.equal(chapters[0].paragraphLines, null);
});

test('a heading inside a comment does not start a chapter, and the comment is not spoken', () => {
  const chapters = split('# Real\n\nVisible.\n\n%%\n# Secret\nPrivate words.\n%%\n\nAfter.\n');
  assert.deepEqual(chapters.map((c) => c.title), ['Real']);
  assert.ok(!chapters[0].text.includes('Private'), chapters[0].text);
  assert.ok(chapters[0].text.includes('After.'));
  const html = split('# Real\n\n<!--\n## Hidden\nSecret.\n-->\n\nShown.\n');
  assert.deepEqual(html.map((c) => c.title), ['Real']);
  assert.ok(!html[0].text.includes('Secret'));
});

test('tilde and longer fences are code blocks too', () => {
  const chapters = split('# One\n\nText.\n\n~~~js\n# not a heading\nconst x = 1;\n~~~\n\n````md\n```\n## inner\n```\n````\n\nEnd.\n');
  assert.deepEqual(chapters.map((c) => c.title), ['One']);
  assert.ok(!chapters[0].text.includes('const x'), chapters[0].text);
  assert.ok(!chapters[0].text.includes('inner'), chapters[0].text);
  assert.ok(chapters[0].text.includes('End.'));
});
