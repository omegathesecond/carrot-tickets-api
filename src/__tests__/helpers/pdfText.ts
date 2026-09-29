// src/__tests__/helpers/pdfText.ts
import zlib from 'zlib';

/**
 * Pull the visible text out of a PDFKit-generated PDF, so a test can assert on
 * what a reader actually sees rather than settling for "the bytes start with
 * %PDF-".
 *
 * PDFKit Flate-compresses each content stream, so the text is not greppable in
 * the raw buffer. This walks the `stream` … `endstream` pairs, inflates each
 * one, and collects the strings the text-showing operators draw. PDFKit emits
 * those as HEX strings inside a `TJ` array (`[<48454c4c4f> 0] TJ`) for the
 * standard fonts, which are WinAnsi-encoded — an em dash arrives as byte 0x97,
 * not as U+2014 — so the bytes are mapped back through WinAnsi. Literal
 * `(…)` strings are collected too, for the operators that use them.
 *
 * It is NOT a general PDF parser: no layout, no reading order, no embedded
 * subset fonts. It is enough to prove a heading, a column label or a dash
 * reached the page. Deliberately dependency-free — a pdf-parse-class library
 * would be a production dependency carried solely for assertions.
 */
export function extractPdfText(buffer: Buffer): string {
  const out: string[] = [];

  for (const stream of inflateStreams(buffer)) {
    // One `TJ` array is ONE run of text, split into pieces at each kerning
    // adjustment — "Stock" arrives as `<53746f63> -12 <6b>`. Joining the pieces
    // of an operator with nothing, and only separating one operator from the
    // next, is what makes `toContain('Stock')` mean what it looks like.
    for (const op of stream.matchAll(/\[([^\]]*)\]\s*TJ|((?:<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\()])*\))\s*Tj)/g)) {
      out.push(decodeStrings(op[1] ?? op[2] ?? ''));
    }
  }
  return out.join('\n');
}

/** Decode every string literal in one text-showing operator, in order. */
function decodeStrings(operand: string): string {
  let text = '';
  for (const match of operand.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
    const [, hex, literal] = match;
    if (hex !== undefined) text += decodeHexString(hex);
    else if (literal !== undefined) text += decodeLiteralString(literal);
  }
  return text;
}

/** Every `stream` … `endstream` body in the file, Flate-inflated where possible. */
function* inflateStreams(buffer: Buffer): Generator<string> {
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let at = 0;

  while (at < buffer.length) {
    const start = buffer.indexOf(marker, at);
    if (start === -1) return;
    // `endstream` contains "stream"; skip the hits that are really the tail of
    // a stream already emitted.
    if (start >= 3 && buffer.subarray(start - 3, start + marker.length).toString() === 'endstream') {
      at = start + marker.length;
      continue;
    }
    const end = buffer.indexOf(endMarker, start);
    if (end === -1) return;

    // The body starts after the EOL that follows the `stream` keyword.
    let bodyStart = start + marker.length;
    if (buffer[bodyStart] === 0x0d) bodyStart++;
    if (buffer[bodyStart] === 0x0a) bodyStart++;

    const body = buffer.subarray(bodyStart, end);
    try {
      yield zlib.inflateSync(body).toString('latin1');
    } catch {
      // Not Flate-compressed (or not a content stream at all) — font programs
      // land here. Reading it raw costs nothing.
      yield body.toString('latin1');
    }
    at = end + endMarker.length;
  }
}

/**
 * WinAnsiEncoding's 0x80–0x9F block, where it departs from Latin-1. Everything
 * else in the range agrees with Latin-1 closely enough for assertions.
 */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeHexString(hex: string): string {
  const digits = hex.replace(/\s+/g, '');
  let text = '';
  for (let i = 0; i + 1 < digits.length; i += 2) {
    const byte = parseInt(digits.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) continue;
    text += WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte);
  }
  return text;
}

/** Resolve the escapes PDF string literals use. */
function decodeLiteralString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c))
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}
