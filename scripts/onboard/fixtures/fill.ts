/**
 * Fill the real, blank «Дали — Мэдээлэл цуглуулах маягт» with a JSON of answers and write a
 * .docx — the way a client's filled form arrives.
 *
 * A TEST TOOL. The blank template (`dali-form-blank.docx`) is the founder's Google Doc,
 * downloaded as Word on 2026-09-27, byte for byte; filling it (rather than generating a
 * look-alike) is what proves the reader works on the file a client actually sends back.
 *
 *     node scripts/onboard/fixtures/fill.ts <answers.json> <out.docx> [<blank.docx>]
 *
 * The blank defaults to `dali-form-v2-blank.docx`, the form the founder sends clients
 * («Дали_маягт_DalaTech.docx», 2026-09-27). A tick is ☒ unless the option is written
 * `✓:label` (another glyph clients use), and `text` may answer a checkbox question with
 * typed words, as a client who deletes the boxes does.
 *
 * Answers: `text` by question number, `tick` (question → option label prefixes, with an
 * optional `extra` after `|`), and `tables` (hours/services/staff/faqs/signer rows).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { kids, parseXml, readZip, type XNode } from '../../../src/lib/provision/formFile.ts';

type Answers = {
  text: Record<string, string>;
  tick: Record<string, string[]>;
  tables: { hours: string[][]; services: string[][]; staff: string[][]; faqs: string[][]; signer: string[] };
};

const [answersPath, outPath, blankPath] = process.argv.slice(2);
if (answersPath === undefined || outPath === undefined) {
  process.stderr.write('usage: node scripts/onboard/fixtures/fill.ts <answers.json> <out.docx>\n');
  process.exit(2);
}
const answers = JSON.parse(readFileSync(answersPath, 'utf8')) as Answers;
const blank = readZip(readFileSync(blankPath ?? new URL('./dali-form-v2-blank.docx', import.meta.url)));
const tree = parseXml(blank.get('word/document.xml')!.toString('utf8'));

const all = (n: XNode, tag: string): XNode[] => kids(n).flatMap((k) => [...(k.tag === tag ? [k] : []), ...all(k, tag)]);
const text = (n: XNode): string => all(n, 'w:t').map((t) => t.children.filter((c) => typeof c === 'string').join('')).join('');
const paraText = (p: XNode): string => text(p);

/** Replace a cell's content with `value`, one run, lines joined by <w:br/>. */
function setCell(tc: XNode, value: string): void {
  const p = kids(tc).find((k) => k.tag === 'w:p');
  if (p === undefined) throw new Error('cell has no paragraph');
  for (const other of kids(tc).filter((k) => k.tag === 'w:p' && k !== p)) tc.children.splice(tc.children.indexOf(other), 1);
  p.children = p.children.filter((c) => typeof c !== 'string' && c.tag === 'w:pPr');
  const run: XNode = { tag: 'w:r', attrs: {}, children: [] };
  value.split('\n').forEach((line, i) => {
    if (i > 0) run.children.push({ tag: 'w:br', attrs: {}, children: [] });
    run.children.push({ tag: 'w:t', attrs: { 'xml:space': 'preserve' }, children: [line] });
  });
  p.children.push(run);
}

/** Tick the options whose text begins with a wanted label; write `extra` into its blank. */
function tick(tc: XNode, wanted: string[]): void {
  for (const raw of wanted) {
    const glyph = raw.startsWith('✓:') ? '✓' : '☒';
    const want = raw.startsWith('✓:') ? raw.slice(2) : raw;
    const [label, extra] = want.split('|');
    const p = all(tc, 'w:p').find((x) => paraText(x).replace(/^[☐\s]+/u, '').startsWith(label!));
    if (p === undefined) throw new Error(`no option «${label}» in «${text(tc).slice(0, 60)}»`);
    const box = all(p, 'w:t').find((t) => String(t.children[0] ?? '').includes('☐'));
    if (box === undefined) throw new Error(`option «${label}» has no box`);
    box.children = [String(box.children[0]).replace('☐', glyph)];
    if (extra !== undefined) {
      const dots = all(p, 'w:t').find((t) => /\.{5,}/u.test(String(t.children[0] ?? '')));
      if (dots === undefined) throw new Error(`option «${label}» has no blank for «${extra}»`);
      dots.children = [String(dots.children[0]).replace(/\.{5,}/u, extra)];
    }
  }
}

const used = new Set<string>();
for (const tbl of all(tree, 'w:tbl')) {
  const rows = kids(tbl).filter((k) => k.tag === 'w:tr');
  const cells = (r: XNode) => kids(r).filter((k) => k.tag === 'w:tc');
  const head = cells(rows[0]!).map((c) => text(c));
  const table = head[0] === 'Өдөр' ? answers.tables.hours
    : head[0] === 'Үйлчилгээний нэр' ? answers.tables.services
      : head[0]?.startsWith('Нэр (') ? answers.tables.staff
        : head[0] === 'Асуулт' && head.length === 2 ? answers.tables.faqs : null;
  if (table !== null) {
    table.forEach((values, i) => {
      const r = rows[i + 1];
      if (r === undefined) throw new Error(`table «${head[0]}» has only ${rows.length - 1} rows`);
      values.forEach((v, j) => { if (v !== '') setCell(cells(r)[j]!, v); });
    });
    continue;
  }
  if (head[0] === 'Нэр' && rows.length >= 4) {
    rows.forEach((r, i) => { const v = answers.tables.signer[i]; if (v) setCell(cells(r)[1]!, v); });
    continue;
  }
  for (const r of rows) {
    const cs = cells(r);
    if (cs.length < 2) continue;
    const id = /^(\d{1,2}\.\d{1,2})\s/u.exec(text(cs[0]!))?.[1];
    if (id === undefined) continue;
    if (answers.text[id] !== undefined) { setCell(cs[1]!, answers.text[id]!); used.add(id); }
    if (answers.tick[id] !== undefined) { tick(cs[1]!, answers.tick[id]!); used.add(id); }
  }
}
for (const id of [...Object.keys(answers.text), ...Object.keys(answers.tick)]) {
  if (!used.has(id)) throw new Error(`answer for ${id} found no question in the form`);
}

// ---- serialise and zip --------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
function ser(n: XNode | string): string {
  if (typeof n === 'string') return esc(n);
  const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${attr(v)}"`).join('');
  return n.children.length === 0 ? `<${n.tag}${a}/>` : `<${n.tag}${a}>${n.children.map(ser).join('')}</${n.tag}>`;
}
const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${tree.children.map(ser).join('')}`;
blank.set('word/document.xml', Buffer.from(xml, 'utf8'));

const locals: Buffer[] = [];
const central: Buffer[] = [];
let offset = 0;
for (const [name, data] of blank) {
  const nameBuf = Buffer.from(name, 'utf8');
  const packed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(8, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(offset, 42);
  locals.push(local, nameBuf, packed);
  central.push(cen, nameBuf);
  offset += 30 + nameBuf.length + packed.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(blank.size, 8); end.writeUInt16LE(blank.size, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
writeFileSync(outPath, Buffer.concat([...locals, cd, end]));
process.stdout.write(`wrote ${outPath}\n`);
