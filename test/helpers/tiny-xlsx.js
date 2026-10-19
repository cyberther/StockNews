// A tiny xlsx (a zip with no compression) for the SEAP tests: one sheet, shared strings for
// text cells, numbers as numbers, like the open-data files.
import { writeFileSync } from 'node:fs';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'), n = Buffer.from(name), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    parts.push(h, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const col = i => String.fromCharCode(65 + i);
export function writeXlsx(path, rows) {
  const strings = [];
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
    if (v == null) return '';
    if (typeof v === 'number') return `<c r="${col(ci)}${ri + 1}" s="8"><v>${v}</v></c>`;
    let i = strings.indexOf(v); if (i < 0) { strings.push(v); i = strings.length - 1; }
    return `<c r="${col(ci)}${ri + 1}" s="8" t="s"><v>${i}</v></c>`;
  }).join('') + '</row>').join('');
  writeFileSync(path, zip([
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData>${sheet}</sheetData></worksheet>`],
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst>${strings.map(s => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`]
  ]));
}
