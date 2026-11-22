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

  function sentRoutePhrase(kind) {
    if (kind !== 'agent' && kind !== 'putin' && kind !== 'env') return '';
    return `Куда ушёл приказ: ${routeLabel(kind)}`;
  }

  // Журнал и история берут одну подпись. Доставленный outbox и 2xx — «Доставлено».
  function taskDeliveryLabel(task, extra) {
    const source = task || {};
    const more = extra || {};
    const outboxStatus = more.outboxStatus != null ? more.outboxStatus : source.outboxStatus;
    const forwardStatus = Object.prototype.hasOwnProperty.call(more, 'forwardStatus') ? more.forwardStatus : source.forwardStatus;
    const code = Number(forwardStatus);
    if (outboxStatus === 'delivered' && Number.isInteger(code) && code >= 200 && code < 300) return 'Доставлено';
    if (typeof source.deliveryLabel === 'string' && source.deliveryLabel) return source.deliveryLabel;
    const route = more.route != null ? more.route : source.deliveryRoute;
    const nextRetryAt = more.nextRetryAt != null ? more.nextRetryAt : source.nextRetryAt;
    if (outboxStatus) return deliveryCaption(forwardStatus, { route, nextRetryAt, outboxStatus });
    const known = route != null || nextRetryAt != null;
    return deliveryCaption(forwardStatus, known ? { route, nextRetryAt } : undefined);
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
    if (Number.isInteger(code) && code >= 200 && code < 300) {
      return extra && extra.outboxStatus === 'delivered' ? 'Доставлено' : 'Отправлена';
    }
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

  function journalSplit(tasks) {
    const active = [];
    const cancelled = [];
    for (const task of tasks || []) {
      if (!task) continue;
      if (task.orderStatus === 'cancelled') cancelled.push(task);
      else active.push(task);
    }
    return { active, cancelled, badge: active.length };
  }

  // Журнал слева: бейдж и карточки — один набор. Тестовый текст не в активных.
  // Отменённые остаются в свёрнутом блоке, в бейдж не входят.
  function visibleJournal(tasks) {
    const split = journalSplit(tasks);
    const active = split.active.filter((task) => !silentTask(task));
    return {
      active,
      cancelled: split.cancelled,
      total: active.length,
    };
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

  // Один список для значка и для блока «Ждёт от вас»: чужие id не удваивают пункт.
  function needsForIds(needs, ids) {
    const seen = new Set();
    const list = [];
    for (const id of ids || []) {
      for (const need of needsForAgent(needs, id)) {
        if (!need || seen.has(need.id)) continue;
        seen.add(need.id);
        list.push(need);
      }
    }
    return list;
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

  function needAnswerBody(need) {
    if (!need) return '';
    if (typeof need.answer === 'string' && need.answer.trim()) return need.answer.trim();
    const list = Array.isArray(need.answers) ? need.answers : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const text = list[i] && typeof list[i].text === 'string' ? list[i].text.trim() : '';
      if (text) return text;
    }
    return '';
  }

  function answerDeliveryCaption(need, tasks, outbox) {
    if (!needAnswerBody(need)) return null;
    const id = need.id;
    const deliveredTask = (task) => !!(task && (orderDelivered(task) || task.outboxStatus === 'delivered'));
    for (const entry of outbox || []) {
      if (!entry || !entry.payload || entry.payload.needId !== id) continue;
      if (entry.payload.type && entry.payload.type !== 'answer') continue;
      if (entry.status !== 'delivered') continue;
      const code = Number(entry.lastStatus);
      if (Number.isInteger(code) && code >= 200 && code < 300) return 'Ответ получен агентом';
      const task = (tasks || []).find((row) => row && row.id === entry.taskId);
      if (deliveredTask(task)) return 'Ответ получен агентом';
    }
    for (const task of tasks || []) {
      if (!task) continue;
      const linked = task.needId === id
        || (need.what && String(task.text || '').startsWith(`Ответ Арсения на «${need.what}»`));
      if (linked && deliveredTask(task)) return 'Ответ получен агентом';
    }
    return 'Сохранён, ещё не доставлен';
  }

  function silentTask(task) {
    const rules = typeof TaskRules !== 'undefined' ? TaskRules : null;
    if (rules && typeof rules.isSilentTask === 'function') return rules.isSilentTask(task);
    if (!task) return false;
    if (task.orderStatus === 'cancelled') return true;
    const status = String(task.status || '').trim().toLowerCase();
    if (status === 'отменён' || status === 'отменен' || status === 'cancelled') return true;
    return String(task.text || '').trim().toLowerCase() === 'тест';
  }

  // Спокойная подпись, не реплика агента. Пустая строка — ждать нечего.
  function replyWaitCaption(tasks, messages, agentId) {
    const open = (tasks || []).filter((task) => {
      if (!task) return false;
      const status = task.orderStatus || 'sent';
      if (status === 'done' || status === 'cancelled' || status === 'failed') return false;
      if (task.status === 'выполнена' || task.status === 'отменён') return false;
      if (agentAnswered(task, messages)) return false;
      return (task.agentId || task.agent) === agentId;
    });
    if (!open.length) return '';
    const delivered = (task) => orderDelivered(task) || task.outboxStatus === 'delivered';
    if (open.some((task) => !delivered(task))) return 'Агенту ещё не доставлено';
    return 'Доставлено агенту, ответа пока нет';
  }

  const PROCESS_HOUR_MS = 60 * 60 * 1000;
  // То же окно, что STATUS_HOLD_MS в lib/activity.js. Ровно 15 минут уже не свежо.
  const PROCESS_HOLD_MS = 15 * 60 * 1000;

  function pickedUp(task) {
    const status = task && (task.orderStatus || 'sent');
    return status === 'accepted' || status === 'in_progress';
  }

  function latestMs(values) {
    let best = NaN;
    for (const value of values) {
      const t = typeof value === 'number' ? value : Date.parse(value || '');
      if (!Number.isFinite(t)) continue;
      if (!Number.isFinite(best) || t > best) best = t;
    }
    return best;
  }

  function freshAge(ms, now, holdMs) {
    if (!Number.isFinite(ms)) return false;
    const age = now - ms;
    if (age < 0) return true;
    return age < holdMs;
  }

  function agentById(agents, id) {
    if (!id) return null;
    return (agents || []).find((agent) => agent && agent.id === id) || null;
  }

  function assigneeFresh(agent, now, holdMs) {
    if (!agent) return false;
    const live = agent.live;
    if (live && live.status === 'working') {
      const until = Date.parse(live.until || '');
      if (Number.isFinite(until) && now < until) return true;
    }
    return freshAge(latestMs([agent.lastSeenAt, agent.doingSince, agent.lastStatusAt, agent.lastDashboardAt]), now, holdMs);
  }

  function orderTouchMs(task) {
    const hist = Array.isArray(task && task.history) ? task.history : [];
    const marks = [];
    for (const entry of hist) {
      if (!entry || (entry.status !== 'accepted' && entry.status !== 'in_progress')) continue;
      marks.push(entry.at);
    }
    const fromHistory = latestMs(marks);
    if (Number.isFinite(fromHistory)) return fromHistory;
    if (!pickedUp(task)) return NaN;
    return Date.parse((task && task.createdAt) || '');
  }

  function isLiveProcess(task, agents, now, holdMs) {
    const windowMs = Number.isFinite(holdMs) ? holdMs : PROCESS_HOLD_MS;
    const at = Number.isFinite(now) ? now : Date.now();
    if (!task || !pickedUp(task)) return false;
    if (freshAge(orderTouchMs(task), at, windowMs)) return true;
    return assigneeFresh(agentById(agents, task.agentId || task.agent), at, windowMs);
  }

  function routineShown(routine, agents, now, holdMs) {
    if (!routine || !routine.active || routine.finishedAt) return false;
    const windowMs = Number.isFinite(holdMs) ? holdMs : PROCESS_HOLD_MS;
    const at = Number.isFinite(now) ? now : Date.now();
    const started = Date.parse(routine.startedAt || '');
    if (freshAge(started, at, windowMs)) return true;
    return assigneeFresh(agentById(agents, routine.agentId), at, windowMs);
  }

  function processBuckets(tasks, routines, now = Date.now(), extras) {
    const ctx = extras && typeof extras === 'object' ? extras : {};
    const agents = ctx.agents || [];
    const messages = ctx.messages || [];
    const holdMs = Number.isFinite(ctx.holdMs) ? ctx.holdMs : PROCESS_HOLD_MS;
    const at = Number.isFinite(now) ? now : Date.now();
    const live = [];
    const undelivered = [];
    for (const task of tasks || []) {
      if (!task || silentTask(task) || isFinalRecord(task, messages)) continue;
      const status = task.orderStatus || 'sent';
      if (status !== 'sent' && status !== 'accepted' && status !== 'in_progress') continue;
      if (isLiveProcess(task, agents, at, holdMs)) {
        live.push(task);
        continue;
      }
      if (status !== 'sent' || orderDelivered(task)) continue;
      const created = Date.parse(task.createdAt || '');
      const age = Number.isFinite(created) ? now - created : Infinity;
      if (age > PROCESS_HOUR_MS) undelivered.push(task);
    }
    const pulses = (routines || []).filter((item) => routineShown(item, agents, at, holdMs));
    return { live, undelivered, pulses };
  }

  function isFinalRecord(task, messages) {
    if (!task) return true;
    const status = task.orderStatus || 'sent';
    if (status === 'done' || status === 'cancelled' || status === 'failed') return true;
    if (task.status === 'выполнена' || task.status === 'отменён') return true;
    if (task.answered === true || task.answerStatus === 'answered') return true;
    if (agentAnswered(task, messages)) return true;
    const delivered = orderDelivered(task) || task.outboxStatus === 'delivered';
    return delivered && status !== 'accepted' && status !== 'in_progress';
  }

  function countsAsActiveTask(task) {
    if (!task || silentTask(task) || isFinalRecord(task, [])) return false;
    const status = task.orderStatus || 'sent';
    return status === 'sent' || status === 'accepted' || status === 'in_progress';
  }

  function processPanel(tasks, routines, now = Date.now(), extras) {
    const buckets = processBuckets(tasks, routines, now, extras);
    const entries = buckets.live.concat(buckets.pulses);
    return {
      entries,
      total: entries.length,
      live: buckets.live,
      undelivered: buckets.undelivered,
      pulses: buckets.pulses,
    };
  }

  function countsAsQueued(task) {
    if (!task || silentTask(task)) return false;
    if (task.orderStatus === 'cancelled' || task.orderStatus === 'done' || task.orderStatus === 'failed') return false;
    if (task.status === 'выполнена') return false;
    return task.status === 'в очереди агента' || task.delivery === 'queue' || !task.orderStatus || task.orderStatus === 'sent';
  }

  function taskBadge(task, ctx) {
    const t = task || {};
    const context = ctx || {};
    const captionOf = (item) => taskDeliveryLabel(item);
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
    if (status === 'sent') return taskDeliveryLabel(task);
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
    taskDeliveryLabel,
    routeLabel,
    routePhrase,
    sentRoutePhrase,
    routeSummary,
    moscowClock,
    formatClockMsk,
    formatDateTimeMsk,
    formatProcessStamp,
    replyWaitCaption,
    needAnswerBody,
    answerDeliveryCaption,
    countsAsActiveTask,
    PROCESS_HOLD_MS,
    journalSplit,
    visibleJournal,
    isLiveProcess,
    processBuckets,
    processPanel,
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
    needsForIds,
    openNeedsForAgent,
    openNeedCount,
    needUrgencyView,
    countsMatch,
  };
});
