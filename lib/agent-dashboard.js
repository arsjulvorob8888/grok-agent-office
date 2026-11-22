'use strict';

// Сводка для полноэкранного окна агента. Считает только переданные записи,
// в базу и в сеть не ходит. Пустая аналитика — null, не нули «для красоты».

const { deliveryCaption, taskDeliveryLabel } = require('../public/js/feed');
const { displayOrderSender, speakerLabel } = require('../public/js/sender-label');
const { xpOf, isCancelledTask, isSilentTask } = require('../public/js/task-rules');

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_KEYS = ['sent', 'accepted', 'in_progress', 'done', 'failed'];
const DELIVERED_LABEL = deliveryCaption(200);
const HISTORY_WORD = {
  sent: 'Отправлен',
  accepted: 'Принял',
  in_progress: 'В работе',
  done: 'Выполнено',
  failed: 'Не выполнен',
};

function storedDeliveryLabel(task) {
  if (!task || task.deliveryLabel == null || task.deliveryLabel === '') return null;
  return String(task.deliveryLabel);
}

function executorId(task) {
  return (task && (task.agentId || task.agent)) || '';
}

function columnOf(task) {
  if (!task) return 'new';
  if (task.orderStatus === 'cancelled') return 'cancelled';
  if (task.orderStatus === 'done' || task.orderStatus === 'failed' || task.status === 'выполнена') return 'done';
  if (isCancelledTask(task)) return 'cancelled';
  if (task.answeredAt) return 'answered';
  if (task.orderStatus === 'accepted' || task.orderStatus === 'in_progress') return 'work';
  const code = Number(task.forwardStatus);
  if ((Number.isInteger(code) && code >= 200 && code < 300) || task.outboxStatus === 'delivered' || task.deliveryLabel === 'Доставлено') {
    return 'delivered';
  }
  return 'new';
}

function isDone(task) {
  if (!task || task.orderStatus === 'failed' || task.orderStatus === 'cancelled') return false;
  return task.orderStatus === 'done' || task.status === 'выполнена';
}

function isInProgress(task) {
  return !!(task && (task.orderStatus === 'accepted' || task.orderStatus === 'in_progress'));
}

function levelInfo(completed, sent) {
  const xp = (Number(completed) || 0) * 100 + (Number(sent) || 0) * 10;
  let lvl = 1;
  let need = 150;
  let base = 0;
  while (xp >= base + need) {
    base += need;
    lvl += 1;
    need = 150 + (lvl - 1) * 75;
  }
  return { xp, lvl, into: xp - base, need };
}

