import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inWindow, runPolicyAi, checkReply } from '../tools/policy-ai-batch.mjs';

const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));
// 2026-10-19 is in summer time in Bucharest (UTC+3).
const at = hhmm => new Date('2026-10-19T' + hhmm + ':00+03:00');

test('the window, in Bucharest time; one that crosses midnight', () => {
  assert.equal(inWindow(at('00:59'), '01-06'), false);
  assert.equal(inWindow(at('01:00'), '01-06'), true);
  assert.equal(inWindow(at('05:59'), '01-06'), true);
  assert.equal(inWindow(at('06:00'), '01-06'), false);
  assert.equal(inWindow(at('23:30'), '22-02'), true);
  assert.equal(inWindow(at('01:30'), '22-02'), true);
  assert.equal(inWindow(at('12:00'), '22-02'), false);
  assert.equal(inWindow(at('12:00'), 'always'), true);
});

const good = { summary: 'Proiectul reduce temporar acciza la motorină și introduce o contribuție pe veniturile din țițeiul românesc.',
  institutions: ['Ministerul Finanțelor'], companies: ['OMV Petrom'], sectors: ['petrol-gaze', 'spatiu'] };

test('a reply is checked and split into the three annotations; unknown sectors dropped', () => {
  const rows = checkReply(good, { id: 'cdep:1' }, taxonomy, 'm');
  assert.deepEqual(rows.map(r => r.kind), ['summary', 'entities', 'sectors']);
  assert.deepEqual(rows[2].content, { sectors: ['petrol-gaze'] });
  assert.equal(rows[0].target_id, 'cdep:1');
  assert.equal(rows[0].status, undefined, 'the database sets the status');
  assert.deepEqual(checkReply({ ...good, summary: 'scurt' }, { id: 'cdep:1' }, taxonomy, 'm').map(r => r.kind), ['entities', 'sectors']);
  assert.deepEqual(checkReply(null, { id: 'cdep:1' }, taxonomy, 'm'), []);
  assert.deepEqual(checkReply({ summary: 'x'.repeat(900) }, { id: 'cdep:1' }, taxonomy, 'm'), []);
});

function fakes({ up = true, reply = good, slowMs = 0 } = {}) {
  const saved = [], calls = [];
  const lm = { ping: async () => { if (!up) throw new Error('refused'); return true; },
    json: async () => { calls.push(1); if (slowMs) await new Promise(r => setTimeout(r, slowMs)); return reply; } };
  const rpc = async (name, args) => {
    if (name === 'ai_annotations_pending') return [{ id: 'cdep:1', title: 'Lege' }, { id: 'cdep:2', title: 'Proiect' }, { id: 'mf:3', title: 'Comunicat' }];
    if (name === 'ai_annotations_save') { saved.push(...args.p_rows); return args.p_rows.length; }
    throw new Error('unexpected ' + name);
  };
  return { lm, rpc, saved, calls };
}

test('outside the window nothing is asked of anyone', async () => {
  const f = fakes();
  const r = await runPolicyAi({ ...f, now: at('12:00'), window: '01-06', taxonomy, secret: 's', model: 'm' });
  assert.equal(r.status, 'outside_window');
  assert.equal(f.calls.length, 0);
});

test('LM Studio not answering: postponed, nothing saved', async () => {
  const f = fakes({ up: false });
  const r = await runPolicyAi({ ...f, now: at('02:00'), window: '01-06', taxonomy, secret: 's', model: 'm' });
  assert.equal(r.status, 'postponed');
  assert.deepEqual(f.saved, []);
});

test('a run saves each event\'s annotations; the time limit stops the loop', async () => {
  const f = fakes();
  const r = await runPolicyAi({ ...f, now: at('02:00'), window: '01-06', taxonomy, secret: 's', model: 'm' });
  assert.equal(r.status, 'done');
  assert.equal(r.saved, 9);
  const slow = fakes({ slowMs: 30 });
  const r2 = await runPolicyAi({ ...slow, now: at('02:00'), window: '01-06', taxonomy, secret: 's', model: 'm', maxMinutes: 0.0004 });
  assert.equal(r2.status, 'time_limit');
  assert.ok(slow.calls.length < 3);
});

test('a reply that fails the checks is skipped, the run goes on', async () => {
  const f = fakes({ reply: { summary: 1, institutions: 'x' } });
  const r = await runPolicyAi({ ...f, now: at('02:00'), window: '01-06', taxonomy, secret: 's', model: 'm' });
  assert.equal(r.status, 'done');
  assert.equal(r.saved, 0);
  assert.equal(r.skipped, 3);
});
