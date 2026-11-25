import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countWords, isWordCodePoint, splitSentences, tokenizeWords } from './text';

const sentences = (text: string) => splitSentences(text).map((r) => text.slice(r.start, r.end));

describe('countWords / tokenizeWords', () => {
  it.each<[string, number]>([
    ['', 0],
    ['   ', 0],
    ['one', 1],
    ['The rain fell sideways.', 4],
    ["don't stop", 2],
    ['don’t stop', 2],
    ['a well-known fact', 3],
    ['rock ’n’ roll', 3],
    ['pi is 3.14, about 1,000 times less', 7],
    ['end.Start', 2],
    ['wait—what', 2],
    ['so … then', 2],
    ['“Quoted,” she said.', 3],
    ['café naïve résumé', 3],
    ['Ελληνικά и русский', 3],
    ['été', 1], // combining accent stays inside the word
    ['50% off — $20', 3],
    ['hello 🙂 world', 2],
    ['--', 0],
    ["'quoted'", 1],
    ['x-', 1],
    ['3.', 1],
  ])('%j → %i words', (text, n) => {
    expect(countWords(text)).toBe(n);
  });

  it('returns offsets that slice back to the token text', () => {
    const text = 'Hello, wörld — it’s 3.5 o’clock 😀 ok';
    for (const t of tokenizeWords(text)) expect(text.slice(t.start, t.end)).toBe(t.text);
    expect(tokenizeWords(text).map((t) => t.text)).toEqual([
      'Hello',
      'wörld',
      'it’s',
      '3.5',
      'o’clock',
      'ok',
    ]);
  });

  it('classifies astral letters as word characters', () => {
    expect(isWordCodePoint(0x1d400)).toBe(true); // MATHEMATICAL BOLD CAPITAL A
    expect(isWordCodePoint(0x1f600)).toBe(false); // emoji
    expect(countWords('𝐀𝐁 cd')).toBe(2);
  });

  it('property: count equals tokens and tokens are disjoint and ordered', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (s) => {
        const toks = tokenizeWords(s);
        expect(countWords(s)).toBe(toks.length);
        let prev = -1;
        for (const t of toks) {
          expect(t.start).toBeGreaterThan(prev);
          expect(t.end).toBeGreaterThan(t.start);
          prev = t.end - 1;
        }
      }),
    );
  });
});