function mskDate(ms) {
  const shifted = new Date(ms + MSK_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

function mskMidnight(ms) {
  const shifted = new Date(ms + MSK_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - MSK_OFFSET_MS;
}

function publicLive(live) {
  if (!live || typeof live !== 'object') return null;
  if (live.status !== 'working' && live.status !== 'idle') return null;
  const view = {
    status: live.status,
    doing: typeof live.doing === 'string' ? live.doing.slice(0, 80) : '',
  };
  if (typeof live.until === 'string' && live.until) view.until = live.until;
  return view;
}

function linkedTaskId(message) {
  if (!message) return '';
  if (typeof message.taskId === 'string' && message.taskId) return message.taskId;
  if (typeof message.id === 'string' && message.id.startsWith('task:')) return message.id.slice(5);
  return '';
}

function completionMs(task) {
  const created = Date.parse(task && task.createdAt);
  if (!Number.isFinite(created)) return null;
  const history = Array.isArray(task.history) ? task.history : [];
  let doneAt = NaN;
  for (const entry of history) {
    if (!entry || entry.status !== 'done') continue;
    const at = Date.parse(entry.at);
    if (Number.isFinite(at)) doneAt = at;
  }
  if (!Number.isFinite(doneAt) || doneAt < created) return null;
  return doneAt - created;
}

function buildDashboard({ agent, tasks, messages, activity, now }) {
  const id = agent && agent.id ? agent.id : '';
  const mine = (tasks || []).filter((task) => executorId(task) === id);
  const score = xpOf(agent, tasks || []);
  const visible = mine.filter((task) => {
    const column = columnOf(task);
    return column === 'new' || column === 'work' || column === 'done';
  });
  const talk = (messages || []).filter((message) => message && message.agentId === id);
  const byTask = new Map(mine.map((task) => [task.id, task]));
  const clock = Number.isFinite(now) ? now : Date.now();

  const taskViews = mine
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)))
    .map((task) => ({
      id: task.id,
      agentId: executorId(task),
      text: task.text || '',
      orderStatus: task.orderStatus || 'sent',
      status: task.status || '',
      column: columnOf(task),
      deliveryLabel: storedDeliveryLabel(task),
      forwardStatus: task.forwardStatus == null ? null : task.forwardStatus,
      createdAt: task.createdAt || null,
      result: task.result == null ? null : task.result,
      fromAgentId: task.fromAgentId || null,
      progress: task.progress == null ? null : task.progress,
      note: task.note || '',
    }));

  const messageViews = talk
    .filter((message) => {
      if (!message || message.role === 'system' && /отметился\s*:/i.test(String(message.text || ''))) return false;
      if (message.source === 'live') return false;
      if (String(message.text || '').trim().toLowerCase() === 'тест') return false;
      const linked = linkedTaskId(message);
      const task = linked ? byTask.get(linked) : null;
      return !(task && isSilentTask(task));
    })
    .slice()
    .sort((a, b) => String(a.createdAt || a.timestamp || '').localeCompare(String(b.createdAt || b.timestamp || '')) || String(a.id).localeCompare(String(b.id)))
    .map((message) => {
      const taskId = linkedTaskId(message);
      const task = taskId ? byTask.get(taskId) : null;
      const showDelivery = message.role === 'owner' && task;
      return {
        id: message.id,
        role: message.role,
        text: displayOrderSender(message.text || ''),
        createdAt: message.timestamp || message.createdAt || null,
        taskId: taskId || null,
        deliveryLabel: showDelivery ? storedDeliveryLabel(task) : null,
      };
    });

  let delivered = 0;
  let deliveryTotal = 0;
  for (const message of talk) {
    if (!message || message.role !== 'owner') continue;
    const task = byTask.get(linkedTaskId(message));
    const label = storedDeliveryLabel(task);
    if (!label) continue;
    deliveryTotal += 1;
    if (label === 'Доставлено' || label === DELIVERED_LABEL) delivered += 1;
  }

  const durations = visible.map(completionMs).filter((value) => value != null);
  const byStatus = visible.length ? { sent: 0, accepted: 0, in_progress: 0, done: 0, failed: 0 } : null;
  if (byStatus) {
    for (const task of visible) {
      if (task.orderStatus === 'cancelled') continue;
      const key = STATUS_KEYS.includes(task.orderStatus) ? task.orderStatus : 'sent';
      byStatus[key] += 1;
    }
  }

  let days = null;
  if (visible.length) {
    const start = mskMidnight(clock) - 13 * DAY_MS;
    const counts = new Map();
    for (let i = 0; i < 14; i += 1) counts.set(mskDate(start + i * DAY_MS + 12 * 60 * 60 * 1000), 0);
    for (const task of visible) {
      const created = Date.parse(task.createdAt);
      if (!Number.isFinite(created)) continue;
      const key = mskDate(created);
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
    days = [...counts.entries()].map(([date, count]) => ({ date, count }));
  }

  const activityLog = [];
  const shownTaskIds = new Set();
  for (const task of mine) {
    if (isSilentTask(task)) continue;
    const history = (task.history || []).filter((entry) => entry && entry.at);
    const entry = history.length ? history[history.length - 1] : null;
    if (!entry) continue;
    const word = taskDeliveryLabel(task) === 'Доставлено'
      ? 'Доставлено'
      : (HISTORY_WORD[entry.status] || entry.status || 'Событие');
    const title = task.text ? `${word}: ${task.text}` : word;
    activityLog.push({ at: entry.at, text: title.slice(0, 240) });
    shownTaskIds.add(task.id);
  }
  for (const message of talk) {
    if (!message || message.role === 'system') continue;
    const at = message.timestamp || message.createdAt;
    if (!at || !message.text) continue;
    if (String(message.text).trim().toLowerCase() === 'тест') continue;
    const taskId = linkedTaskId(message);
    const task = taskId ? byTask.get(taskId) : null;
    if (task && isSilentTask(task)) continue;
    if (message.role === 'owner' && task && shownTaskIds.has(task.id)) continue;
    const who = message.role === 'owner' ? speakerLabel('owner') : 'Агент';
    activityLog.push({ at, text: `${who}: ${displayOrderSender(message.text)}`.slice(0, 240) });
  }
  activityLog.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const line of agent && Array.isArray(agent.done) ? agent.done : []) {
    if (line) activityLog.push({ at: null, text: String(line).slice(0, 240) });
  }

  return {
    agent: {
      id,
      name: (agent && agent.name) || id,
      number: (agent && agent.number) || '',
      role: (agent && agent.role) || '',
      status: (agent && agent.status) || 'idle',
      activity: (activity && activity.activity) || 'resting',
      now: '',
      doing: activity && activity.doing ? activity.doing : null,
      currentTask: activity && activity.currentTask ? activity.currentTask : null,
      live: publicLive(agent && agent.live),
      completed: score.completed,
      level: { xp: score.xp, lvl: score.lvl, into: score.into, need: score.need },
      archived: !!(agent && agent.archived),
      vacant: !!(agent && agent.vacant),
    },
    metrics: {
      total: visible.length,
      done: visible.filter(isDone).length,
      inProgress: visible.filter((task) => columnOf(task) === 'work').length,
    },
    tasks: taskViews,
    activityLog: activityLog.slice(0, 20),
    analytics: {
      days,
      byStatus,
      avgCompletionMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
      delivered: deliveryTotal ? { delivered, total: deliveryTotal } : null,
    },
    messages: messageViews,
  };
}

module.exports = {
  columnOf,
  isDone,
  levelInfo,
  buildDashboard,
};
