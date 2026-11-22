'use strict';

// Кто сейчас работает, ждёт или спит. Считается на сервере для /api/state,
// чтобы карта, лента и иерархия смотрели в одно поле activity.

const { isSilentTask } = require('../public/js/task-rules');

const OPEN_RANK = { in_progress: 3, accepted: 2, sent: 1 };
const DEFAULT_MINUTES = 30;
const TURN_MS = 10 * 60 * 1000;
const STATUS_HOLD_MS = 15 * 60 * 1000;
const OWNER_NAME = 'Путин';

function activeWindowMs(env = process.env) {
  const raw = env && env.ACTIVITY_WINDOW_MIN;
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

function routineTitle(routine) {
  const name = routine && typeof routine.name === 'string' ? routine.name.trim() : '';
  return (name || 'Рутина').slice(0, 300);
}

function orderStamp(order) {
  const hist = Array.isArray(order.history) ? order.history : [];
  const last = hist.length ? Date.parse(hist[hist.length - 1].at) : NaN;
  if (Number.isFinite(last)) return last;
  const created = Date.parse(order.createdAt);
  return Number.isFinite(created) ? created : 0;
}

function isClosedOrder(order) {
  if (!order) return true;
  if (order.orderStatus === 'done' || order.orderStatus === 'failed' || order.orderStatus === 'cancelled') return true;
  if (order.status === 'выполнена') return true;
  return false;
}

// Работа на карте — только доставленный приказ (HTTP 2xx). Пустой forwardStatus
// у старых t-1…t-4 и любой другой код оставляют простой. Поля приказа не меняем.
function delivered2xx(order) {
  const code = Number(order && order.forwardStatus);
  return Number.isInteger(code) && code >= 200 && code < 300;
}

// Приказ ещё только ждёт вебхук: в карту его как работу не считаем.
function deliveryHeld(order, extras) {
  if (!order) return false;
  const status = order.orderStatus || 'sent';
  if (status !== 'sent') return false;
  const outbox = extras && extras.outbox;
  if (!Array.isArray(outbox)) return false;
  return outbox.some((item) => item && item.status === 'queued' && item.taskId === order.id);
}

// Открытый приказ, адресованный агенту: sent, accepted или in_progress.
// Среди них предпочтение у in_progress, затем у более свежего.
function pickCurrentTask(agentId, orders, extras) {
  const mine = (orders || []).filter((o) => executorId(o) === agentId && !isClosedOrder(o) && !isSilentTask(o) && !deliveryHeld(o, extras));
  mine.sort((a, b) => {
    const rank = (o) => OPEN_RANK[o.orderStatus] || 1;
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

function activeRoutine(agentId, routines) {
  const mine = (routines || []).filter((r) => r && r.agentId === agentId && !r.finishedAt);
  mine.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || String(b.id).localeCompare(String(a.id)));
  return mine[0] || null;
}

function freshRoutineReport(agentId, routines, now, windowMs) {
  let best = null;
  let bestT = -Infinity;
  for (const routine of routines || []) {
    if (!routine || routine.agentId !== agentId || !routine.finishedAt) continue;
    if (!heartbeatFresh(routine.finishedAt, now, windowMs)) continue;
    const t = Date.parse(routine.finishedAt);
    if (t >= bestT) {
      bestT = t;
      best = routine;
    }
  }
  return best;
}

function ageFresh(ms, now, windowMs) {
  if (!Number.isFinite(ms)) return false;
  const age = now - ms;
  if (age < 0) return true;
  return age < windowMs;
}

function participantIds(order) {
  const ids = [];
  const exec = executorId(order);
  if (exec) ids.push(exec);
  const from = order && order.fromAgentId;
  if (from && from !== 'owner') ids.push(String(from));
  return ids;
}

// Подпись маршрута. Пустой отправитель и owner — «Путин», не «Вы» и не «Владелец».
function orderSenderName(fromAgentId) {
  if (!fromAgentId || fromAgentId === 'owner') return OWNER_NAME;
  return '';
}

function orderRoute(order, nameOf) {
  const fromId = order && order.fromAgentId;
  const owner = orderSenderName(fromId);
  const from = owner || (typeof nameOf === 'function' ? nameOf(fromId) : String(fromId || ''));
  const toId = executorId(order);
  const to = typeof nameOf === 'function' ? nameOf(toId) : String(toId || '');
  return `${from} → ${to}`;
}

function freshTouchOrders(agentId, orders, now, extras) {
  return (orders || []).filter((order) => {
    if (!order || isClosedOrder(order) || isSilentTask(order)) return false;
    if (!delivered2xx(order)) return false;
    if (!participantIds(order).includes(agentId)) return false;
    return ageFresh(orderStamp(order), now, TURN_MS);
  });
}

function bestFreshOrder(agentId, orders, now, extras) {
  const mine = freshTouchOrders(agentId, orders, now, extras);
  mine.sort((a, b) => {
    const rank = (order) => OPEN_RANK[order.orderStatus] || 1;
    const byRank = rank(b) - rank(a);
    if (byRank) return byRank;
    const byTime = orderStamp(b) - orderStamp(a);
    if (byTime) return byTime;
    return String(b.id).localeCompare(String(a.id));
  });
  return mine[0] || null;
}

function messageTouches(agentId, message) {
  if (!message || message.source === 'live') return false;
  if (message.agentId === agentId) return true;
  if (message.fromAgentId === agentId) return true;
  if (message.toAgentId === agentId) return true;
  for (const list of [message.toAgentIds, message.addressedTo]) {
    if (Array.isArray(list) && list.includes(agentId)) return true;
  }
  return false;
}

function freshTouchMessage(agentId, messages, now, extras) {
  let best = null;
  let bestT = -Infinity;
  for (const message of messages || []) {
    if (!messageTouches(agentId, message)) continue;
    if (message.taskId) {
      const orders = extras && extras.orders;
      const found = Array.isArray(orders) ? orders.find((item) => item && item.id === message.taskId) : null;
      if (!delivered2xx(found || { forwardStatus: null })) continue;
    }
    const t = Date.parse(message.timestamp || message.createdAt);
    if (!ageFresh(t, now, TURN_MS)) continue;
    if (t >= bestT) {
      bestT = t;
      best = message;
    }
  }
  return best;
}

function directReports(agent, agents) {
  if (!agent) return [];
  const list = (agents || []).filter((item) => item && !item.archived && item.id !== agent.id);
  const explicit = list.filter((item) => item.parentId === agent.id);
  if (agent.id !== 'grok') return explicit;
  const seen = new Set(explicit.map((item) => item.id));
  const implicit = list.filter((item) => !item.parentId && !seen.has(item.id));
  return explicit.concat(implicit);
}

function openOrderBetween(fromId, toId, orders, extras) {
  let best = null;
  let bestT = -Infinity;
  for (const order of orders || []) {
    if (!order || isClosedOrder(order) || isSilentTask(order)) continue;
    if (deliveryHeld(order, extras)) continue;
    if (order.fromAgentId !== fromId || executorId(order) !== toId) continue;
    const t = orderStamp(order);
    if (t >= bestT) {
      bestT = t;
      best = order;
    }
  }
  return best;
}

function liveRecord(agent, now) {
  const live = agent && agent.live;
  if (!live || live.status !== 'working') return null;
  const until = Date.parse(live.until);
  if (!Number.isFinite(until) || now >= until) return null;
  return live;
}

// Реплика самого агента: его сообщение, строка статуса или дашборд.
// Реплика владельца в чужой ленте агента не будит.
function freshOwnMessage(agentId, messages, orders, now, windowMs, extras) {
  let best = null;
  let bestT = -Infinity;
  for (const message of messages || []) {
    if (!message || message.agentId !== agentId) continue;
    if (message.role === 'owner') continue;
    if (message.source === 'order') {
      const order = (orders || []).find((item) => item && item.id === message.taskId);
      if (deliveryHeld(order || { id: message.taskId, orderStatus: 'sent' }, extras)) continue;
    }
    const own = message.role === 'agent'
      || message.source === 'status'
      || message.source === 'dashboard'
      || message.source === 'order';
    if (!own) continue;
    const iso = message.timestamp || message.createdAt;
    if (!heartbeatFresh(iso, now, windowMs)) continue;
    const t = Date.parse(iso);
    if (t >= bestT) {
      bestT = t;
      best = message;
    }
  }
  return best;
}

function activityFor(agent, orders, now = Date.now(), windowMs = activeWindowMs(), extras = {}) {
  // Архив без начальника на карте не светится. Зам (есть parentId) считается
  // как обычно: его живой статус виден в помещении начальника.
  if (agent && agent.archived && !agent.parentId) {
    return {
      activity: 'resting',
      lastSeenAt: agent.lastSeenAt || null,
      currentTask: null,
      doing: null,
      doingSince: null,
    };
  }
  const id = agent && agent.id;
  const messages = extras.messages || [];
  const routines = extras.routines || [];
  const agents = extras.agents || [];
  const task = id ? pickCurrentTask(id, orders, extras) : null;
  const freshOrder = id ? bestFreshOrder(id, orders, now, extras) : null;
  const routine = id ? activeRoutine(id, routines) : null;
  const reported = id ? freshRoutineReport(id, routines, now, windowMs) : null;
  const lastSeenAt = (agent && agent.lastSeenAt) || null;
  const freshBeat = heartbeatFresh(lastSeenAt, now, windowMs);
  const note = agent && typeof agent.heartbeatNote === 'string' ? agent.heartbeatNote.trim() : '';
  // Ручная отметка гаснет через 15 минут. Окно пульса и приказов здесь не трогаем.
  const manualFresh = ageFresh(Date.parse(agent && agent.lastStatusAt), now, STATUS_HOLD_MS);
  const manualWaiting = !!(agent && agent.status === 'waiting' && manualFresh);
  const manualHold = manualFresh && !manualWaiting;
  const freshStatus = manualFresh;
  const freshDash = heartbeatFresh(agent && agent.lastDashboardAt, now, windowMs);
  const dashNote = agent && typeof agent.dashboardNote === 'string' ? agent.dashboardNote.trim() : '';
  const message = id ? freshTouchMessage(id, messages, now, { ...extras, orders }) : null;
  // Живой ход коротко живёт в памяти и в базу не пишется.
  const live = liveRecord(agent, now);
  const doingText = live && typeof live.doing === 'string' ? live.doing.trim() : '';
  const ownWorking = !!(freshOrder || routine || reported || freshBeat || manualHold || freshDash || message || live);
  let currentTask = null;
  if (doingText) currentTask = doingText.slice(0, 80);
  else if (freshOrder) currentTask = taskTitle(freshOrder);
  else if (task && ownWorking && delivered2xx(task)) currentTask = taskTitle(task);
  else if (routine) currentTask = routineTitle(routine);
  else if (freshBeat && note) currentTask = note.slice(0, 300);
  else if (freshDash && dashNote) currentTask = dashNote.slice(0, 300);
  else if (reported) currentTask = routineTitle(reported);
  else if (freshStatus && agent && agent.status === 'working' && typeof agent.now === 'string' && agent.now.trim()) {
    currentTask = agent.now.trim().slice(0, 300);
  }
  const behalf = agents.find((other) => other && other.id !== id && liveRecord(other, now) && other.live.forAgent === id);
  if (ownWorking || behalf) {
    if (!ownWorking && behalf) {
      const who = behalf.name || behalf.id;
      const what = typeof behalf.live.doing === 'string' ? behalf.live.doing.trim() : '';
      currentTask = what ? `${who}: ${what}` : who;
    }
    return {
      activity: 'working',
      lastSeenAt,
      currentTask,
      doing: ownWorking ? (doingText || null) : null,
      doingSince: ownWorking && live ? (live.since || null) : null,
    };
  }
  const reports = directReports(agent, agents);
  let coordTask = null;
  let coordT = -Infinity;
  for (const report of reports) {
    const childOrder = openOrderBetween(id, report.id, orders, extras);
    if (!childOrder) continue;
    const childView = activityFor(report, orders, now, windowMs, { ...extras, messages, routines, agents: [] });
    if (childView.activity !== 'working') continue;
    const t = orderStamp(childOrder);
    if (t >= coordT) {
      coordT = t;
      const who = report.name || report.id;
      coordTask = `${who}: ${taskTitle(childOrder)}`;
    }
  }
  if (coordTask) {
    return {
      activity: 'coordinating',
      lastSeenAt,
      currentTask: coordTask,
      doing: null,
      doingSince: null,
    };
  }
  let activity = 'resting';
  if (manualWaiting) activity = 'waiting';
  return {
    activity,
    lastSeenAt,
    currentTask: null,
    doing: null,
    doingSince: null,
  };
}

function liveStillOn(agent, now) {
  const record = agent && agent.live;
  if (!record || record.status !== 'working') return false;
  const until = Date.parse(record.until);
  return Number.isFinite(until) && now < until;
}

function manualStatusFresh(agent, now) {
  const stamp = Date.parse(agent && agent.lastStatusAt);
  if (!Number.isFinite(stamp)) return false;
  const age = now - stamp;
  if (age < 0) return true;
  return age < STATUS_HOLD_MS;
}

// Сырой status=working без живого окна 15 минут становится idle.
// waiting не трогаем. Живой ход с until в будущем держит отметку.
function settleRawStatus(agents, now = Date.now()) {
  const changed = [];
  for (const agent of agents || []) {
    if (!agent || agent.status !== 'working') continue;
    if (liveStillOn(agent, now) || manualStatusFresh(agent, now)) continue;
    agent.status = 'idle';
    changed.push(agent);
  }
  return changed;
}

module.exports = {
  OPEN_RANK,
  DEFAULT_MINUTES,
  TURN_MS,
  STATUS_HOLD_MS,
  OWNER_NAME,
  activeWindowMs,
  executorId,
  taskTitle,
  isClosedOrder,
  pickCurrentTask,
  deliveryHeld,
  heartbeatFresh,
  activeRoutine,
  activityFor,
  orderSenderName,
  orderRoute,
  settleRawStatus,
};
