import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
export function failurePolicy(error, attempt, now = Date.now()) {
  const status = Number(error.status || 0);
  const temporary = [408, 425, 429].includes(status) || status >= 500 && status <= 599 ||
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE|ABORT_ERR)$/.test(error.code || '') ||
    /timed? ?out|timeout|No time remaining/i.test(error.message || '');
  return { code: error.code || (status ? `HTTP_${status}` : 'REVIEW_REQUIRED'),
    reason: String(error.message || error).slice(0, 500), attempt,
    retryable: temporary && attempt < 3,
    nextAttemptAt: temporary && attempt < 3 ? now + [20 * 60000, 2 * 3600000][attempt - 1] : null };
}
export function retryRegistry(path) {
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const persist = () => { writeFileSync(path + '.tmp', JSON.stringify(state, null, 2)); renameSync(path + '.tmp', path); };
  return {
    ready: id => !state[id] || state[id].retryable && Date.now() >= state[id].nextAttemptAt,
    fail(id, error) { const result = failurePolicy(error, (state[id]?.attempt || 0) + 1); state[id] = result; persist(); return result; },
    clear(id) { if (state[id]) { delete state[id]; persist(); } }
  };
}
