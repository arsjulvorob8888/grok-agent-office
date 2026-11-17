'use strict';

// Кто сейчас работает, а кто отдыхает. Не зависит от Express:
// сервер, тесты и будущий слой хранения передают агента и список приказов.

const ACTIVE_ORDER = new Set(['accepted', 'in_progress']);
const OPEN_ORDER = new Set(['sent', 'accepted', 'in_progress']);
const DEFAULT_MINUTES = 10;

function activeWindowMs(env = process.env) {
  const raw = env && env.AGENT_ACTIVE_MINUTES;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MINUTES * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MINUTES * 60 * 1000;
  return n * 60 * 1000;
}

function executorId(order) {
  if (!order) return '';
  return String(order.agentId || order.agent || '');
}

function taskTitle(order) {
  const text = typeof order.text === 'string' ? order.text.trim() : '';
  if (text) return text.slice(0, 300);
  const names = (order.attachments || []).map((a) => a && a.name).filter(Boolean);
  if (names.length) return names.join(', ').slice(0, 300);
  return 'Задача';
}

function orderStamp(order) {
  const hist = Array.isArray(order.history) ? order.history : [];
  const last = hist.length ? Date.parse(hist[hist.length - 1].at) : NaN;
  if (Number.isFinite(last)) return last;
  const created = Date.parse(order.createdAt);
  return Number.isFinite(created) ? created : 0;
}

// Среди принятых и тех, что уже в работе, берём in_progress, затем более свежий.
function pickCurrentTask(agentId, orders) {
  const mine = (orders || []).filter((o) => executorId(o) === agentId && ACTIVE_ORDER.has(o.orderStatus));
  mine.sort((a, b) => {
    const rank = (o) => (o.orderStatus === 'in_progress' ? 2 : 1);
    const byRank = rank(b) - rank(a);
    if (byRank) return byRank;
    const byTime = orderStamp(b) - orderStamp(a);
    if (byTime) return byTime;
    return String(b.id).localeCompare(String(a.id));
  });
  return mine[0] || null;
}

function heartbeatFresh(lastSeenAt, now, windowMs) {
  if (!lastSeenAt) return false;
  const t = Date.parse(lastSeenAt);
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  if (age < 0) return true;
  return age <= windowMs;
}

function activityFor(agent, orders, now = Date.now(), windowMs = activeWindowMs()) {
  const id = agent && agent.id;
  const task = id ? pickCurrentTask(id, orders) : null;
  const lastSeenAt = (agent && agent.lastSeenAt) || null;
  const fresh = heartbeatFresh(lastSeenAt, now, windowMs);
  const note = agent && typeof agent.heartbeatNote === 'string' ? agent.heartbeatNote.trim() : '';
  let currentTask = null;
  if (task) currentTask = taskTitle(task);
  else if (fresh && note) currentTask = note.slice(0, 300);
  return {
    activity: task || fresh ? 'working' : 'resting',
    lastSeenAt,
    currentTask,
  };
}

module.exports = {
  ACTIVE_ORDER,
  OPEN_ORDER,
  DEFAULT_MINUTES,
  activeWindowMs,
  executorId,
  taskTitle,
  pickCurrentTask,
  heartbeatFresh,
  activityFor,
};
