/**
 * Read a filled questionnaire FILE into blocks: paragraphs and tables, in document order.
 *
 * The client fills «Дали — Мэдээлэл цуглуулах маягт» in Word or in Google Docs. Both give
 * the operator one of two files:
 *
 *  - `.docx` — Word's own format, and what Google Docs downloads as «Microsoft Word». A zip
 *    holding `word/document.xml`.
 *  - `.md` / `.txt` — the text export (Google Docs «Markdown» or a Drive text read), where a
 *    table is `| a | b |` rows.
 *
 * Both are reduced to the same `FormBlock[]`, and nothing downstream knows which it was.
 * This file interprets NOTHING: it does not know what a question is. It reports what is on
 * the page; `questionnaire.ts` decides what it means.
 *
 * No dependency is added for it. A docx is a zip of well-formed XML, and the two things
 * needed — the zip directory and `inflateRaw` — are in Node. A parser that cannot finish
 * (an encrypted or damaged file) throws with the reason rather than returning the part it
 * read (D-057).
 */
import { inflateRawSync } from 'node:zlib';
import { nfc } from '../mn/text.ts';

export type FormBlock =
  | { type: 'p'; text: string }
  | { type: 'table'; rows: string[][] };

// ---- zip ------------------------------------------------------------------

/** The named entries of a zip archive. Throws on anything it cannot read in full. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: signature 0x06054b50, searched backwards past any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-directory record) — is this really a .docx?');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`zip directory entry ${n} is damaged`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if ((flags & 1) !== 0) throw new Error(`«${name}» is encrypted — ask for an unprotected copy`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip entry «${name}» is damaged`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`zip entry «${name}» uses compression method ${method}, which this reader does not support`);
  }
  return out;
}

// ---- xml ------------------------------------------------------------------

export type XNode = { tag: string; attrs: Record<string, string>; children: (XNode | string)[] };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1), 10))
        : ENTITIES[e] ?? '');
}

/** A minimal well-formed-XML tree. Enough for WordprocessingML; not a general parser. */
export function parseXml(xml: string): XNode {
  const root: XNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) { top.children.push(m[1]); continue; }
    if (m[6] !== undefined) { top.children.push(unescapeXml(m[6])); continue; }
    if (m[3] === undefined) continue; // comment, declaration
    if (m[2] === '/') {
      if (top.tag !== m[3]) throw new Error(`malformed XML: </${m[3]}> closes <${top.tag}>`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? '').matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]!] = unescapeXml(a[3] ?? a[4] ?? '');
    }
    const node: XNode = { tag: m[3], attrs, children: [] };
    top.children.push(node);
    if (m[5] !== '/') stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`malformed XML: <${stack[stack.length - 1]!.tag}> never closed`);
  return root;
}

export const kids = (n: XNode): XNode[] => n.children.filter((c): c is XNode => typeof c !== 'string');

/**
 * The visible text of a node. A ticked Word checkbox content control reads as ☒, an
 * unticked one as ☐, whatever glyph the template drew — the questionnaire's choices are
 * checkboxes, and the tick is the answer.
 */
function textOf(n: XNode): string {
  let s = '';
  for (const c of n.children) {
    if (typeof c === 'string') continue;
    switch (c.tag) {
      case 'w:t': s += c.children.filter((x): x is string => typeof x === 'string').join(''); break;
      case 'w:tab': s += '\t'; break;
      case 'w:br': case 'w:cr': s += '\n'; break;
      case 'w:p': s += `${textOf(c)}\n`; break;
      case 'w:sdt': {
        const pr = kids(c).find((k) => k.tag === 'w:sdtPr');
        const box = pr === undefined ? undefined : kids(pr).find((k) => k.tag === 'w14:checkbox');
        if (box !== undefined) {
          const checked = kids(box).find((k) => k.tag === 'w14:checked');
          const on = checked !== undefined && ['1', 'true'].includes(checked.attrs['w14:val'] ?? '');
          const content = kids(c).find((k) => k.tag === 'w:sdtContent');
          // The glyph inside the control is replaced by the control's own state.
          const inner = content === undefined ? '' : textOf(content).replace(/[☐☒☑✓✔]/gu, '');
          s += `${on ? '☒' : '☐'}${inner}`;
        } else {
          s += textOf(c);
        }
        break;
      }
      default: s += textOf(c);
    }
  }
  return s;
}

