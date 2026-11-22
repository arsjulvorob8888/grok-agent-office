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

  const ROUTE_LABEL = {
    agent: 'Свой вебхук агента',
    putin: 'Через Путина',
    env: 'Адрес из окружения',
    none: 'Нет маршрута',
  };
  const ROUTE_ORDER = ['agent', 'putin', 'env', 'none'];

  function routeLabel(kind) {
    return ROUTE_LABEL[kind] || ROUTE_LABEL.none;
  }

  function routePhrase(kind) {
    return `Куда уйдёт приказ: ${routeLabel(kind)}`;
  }

  function routeSummary(kinds) {
    const list = (Array.isArray(kinds) ? kinds : []).map((kind) => (ROUTE_LABEL[kind] ? kind : 'none'));
    if (!list.length) return routePhrase('none');
    const unique = [...new Set(list)];
    if (unique.length === 1) return routePhrase(unique[0]);
    const parts = ROUTE_ORDER.filter((kind) => list.includes(kind)).map((kind) => {
      const count = list.filter((item) => item === kind).length;
      return `${routeLabel(kind)} — ${count}`;
    });
    return `Куда уйдёт приказ: ${parts.join('. ')}`;
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

  function needsForAgent(needs, agentId) {
    return (needs || []).filter((need) => need && !isTestNeed(need) && needAudience(need).has(agentId) && isOpenNeed(need));
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

  const OPEN_ORDER = new Set(['sent', 'accepted', 'in_progress']);

  function orderDelivered(task) {
    const code = Number(task && task.forwardStatus);
    return Number.isInteger(code) && code >= 200 && code < 300;
  }

  function agentAnswered(task, messages) {
    if (!task || !task.id) return false;
    return (messages || []).some((message) => message && message.role === 'agent' && message.taskId === task.id);
  }

  // Спокойная подпись, не реплика агента. Пустая строка — ждать нечего.
  function replyWaitCaption(tasks, messages, agentId) {
    const open = (tasks || []).filter((task) => {
      if (!task || !OPEN_ORDER.has(task.orderStatus || 'sent')) return false;
      return (task.agentId || task.agent) === agentId;
    });
    if (!open.length) return '';
    if (open.some((task) => !orderDelivered(task))) return 'Агенту ещё не доставлено';
    if (open.some((task) => !agentAnswered(task, messages))) return 'Ответ придёт сюда, когда агент его пришлёт';
    return '';
  }

  const PROCESS_HOUR_MS = 60 * 60 * 1000;

  function processBuckets(tasks, routines, now = Date.now()) {
    const live = [];
    const undelivered = [];
    for (const task of tasks || []) {
      if (!task) continue;
      const status = task.orderStatus || 'sent';
      if (status === 'cancelled' || status === 'done' || status === 'failed') continue;
      if (status !== 'sent' && status !== 'accepted' && status !== 'in_progress') continue;
      if (status === 'accepted' || status === 'in_progress' || orderDelivered(task)) {
        live.push(task);
        continue;
      }
      const created = Date.parse(task.createdAt || '');
      const age = Number.isFinite(created) ? now - created : Infinity;
      if (age > PROCESS_HOUR_MS) undelivered.push(task);
    }
    const pulses = (routines || []).filter((item) => item && item.active && !item.finishedAt);
    return { live, undelivered, pulses };
  }

  function countsAsQueued(task) {
    if (!task) return false;
    if (task.orderStatus === 'cancelled' || task.orderStatus === 'done' || task.orderStatus === 'failed') return false;
    if (task.status === 'выполнена') return false;
    return task.status === 'в очереди агента' || task.delivery === 'queue' || !task.orderStatus || task.orderStatus === 'sent';
  }

  function taskBadge(task, ctx) {
    const t = task || {};
    const context = ctx || {};
    const captionOf = (item) => item.deliveryLabel || deliveryCaption(item.forwardStatus);
    if (t.orderStatus === 'cancelled') return ['cancel', 'Отменено'];
    if (t.orderStatus === 'failed') return ['fail', 'Не выполнен'];
    if (t.orderStatus === 'done' || t.status === 'выполнена') return ['done', 'Выполнена'];
    if (t.orderStatus === 'in_progress') return ['work', 'В работе'];
    if (t.orderStatus === 'accepted') return ['work', 'Принял'];
    if (!t.orderStatus || t.orderStatus === 'sent') {
      const code = Number(t.forwardStatus);
      const failed = t.forwardStatus != null && t.forwardStatus !== '' && !(Number.isInteger(code) && code >= 200 && code < 300);
      return [failed ? 'fail' : 'sent', captionOf(t)];
    }
    if (t.status === 'выполнена') return ['done', 'Выполнена'];
    const mode = context.mode;
    const agent = context.agent;
    const latest = context.latest;
    const working = mode ? mode === 'working' : !!(agent && agent.status === 'working');
    if (working && latest && latest.id === t.id) return ['work', 'В работе'];
    if (t.status === 'в очереди агента') return ['sent', captionOf(t)];
    if (t.status === 'отправлена Путину') return ['sent', captionOf(t)];
    if (String(t.status || '').startsWith('не отправлена')) return ['fail', 'Не отправлена'];
    if (t.forwardStatus === 0 || (t.forwardStatus && (t.forwardStatus < 200 || t.forwardStatus >= 300))) {
      return ['fail', deliveryCaption(t.forwardStatus)];
    }
    return ['sent', deliveryCaption(t.forwardStatus)];
  }

  function historyCaption(task, entry) {
    const status = entry && entry.status;
    if (task && task.orderStatus === 'cancelled' && (status === 'sent' || status === 'cancelled' || !status)) return 'Отменено';
    if (status === 'sent') return (task && task.deliveryLabel) || deliveryCaption(task && task.forwardStatus);
    const words = {
      accepted: 'принял',
      in_progress: 'в работе',
      done: 'выполнено',
      failed: 'не выполнен',
      cancelled: 'отменено',
    };
    return words[status] || status || '';
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
    routeLabel,
    routePhrase,
    routeSummary,
    moscowClock,
    formatClockMsk,
    formatDateTimeMsk,
    formatProcessStamp,
    replyWaitCaption,
    processBuckets,
    countsAsQueued,
    taskBadge,
    historyCaption,
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