describe('splitSentences', () => {
  it.each<[string, string[]]>([
    ['', []],
    ['   \n ', []],
    ['One sentence', ['One sentence']],
    ['One. Two. Three.', ['One.', 'Two.', 'Three.']],
    ['  Leading and trailing.  ', ['Leading and trailing.']],
    ['Is it? Yes! Good.', ['Is it?', 'Yes!', 'Good.']],
    ['What?! Really?!', ['What?!', 'Really?!']],
    // Abbreviations
    ['Mr. Smith met Dr. Jones. They talked.', ['Mr. Smith met Dr. Jones.', 'They talked.']],
    [
      'Mrs. Dalloway said she would buy the flowers herself.',
      ['Mrs. Dalloway said she would buy the flowers herself.'],
    ],
    ['Fruit, e.g. Apples, is good. I agree.', ['Fruit, e.g. Apples, is good.', 'I agree.']],
    ['Use a tool (i.e. A hammer). Then stop.', ['Use a tool (i.e. A hammer).', 'Then stop.']],
    ['Bring pens, paper, etc. and a ruler.', ['Bring pens, paper, etc. and a ruler.']],
    [
      'Bring pens, paper, etc. The rest is provided.',
      ['Bring pens, paper, etc.', 'The rest is provided.'],
    ],
    ['Smith et al. (2020) disagree. We do not.', ['Smith et al. (2020) disagree.', 'We do not.']],
    ['See No. 5 and pp. 12–14. Done.', ['See No. 5 and pp. 12–14.', 'Done.']],
    [
      'Roe v. Wade was decided. Later cases followed.',
      ['Roe v. Wade was decided.', 'Later cases followed.'],
    ],
    ['It was approx. ten metres.', ['It was approx. ten metres.']],
    ['I took it in 2020. 2021 was worse.', ['I took it in 2020.', '2021 was worse.']],
    // Initials and enumerators
    ['J. K. Rowling wrote it. She is British.', ['J. K. Rowling wrote it.', 'She is British.']],
    ['1. First do this. 2. Then that.', ['1. First do this.', '2. Then that.']],
    // Decimals and dotted tokens
    ['Pi is 3.14159. It is irrational.', ['Pi is 3.14159.', 'It is irrational.']],
    ['Version 2.0.1 shipped. Users cheered.', ['Version 2.0.1 shipped.', 'Users cheered.']],
    ['Visit example.com today. Or not.', ['Visit example.com today.', 'Or not.']],
    // Ellipses
    ['Wait... what happened?', ['Wait... what happened?']],
    ['It ended... The next day began.', ['It ended...', 'The next day began.']],
    ['So… Maybe.', ['So…', 'Maybe.']],
    ['And then… nothing.', ['And then… nothing.']],
    // Quotes and brackets after terminal punctuation
    ['"Stop!" she cried. He stopped.', ['"Stop!" she cried.', 'He stopped.']],
    ['“Really?” he asked. “Yes.” She nodded.', ['“Really?” he asked.', '“Yes.”', 'She nodded.']],
    ['He said, "Go." Then he left.', ['He said, "Go."', 'Then he left.']],
    ['(This is aside.) Back to it.', ['(This is aside.)', 'Back to it.']],
    [
      "'Tired,' she said. 'Very.' Then silence.",
      ["'Tired,' she said.", "'Very.'", 'Then silence.'],
    ],
    ['She whispered, “Run.” And they ran.', ['She whispered, “Run.”', 'And they ran.']],
    // No boundary without following whitespace or before punctuation
    ['The U.S.A. is large.', ['The U.S.A. is large.']],
    ['Wait. — No.', ['Wait. — No.']],
    ['Hi.there', ['Hi.there']],
    // Line breaks are whitespace
    ['Line one\nline two. Next', ['Line one\nline two.', 'Next']],
    // Non-Latin
    ['Привет. Как дела?', ['Привет.', 'Как дела?']],
    ['今日は晴れ。明日は雨。', ['今日は晴れ。', '明日は雨。']],
  ])('%j', (text, expected) => {
    expect(sentences(text)).toEqual(expected);
  });

  it('property: ranges are ordered, non-overlapping, non-empty and trimmed', () => {
    const alphabet = fc.constantFrom(
      'a',
      'B',
      ' ',
      '.',
      '!',
      '?',
      '"',
      '”',
      ')',
      '(',
      '\n',
      '…',
      'Mr',
      'e.g',
      '1',
      ',',
      'x',
    );
    fc.assert(
      fc.property(
        fc.array(alphabet, { maxLength: 60 }).map((a) => a.join('')),
        (s) => {
          const ranges = splitSentences(s);
          let prevEnd = 0;
          for (const r of ranges) {
            expect(r.start).toBeGreaterThanOrEqual(prevEnd);
            expect(r.end).toBeGreaterThan(r.start);
            expect(s[r.start]).not.toMatch(/\s/);
            expect(s[r.end - 1]).not.toMatch(/\s/);
            // only whitespace between sentences
            expect(s.slice(prevEnd, r.start).trim()).toBe('');
            prevEnd = r.end;
          }
          expect(s.slice(prevEnd).trim()).toBe('');
        },
      ),
    );
  });

  it('is deterministic (same input, same output)', () => {
    const text = 'Mr. A. B. Cee said "Hi!" to Dr. D. Then... It rained. e.g. Fine.';
    expect(splitSentences(text)).toEqual(splitSentences(text));
  });
});
