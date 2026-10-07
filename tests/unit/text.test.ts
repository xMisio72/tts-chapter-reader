import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAPTER_LEAD_MS, estimateSeconds, groupSegments, toSegments, withChapterLead } from '../../src/modules/text-segments';
import { filterMarkdown } from '../../src/utils';
import { DEFAULT_SETTINGS } from '../../src/modules/settings-data';

const clean = (md: string) => filterMarkdown(md, DEFAULT_SETTINGS.textFiltering, DEFAULT_SETTINGS.symbolReplacement);

// ---------------------------------------------------------------- segments

test('the first piece is the first sentence, so playback can start early', () => {
  const segments = toSegments('Short opener. Then a second sentence follows. And a third one too.');
  assert.equal(segments[0].text, 'Short opener.');
  assert.equal(segments[1].text, 'Then a second sentence follows. And a third one too.');
});

test('the title gets the longest pause, paragraphs a medium one', () => {
  const segments = toSegments('My title.\n\nFirst paragraph here.\n\nSecond paragraph here.', { hasTitle: true });
  assert.deepEqual(segments.map((s) => s.pauseMs), [500, 350, 350]);
});

test('no piece is longer than the voice can take in one go', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} adds a few more words to the pile.`).join(' ');
  const oneGiantSentence = `${'word '.repeat(200)}end.`;
  for (const segment of [...toSegments(long), ...toSegments(oneGiantSentence)]) {
    assert.ok(segment.text.length <= 300, `piece of ${segment.text.length} characters`);
  }
});

test('nothing is lost or reordered when text is cut into pieces', () => {
  const text = 'Alpha one. Beta two, with a clause; and more! Gamma three?\n\nDelta four.';
  const rejoined = toSegments(text).map((s) => s.text).join(' ');
  assert.equal(rejoined.replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('grouping for network engines respects the size limit and paragraph breaks', () => {
  const segments = toSegments('Title.\n\nOne. Two. Three. Four.\n\nFive. Six.', { hasTitle: true });
  // The title is the quick first piece; paragraphs are never joined across their break.
  assert.deepEqual(groupSegments(segments, 900).map((g) => g.text), ['Title.', 'One. Two. Three. Four.', 'Five. Six.']);

  // Without a title the first sentence stands alone, then the rest is joined.
  const plain = toSegments(`First. ${'Another sentence that fills the piece up nicely. '.repeat(12)}`);
  const groups = groupSegments(plain, 900);
  assert.equal(groups[0].text, 'First.');
  assert.ok(groups.length < plain.length, 'later pieces are joined into bigger requests');
  assert.ok(groups.every((g) => g.text.length <= 900));
});

test('the chapter pause sits only before the first piece', () => {
  const segments = withChapterLead(toSegments('Title.\n\nOne. Two.\n\nThree.', { hasTitle: true }));
  assert.equal(segments[0].leadMs, CHAPTER_LEAD_MS);
  assert.ok(segments.slice(1).every((s) => s.leadMs === undefined));
  // Later pieces may still be joined for network voices; the first stays on its own.
  assert.equal(groupSegments(segments, 900)[0].text, 'Title.');
});

test('listening time is estimated from the word count', () => {
  assert.equal(estimateSeconds('word '.repeat(165)), 60);
  assert.equal(estimateSeconds(''), 1);
});

// ---------------------------------------------------------------- Markdown clean-up

test('a starred bullet keeps its first word', () => {
  assert.equal(clean('* Apples are red\n* Bridges are long'), 'Apples are red\n\nBridges are long');
});

test('emphasis markers go, snake_case stays', () => {
  assert.equal(clean('This is **bold**, *slanted* and _also slanted_, but my_file_name stays.'), 'This is bold, slanted and also slanted, but my_file_name stays.');
});

test('links are read by their text, addresses are dropped', () => {
  assert.equal(clean('See [the docs](https://example.com/a) and [[Other note|that note]] or [[Plain]].'), 'See the docs and that note or Plain.');
  assert.equal(clean('Visit https://example.com/page now.'), 'Visit now.');
});

test('code blocks, tables, images, comments and block ids are skipped', () => {
  const md = 'Before.\n\n```js\nlet x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![[img.png]]\n\n%% hidden %%\n\nAfter. ^abc123';
  assert.equal(clean(md), 'Before.\n\nAfter.');
});

test('checkboxes, numbered lists, quotes and rules leave only their text', () => {
  assert.equal(clean('- [x] Done thing\n- [ ] Open thing'), 'Done thing\n\nOpen thing');
  assert.equal(clean('1. First\n2. Second'), 'First\nSecond');
  assert.equal(clean('> A quote\n\n---\n\nText'), 'A quote\n\nText');
});

test('comparison symbols are spoken', () => {
  assert.equal(clean('Use it when x > 5 and y <= 3.'), 'Use it when x greater than 5 and y less than or equal to 3.');
});

test('custom comparison words get their spaces even when typed without them', () => {
  const symbols = { ...DEFAULT_SETTINGS.symbolReplacement, enableCustomReplacements: true, customReplacements: { greaterThan: 'über', lessThan: 'unter', greaterThanOrEqual: 'ab', lessThanOrEqual: 'bis' } };
  assert.equal(filterMarkdown('x > 5 und y <= 3', DEFAULT_SETTINGS.textFiltering, symbols), 'x über 5 und y bis 3');
});

test('with code blocks kept, the code is read but the fence lines are not', () => {
  const kept = { ...DEFAULT_SETTINGS.textFiltering, filterCodeBlocks: false };
  assert.equal(filterMarkdown('Before.\n```js\nlet x = 1;\n```\nAfter.', kept, DEFAULT_SETTINGS.symbolReplacement), 'Before.\nlet x = 1;\nAfter.');
});

test('words after a closing comment marker are spoken', () => {
  assert.equal(clean('Start <!-- note\nstill hidden --> and shown.\nNext.'), 'Start\nand shown.\nNext.');
  assert.equal(clean('Start %% note\nhidden %% and shown.'), 'Start\nand shown.');
});

test('skipping links entirely drops note links too', () => {
  const skip = { ...DEFAULT_SETTINGS.textFiltering, filterMarkdownLinks: true };
  assert.equal(filterMarkdown('See [docs](https://x.y) and [[Other|that]] or [[Plain]].', skip, DEFAULT_SETTINGS.symbolReplacement), 'See and or .');
});

test('a one-line formula leaves no dollar signs behind', () => {
  const math = { ...DEFAULT_SETTINGS.textFiltering, filterMathExpressions: true };
  assert.equal(filterMarkdown('Energy: $$E = mc^2$$ done. Also $a+b$ here.', math, DEFAULT_SETTINGS.symbolReplacement), 'Energy: done. Also here.');
});

test('an ordinal number keeps its sentence together', () => {
  const texts = toSegments('Am 7. Oktober 2026 wurden 13 Funktionen gebaut. Der 1. Punkt ist klar. Das war 2026. Danach kam mehr.').map((s) => s.text);
  // Sentences are joined into pieces afterwards; what matters is where the cuts are allowed.
  assert.equal(texts[0], 'Am 7. Oktober 2026 wurden 13 Funktionen gebaut.');
  assert.ok(texts.every((t) => !t.startsWith('Oktober') && !t.startsWith('Punkt')), JSON.stringify(texts));
});
