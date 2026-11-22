'use strict';

// Политика повтора очереди: пауза, предел, захват в памяти, счётчики здоровья.
// Секретов здесь нет.

const DEFAULT_MAX = 5;
const DEFAULT_BASE_MS = 30 * 1000;

function limits(env = process.env) {
  const max = Number(env && env.OUTBOX_RETRY_MAX);
  const base = Number(env && env.OUTBOX_RETRY_BASE_MS);
  return {
    maxAttempts: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX,
    baseMs: Number.isFinite(base) && base >= 0 ? base : DEFAULT_BASE_MS,
  };
}

function attemptsOf(item) {
  const n = Number(item && item.attempts);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function exhausted(item, env = process.env) {
  return attemptsOf(item) >= limits(env).maxAttempts;
}

function isStubText(text) {
  return String(text || '').trim().toLowerCase() === 'тест';
}

function deliveredCode(task) {
  const code = Number(task && task.forwardStatus);
  return Number.isInteger(code) && code >= 200 && code < 300;
}

function closedTask(task) {
  if (!task) return true;
  if (task.orderStatus === 'done' || task.orderStatus === 'failed' || task.orderStatus === 'cancelled') return true;
  if (task.status === 'выполнена') return true;
  return false;
}

function nextRetryAt(item, env = process.env) {
  if (!item || item.status === 'delivered' || item.status === 'sending') return null;
  if (item.status && item.status !== 'queued') return null;
  const attempts = attemptsOf(item);
  if (attempts <= 0 || exhausted(item, env)) return null;
  const base = Date.parse(item.lastAttemptAt || '');
  if (!Number.isFinite(base)) return null;
  const delay = limits(env).baseMs * (2 ** (attempts - 1));
  return new Date(base + delay).toISOString();
}

function dueOnTimer(item, now = Date.now(), env = process.env) {
  if (!item || item.status !== 'queued') return false;
  if (exhausted(item, env)) return false;
  if (attemptsOf(item) <= 0) return true;
  const next = nextRetryAt(item, env);
  return next != null && Date.parse(next) <= now;
}

function claimMemory(item, env = process.env, force = false) {
  if (!item || item.status !== 'queued') return false;
  if (!force && exhausted(item, env)) return false;
  item.status = 'sending';
  return true;
}

function releaseClaim(item) {
  if (item && item.status === 'sending') item.status = 'queued';
}

function earliestNextRetry(items, env = process.env) {
  let best = null;
  for (const item of items || []) {
    const next = nextRetryAt(item, env);
    if (!next) continue;
    if (!best || next < best) best = next;
  }
  return best;
}

function healthCounts(items, env = process.env) {
  let queued = 0;
  let delivered = 0;
  let resent = 0;
  let errors = 0;
  for (const item of items || []) {
    if (!item) continue;
    if (item.status === 'delivered') {
      delivered += 1;
      if (attemptsOf(item) > 1) resent += 1;
      continue;
    }
    if (item.status === 'queued' || item.status === 'sending') {
      if (item.status === 'queued') queued += 1;
      if (item.lastError) errors += 1;
    }
  }
  return {
    queued,
    delivered,
    resent,
    errors,
    nextRetryAt: earliestNextRetry(items, env),
  };
}

function inferNeedId(task, needs) {
  if (!task) return null;
  if (task.needId) return task.needId;
  const text = String(task.text || '');
  const wrapped = text.match(/^Ответ Арсения на «([\s\S]*)»: /);
  if (!wrapped) return null;
  const what = wrapped[1];
  const need = (needs || []).find((item) => item && item.what === what);
  return need ? need.id : null;
}

// Недоставленные приказы без строки очереди. «тест» помечается отменённым и в очередь не встаёт.
function planBackfill(tasks, outbox, needs) {
  const have = new Set();
  for (const item of outbox || []) {
    if (item && item.taskId) have.add(item.taskId);
  }
  const cancelled = [];
  const missing = [];
  for (const task of tasks || []) {
    if (!task || !task.id || have.has(task.id)) continue;
    if (deliveredCode(task) || closedTask(task)) continue;
    if (isStubText(task.text)) {
      task.orderStatus = 'cancelled';
      task.status = 'отменён';
      task.delivery = null;
      if (!task.note) task.note = 'устарело';
      cancelled.push(task);
      have.add(task.id);
      continue;
    }
    missing.push({ task, needId: inferNeedId(task, needs) });
    have.add(task.id);
  }
  return { cancelled, missing };
}

// Уже отменённый приказ не остаётся «в очереди агента» и не держит delivery=queue.
// Его недоставленный outbox тоже гасится. Запись из базы не удаляется.
function applyCancelledFields(task) {
  if (!task || task.orderStatus !== 'cancelled') return false;
  let changed = false;
  if (task.status !== 'отменён') {
    task.status = 'отменён';
    changed = true;
  }
  if (task.delivery != null) {
    task.delivery = null;
    changed = true;
  }
  return changed;
}

const LEGACY_DELIVERED = new Set(['t-3', 't-4']);

// Старые t-3 и t-4 остаются в списке, но становятся доставленными.
// Повторный запуск ничего не меняет. Очередь со статусом delivered не уходит снова.
function settleLegacyDelivered(tasks, outbox) {
  const changedTasks = [];
  const changedOutbox = [];
  const list = Array.isArray(outbox) ? outbox : [];
  for (const task of tasks || []) {
    if (!task || !LEGACY_DELIVERED.has(String(task.id))) continue;
    let changed = false;
    const code = Number(task.forwardStatus);
    if (!(Number.isInteger(code) && code >= 200 && code < 300)) {
      task.forwardStatus = 200;
      changed = true;
    }
    if (task.outboxStatus !== 'delivered') {
      task.outboxStatus = 'delivered';
      changed = true;
    }
    if (task.deliveryLabel !== 'Доставлено') {
      task.deliveryLabel = 'Доставлено';
      changed = true;
    }
    if (changed) changedTasks.push(task);
    let item = list.find((entry) => entry && String(entry.taskId) === String(task.id));
    if (!item) {
      item = {
        id: `legacy-${task.id}`,
        taskId: task.id,
        agentId: task.agentId || task.agent || null,
        status: 'delivered',
        attempts: 1,
        at: task.createdAt || new Date().toISOString(),
        lastStatus: 200,
        payload: { taskId: task.id, type: 'owner_task', text: task.text || '' },
      };
      list.push(item);
      changedOutbox.push(item);
      continue;
    }
    if (item.status === 'delivered' || item.status === 'cancelled') continue;
    item.status = 'delivered';
    if (item.lastStatus == null) item.lastStatus = 200;
    changedOutbox.push(item);
  }
  return { tasks: changedTasks, outbox: changedOutbox };
}

function normalizeCancelledOrders(tasks, outbox) {
  const changedTasks = [];
  const changedOutbox = [];
  const ids = new Set();
  for (const task of tasks || []) {
    if (!task || task.orderStatus !== 'cancelled') continue;
    ids.add(task.id);
    if (applyCancelledFields(task)) changedTasks.push(task);
  }
  for (const item of outbox || []) {
    if (!item || !ids.has(item.taskId)) continue;
    if (item.status === 'delivered' || item.status === 'cancelled') continue;
    item.status = 'cancelled';
    changedOutbox.push(item);
  }
  return { tasks: changedTasks, outbox: changedOutbox };
}

module.exports = {
  limits,
  attemptsOf,
  exhausted,
  isStubText,
  deliveredCode,
  closedTask,
  nextRetryAt,
  dueOnTimer,
  claimMemory,
  releaseClaim,
  healthCounts,
  inferNeedId,
  planBackfill,
  applyCancelledFields,
  normalizeCancelledOrders,
  settleLegacyDelivered,
};