function tableRows(tbl: XNode): string[][] {
  return kids(tbl).filter((r) => r.tag === 'w:tr').map((tr) =>
    kids(tr).filter((c) => c.tag === 'w:tc').map((tc) => cleanCell(textOf(tc))));
}

const cleanCell = (s: string): string =>
  nfc(s).replace(/ /g, ' ').split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');

/** The blocks of a `.docx`, in order. Tables nested in a cell are flattened into its text. */
export function docxBlocks(buf: Buffer): FormBlock[] {
  const doc = readZip(buf).get('word/document.xml');
  if (doc === undefined) throw new Error('no word/document.xml — this zip is not a Word document');
  const tree = parseXml(doc.toString('utf8'));
  const body = kids(tree).flatMap(kids).find((n) => n.tag === 'w:body');
  if (body === undefined) throw new Error('word/document.xml has no body');
  const out: FormBlock[] = [];
  const walk = (n: XNode) => {
    for (const c of kids(n)) {
      if (c.tag === 'w:p') {
        const t = cleanCell(textOf(c));
        if (t !== '') out.push({ type: 'p', text: t });
      } else if (c.tag === 'w:tbl') {
        out.push({ type: 'table', rows: tableRows(c) });
      } else if (c.tag === 'w:sdt') {
        const content = kids(c).find((k) => k.tag === 'w:sdtContent');
        if (content !== undefined) walk(content);
      }
    }
  };
  walk(body);
  return out;
}

// ---- text export ------------------------------------------------------------

/**
 * The blocks of a Markdown/text export. `| a | b |` lines are a table; a `| :-: |`
 * separator is dropped; anything else is a paragraph. Markdown emphasis and escapes are
 * removed, since `**1.1 Нэр**` and `1.1 Нэр` are the same label.
 */
export function textBlocks(text: string): FormBlock[] {
  const out: FormBlock[] = [];
  let table: string[][] | null = null;
  for (const rawLine of nfc(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('|') && line.endsWith('|') && line.length > 1) {
      const cells = splitRow(line);
      const bare = cells.map((c) => c.trim());
      if (bare.every((c) => /^:?-+:?$/.test(c) || c === '') && bare.some((c) => c !== '')) continue; // the separator row
      table ??= [];
      table.push(cells.map(stripMarkdown));
      continue;
    }
    if (table !== null) { out.push({ type: 'table', rows: table }); table = null; }
    const t = stripMarkdown(line);
    if (t !== '') out.push({ type: 'p', text: t });
  }
  if (table !== null) out.push({ type: 'table', rows: table });
  return out;
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 1; i < line.length - 1; i++) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length - 1) { cur += ch + line[i + 1]!; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

function stripMarkdown(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\([\\*_|#`\-.[\]()~])/g, '$1')
    .replace(/\*\*|__/g, '')
    // What is left is italic: in the form that is the hint under a question's label, run
    // straight on in the export («**1.5 Хаяг***Google Maps…*»). A line break keeps them apart.
    .replace(/\*/g, '\n')
    .replace(/ /g, ' ')
    .split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n')
    .trim();
}

/** Blocks from a file's bytes, by its name. */
export function formBlocks(name: string, bytes: Buffer): FormBlock[] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return docxBlocks(bytes);
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return textBlocks(bytes.toString('utf8'));
  throw new Error(`«${name}»: expected a .docx (Word, or Google Docs → Download → Microsoft Word) or a .md/.txt export`);
}
