'use strict';

// Служебная проверка связи. В записи нет адреса и ключа.
// Пять минут считаются от sentAt по часам сервера, их можно подменить в тесте.

const WAIT_MS = 5 * 60 * 1000;
let nowFn = () => Date.now();

function now() {
  return nowFn();
}

function setNow(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

function resetForTests() {
  nowFn = () => Date.now();
}

function isPingTaskId(taskId) {
  return typeof taskId === 'string' && taskId.trim().startsWith('ping-');
}

function bucket(state) {
  if (!state.linkChecks) state.linkChecks = {};
  return state.linkChecks;
}

function phaseOf(row, at) {
  if (!row) return null;
  if (row.answeredAt) return 'ok';
  const http = Number(row.http);
  const accepted = !row.error && http >= 200 && http < 300;
  if (!accepted) {
    if (http === 401 || http === 403) return 'key';
    return 'down';
  }
  if (at - row.sentAt >= WAIT_MS) return 'timeout';
  return 'checking';
}

function present(row, at, formatAtMsk) {
  const phase = phaseOf(row, at);
  if (!phase) return null;
  const answeredAt = row.answeredAt ? new Date(row.answeredAt).toISOString() : null;
  return {
    phase,
    taskId: row.taskId,
    sentAt: new Date(row.sentAt).toISOString(),
    answeredAt,
    answeredAtMsk: answeredAt && typeof formatAtMsk === 'function' ? formatAtMsk(answeredAt) : '',
  };
}

function remember(state, agentId, ping) {
  const map = bucket(state);
  if (!ping || ping.skipped) {
    delete map[agentId];
    return null;
  }
  map[agentId] = {
    agentId,
    taskId: ping.taskId,
    sentAt: ping.sentAt,
    http: ping.http,
    error: ping.error || null,
    answeredAt: null,
  };
  return map[agentId];
}

function clear(state, agentId) {
  if (state.linkChecks) delete state.linkChecks[agentId];
}

function acknowledge(state, agentId, taskId, at) {
  const row = state.linkChecks && state.linkChecks[agentId];
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (!row || !id || row.taskId !== id) return false;
  if (!row.answeredAt) row.answeredAt = at;
  return true;
}

module.exports = {
  WAIT_MS,
  now,
  setNow,
  resetForTests,
  isPingTaskId,
  phaseOf,
  present,
  remember,
  clear,
  acknowledge,
};
