import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pdfText } from '../tools/filings-extract.mjs';


// The runner is mocked; supply only the installation paths checked before invoking it.
const doclingDir = mkdtempSync(join(tmpdir(), 'test-docling-'));
mkdirSync(join(doclingDir, 'runtime/bin'), { recursive: true });
writeFileSync(join(doclingDir, 'runtime/bin/python'), 'fixture, never executed');
writeFileSync(join(doclingDir, 'market-pulse-ocr.py'), '# fixture, never executed');
after(() => rmSync(doclingDir, { recursive: true, force: true }));

test('PDF with text bypasses OCR and removes temporary files', async () => {
  let file, calls = 0;
  const text = 'Document financiar '.repeat(30);
  assert.equal(await pdfText(Buffer.from('pdf'), 8, { run: async (_, args) => {
    calls++; file = args.at(-2); return { stdout: text };
  } }), text.trim());
  assert.equal(calls, 1);
  assert.equal(existsSync(dirname(file)), false);
});

test('sparse PDF invokes OCR with page limit and timeout', async () => {
  let calls = 0, file;
  assert.equal(await pdfText(Buffer.from('pdf'), 3, { doclingDir, timeout: 12000, run: async (cmd, args, options) => {
    if (++calls === 1) return { stdout: 'scan' };
    assert.match(cmd, /runtime\/bin\/python$/);
    assert.equal(args[2], '3');
    assert.equal(options.timeout, 12000);
    file = args[1];
    return { stdout: JSON.stringify({ text: 'Text recuperat din scanare', pages: [{ page: 1, ocr: true, rotation: 90 }], cache_hit: false, pipeline: 'page-ocr-v2' }) };
  } }), 'Text recuperat din scanare');
  assert.equal(calls, 2);
  assert.equal(existsSync(dirname(file)), false);
});

test('OCR failure propagates for retry and removes temporary files', async () => {
  let calls = 0, file;
  await assert.rejects(pdfText(Buffer.from('pdf'), 8, { doclingDir, run: async (_, args) => {
    if (++calls === 1) return { stdout: '' };
    file = args[1]; throw new Error('OCR timeout');
  } }), /OCR timeout/);
  assert.equal(existsSync(dirname(file)), false);
});

test('missing OCR installation remains an explicit production error', async () => {
  await assert.rejects(pdfText(Buffer.from('pdf'), 8, {doclingDir:join(doclingDir,'missing'),run:async()=>({stdout:''})}), /Docling OCR installation unavailable/);
});
