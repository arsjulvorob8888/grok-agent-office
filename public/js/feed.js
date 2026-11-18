/* Общие выборки ленты. Один массив из /api/state, без второй копии:
   и общий журнал, и панель агента смотрят сюда. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OfficeFeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECENT_CLOSED_MS = 7 * 24 * 60 * 60 * 1000;

  function moscowParts(iso) {
    const date = new Date(iso || '');
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const pick = (type) => {
      const part = parts.find((item) => item.type === type);
      return part ? part.value : '';
    };
    let hour = pick('hour');
    const minute = pick('minute');
    if (hour === '24') hour = '00';
    if (!hour || !minute) return null;
    return { hour, minute, date };
  }

  function moscowClock(iso) {
    const parts = moscowParts(iso);
    return parts ? `${parts.hour}:${parts.minute}` : '';
  }

  // Лента: часы Europe/Moscow и пометка пояса. Старше суток — ещё день.
  function formatClockMsk(iso, now = Date.now()) {
    const parts = moscowParts(iso);
    if (!parts) return '';
    const clock = `${parts.hour}:${parts.minute} МСК`;
    if (now - parts.date.getTime() <= 864e5) return clock;
    const day = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'short',
    }).format(parts.date);
    return `${clock} · ${day}`;
  }

  function formatDateTimeMsk(iso) {
    const parts = moscowParts(iso);
    if (!parts) return '';
    const day = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'short',
    }).format(parts.date);
    return `${day}, ${parts.hour}:${parts.minute} МСК`;
  }

  // «Процессы»: старт в МСК и подписанная длительность, не ч:мм:сс без подписи.
  function formatProcessStamp(iso, now = Date.now()) {
    const clock = moscowClock(iso);
    if (!clock) return '';
    const start = Date.parse(iso);
    const sec = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    let dur = 'меньше минуты';
    if (hours > 0) dur = `${hours} ч ${minutes} мин`;
    else if (minutes > 0) dur = `${minutes} мин`;
    return `с ${clock} МСК · ${dur}`;
  }

  // Пустой код без маршрута — доставка не подключена. Маршрут есть, а кода ещё нет — ждёт отправки.
  // extra.route: agent | putin | env | none. Без extra поведение прежнее: пустой код = не подключена.
  function deliveryCaption(forwardStatus, extra) {
    const code = Number(forwardStatus);
    if (Number.isInteger(code) && code >= 200 && code < 300) return 'Отправлена';
    const routeKnown = !!(extra && Object.prototype.hasOwnProperty.call(extra, 'route'));
    const offline = !routeKnown || extra.route == null || extra.route === '' || extra.route === 'none';
    const empty = forwardStatus == null || forwardStatus === '';
    if (empty && offline) return 'В очереди, доставка не подключена';
    const next = extra && extra.nextRetryAt;
    if (next) {
      const clock = moscowClock(next);
      if (clock) return `Ошибка доставки, повтор в ${clock} МСК`;
    }
    if (empty) return 'В очереди, ждёт отправки';
    if (Number.isInteger(code)) return `Ошибка доставки ${code}`;
    return 'Ошибка доставки';
  }

  function taskExecutor(task) {
    return (task && (task.agentId || task.agent)) || '';
  }

  function indexTasks(tasks) {
    const byId = new Map();
    for (const task of tasks || []) {
      if (task && task.id) byId.set(task.id, task);
    }
    return byId;
  }

  function childrenOf(byId) {
    const map = new Map();
    for (const task of byId.values()) {
      if (!task.parentOrderId) continue;
      if (!map.has(task.parentOrderId)) map.set(task.parentOrderId, []);
      map.get(task.parentOrderId).push(task);
    }
    return map;
  }

  function asIndex(tasksOrIndex) {
    return tasksOrIndex instanceof Map ? tasksOrIndex : indexTasks(tasksOrIndex);
  }

  // Сам приказ, предки и потомки делегирования.
  function chainOf(task, byId, children) {
    const seen = new Set();
    const up = [];
    let cur = task;
    while (cur && cur.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      up.push(cur);
      cur = cur.parentOrderId ? byId.get(cur.parentOrderId) : null;
    }
    up.reverse();
    const down = [];
    const queue = [...(children.get(task && task.id) || [])];
    while (queue.length) {
      const next = queue.shift();
      if (!next || !next.id || seen.has(next.id)) continue;
      seen.add(next.id);
      down.push(next);
      for (const child of children.get(next.id) || []) queue.push(child);
    }
    return up.concat(down);
  }

  function orderParticipantIds(task, tasksOrIndex, children) {
    const ids = new Set();
    if (!task) return ids;
    const byId = asIndex(tasksOrIndex);
    const kids = children || childrenOf(byId);
    for (const step of chainOf(task, byId, kids)) {
      if (step.fromAgentId && step.fromAgentId !== 'owner') ids.add(step.fromAgentId);
      const to = taskExecutor(step);
      if (to) ids.add(to);
    }
    return ids;
  }

  function seesOrder(task, tasks, agentId) {
    return orderParticipantIds(task, tasks).has(agentId);
  }

  function ordersForGeneral(tasks) {
    return (tasks || []).slice();
  }

  function ordersForAgent(tasks, agentId) {
    const byId = indexTasks(tasks);
    const children = childrenOf(byId);
    return (tasks || []).filter((task) => orderParticipantIds(task, byId, children).has(agentId));
  }

  // out — агент отправитель (→), in — исполнитель (←), both — и то и другое.
  function orderDirection(task, agentId, tasks) {
    if (!task || !agentId) return '';
    const outgoing = task.fromAgentId === agentId;
    const incoming = taskExecutor(task) === agentId;
    if (outgoing && incoming) return 'both';
    if (outgoing) return 'out';
    if (incoming) return 'in';
    const byId = asIndex(tasks);
    const children = childrenOf(byId);
    const seen = new Set([task.id]);
    let cur = task.parentOrderId ? byId.get(task.parentOrderId) : null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.fromAgentId === agentId) return 'out';
      if (taskExecutor(cur) === agentId) return 'in';
      cur = cur.parentOrderId ? byId.get(cur.parentOrderId) : null;
    }
    const queue = [...(children.get(task.id) || [])];
    while (queue.length) {
      const next = queue.shift();
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      if (taskExecutor(next) === agentId) return 'in';
      if (next.fromAgentId === agentId) return 'out';
      for (const child of children.get(next.id) || []) queue.push(child);
    }
    return '';
  }

  function pushAgent(ids, id) {
    if (id && id !== 'owner') ids.add(id);
  }

  function messageParticipantIds(message, tasksOrIndex) {
    const ids = new Set();
    if (!message) return ids;
    pushAgent(ids, message.agentId);
    pushAgent(ids, message.fromAgentId);
    pushAgent(ids, message.toAgentId);
    const lists = [message.toAgentIds, message.addressedTo];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const id of list) pushAgent(ids, id);
    }
    if (message.taskId) {
      const byId = asIndex(tasksOrIndex);
      const task = byId.get(message.taskId);
      if (task) {
        pushAgent(ids, task.fromAgentId);
        pushAgent(ids, taskExecutor(task));
      }
    }
    return ids;
  }

  function seesMessage(message, tasks, agentId) {
    return messageParticipantIds(message, tasks).has(agentId);
  }

  function messagesForGeneral(messages) {
    return (messages || []).slice();
  }

  function messagesForAgent(messages, tasks, agentId) {
    const byId = indexTasks(tasks);
    return (messages || []).filter((message) => messageParticipantIds(message, byId).has(agentId));
  }

  function isOpenNeed(need) {
    return !!(need && need.id && !need.closedAt);
  }

  function isRecentClosed(need, now) {
    if (!need || !need.closedAt) return false;
    const closed = Date.parse(need.closedAt);
    if (Number.isNaN(closed)) return false;
    const at = now == null ? Date.now() : now;
    return at >= closed && at - closed <= RECENT_CLOSED_MS;
  }

  function isTestNeed(need) {
    return !!(need && (need.kind === 'test' || need.id === 'need-test-qa' || need.id === 'need-test-question'));
  }

  function needsForGeneral(needs) {
    return (needs || []).filter((need) => isOpenNeed(need) && !isTestNeed(need));
  }

  function testNeeds(needs) {
    return (needs || []).filter((need) => isTestNeed(need) && isOpenNeed(need));
  }

  function needAudience(need) {
    const ids = new Set();
    if (!need) return ids;
    if (need.fromAgentId) ids.add(need.fromAgentId);
    if (Array.isArray(need.participants)) {
      for (const id of need.participants) {
        if (typeof id === 'string' && id.trim()) ids.add(id.trim());
      }
    }
    return ids;
  }

  function needsForAgent(needs, agentId, now) {
    return (needs || []).filter((need) => need && !isTestNeed(need) && needAudience(need).has(agentId) && (isOpenNeed(need) || isRecentClosed(need, now)));
  }

  function openNeedsForAgent(needs, agentId) {
    return (needs || []).filter((need) => need && !isTestNeed(need) && needAudience(need).has(agentId) && isOpenNeed(need));
  }

  function openNeedCount(needs, agentId) {
    return openNeedsForAgent(needs, agentId).length;
  }

  // Срочность для окраски. Просроченный пункт больше не считается срочным.
  function needUrgencyView(need) {
    if (!need || need.closedAt) return 'closed';
    if (need.stale) return 'stale';
    if (need.urgency === 'low' || need.urgency === 'normal' || need.urgency === 'high') return need.urgency;
    return 'normal';
  }

  function countsMatch(state, agentId, now) {
    const tasks = state.tasks || [];
    const messages = state.messages || [];
    const needs = state.needs || [];
    const ordersOk = ordersForAgent(tasks, agentId).length
      === ordersForGeneral(tasks).filter((task) => seesOrder(task, tasks, agentId)).length;
    const messagesOk = messagesForAgent(messages, tasks, agentId).length
      === messagesForGeneral(messages).filter((message) => seesMessage(message, tasks, agentId)).length;
    const needsOk = needsForAgent(needs, agentId, now).filter(isOpenNeed).length
      === needsForGeneral(needs).filter((need) => needAudience(need).has(agentId)).length;
    return ordersOk && messagesOk && needsOk;
  }

  return {
    RECENT_CLOSED_MS,
    taskExecutor,
    deliveryCaption,
    moscowClock,
    formatClockMsk,
    formatDateTimeMsk,
    formatProcessStamp,
    orderParticipantIds,
    seesOrder,
    ordersForGeneral,
    ordersForAgent,
    orderDirection,
    messageParticipantIds,
    seesMessage,
    messagesForGeneral,
    messagesForAgent,
    isTestNeed,
    testNeeds,
    isOpenNeed,
    isRecentClosed,
    needAudience,
    needsForGeneral,
    needsForAgent,
    openNeedsForAgent,
    openNeedCount,
    needUrgencyView,
    countsMatch,
  };
});
