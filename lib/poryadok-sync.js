'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PORYADOK_URL = 'https://poryadok-1xfe.onrender.com';
const START_DELAY_MS = 15_000;
const DEBOUNCE_MS = 5_000;
const INTERVAL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
const DEFAULT_GOALS_FILE = path.join(__dirname, '..', 'config', 'finance-goals.json');

// Пункты, которых уже нет в хранилище, но «Порядок» мог получить открытыми.
// Снимок всегда шлёт их со статусом «Выполнено» и тем же externalId. Не удаляем.
const RETIRED_NEEDS = [
  {
    id: 'need-render-api',
    what: 'Ключ Render API — ввести через защищённую форму в чате DevOps',
    fromAgentId: 'devops',
    where: 'Защищённая форма в чате DevOps',
    urgency: 'high',
  },
  {
    id: 'need-academy',
    what: 'Одобрить Академию агентов: нажать «Да» в чатах Программирования и Тестировщика',
    fromAgentId: 'grok',
    where: 'Чаты агентов в Grok',
    urgency: 'normal',
  },
];

const PRIORITY_OK = new Set(['Срочно', 'Высокий', 'Средний', 'Низкий']);
const URGENCY_PRIORITY = { high: 'Срочно', normal: 'Средний', low: 'Низкий' };
const PRIORITY_ALIAS = {
  high: 'Срочно',
  urgent: 'Срочно',
  срочно: 'Срочно',
  normal: 'Средний',
  medium: 'Средний',
  средний: 'Средний',
  low: 'Низкий',
  низкий: 'Низкий',
  высокий: 'Высокий',
};

function readDelay(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function endpoint(base) {
  const raw = String(base || DEFAULT_PORYADOK_URL).trim().replace(/\/$/, '');
  if (raw.endsWith('/api/integrations/kremlin')) return raw;
  return `${raw}/api/integrations/kremlin`;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function agentNumber(agent, agents) {
  if (!agent || agent.archived) return '';
  if (agent.number != null && String(agent.number) !== '') return String(agent.number);
  const visible = agents.filter((a) => a && !a.archived);
  if (agent.parentId) {
    const parent = visible.find((a) => a.id === agent.parentId);
    const parentNum = parent ? agentNumber(parent, agents) : '?';
    const siblings = visible
      .filter((a) => a.parentId === agent.parentId)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
    const idx = siblings.findIndex((a) => a.id === agent.id);
    return `${parentNum}.${idx >= 0 ? idx + 1 : 1}`;
  }
  const tops = visible
    .filter((a) => !a.parentId)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
  const idx = tops.findIndex((a) => a.id === agent.id);
  return idx >= 0 ? String(idx + 1) : '';
}

function agentLabel(agent, agents) {
  if (!agent) return '';
  const number = agentNumber(agent, agents);
  const name = agent.name || agent.id;
  return number ? `${number}. ${name}` : String(name);
}

function findAgentById(agents, id) {
  if (!id) return null;
  return agents.find((a) => a.id === id) || null;
}

function isoDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Number.isNaN(Date.parse(`${s}T00:00:00.000Z`)) ? null : s;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function taskDeadline(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Number.isNaN(Date.parse(`${s}T00:00:00.000Z`)) ? null : s;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function mapPriority(value) {
  if (value == null || value === '') return 'Средний';
  const s = String(value).trim();
  if (PRIORITY_OK.has(s)) return s;
  return PRIORITY_ALIAS[s.toLowerCase()] || 'Средний';
}

function needClosed(need) {
  if (!need || typeof need !== 'object') return false;
  if (need.closedAt) return true;
  const status = need.status != null ? String(need.status) : '';
  return status === 'closed' || status === 'done';
}

function isRetiredNeed(need) {
  const id = need && need.id != null ? String(need.id) : '';
  return RETIRED_NEEDS.some((item) => item.id === id);
}

const NEED_PAGE_HINT = 'Откроется страница вопроса на сайте Кремля';
const DEFAULT_PUBLIC_ORIGIN = 'https://grok-agent-office.onrender.com';

function needPageUrl(id) {
  const raw = process.env.PUBLIC_URL;
  const base = (raw && String(raw).trim() ? String(raw).trim() : DEFAULT_PUBLIC_ORIGIN).replace(/\/$/, '');
  return `${base}/needs/${encodeURIComponent(String(id))}`;
}

function mapNeed(need, agents = []) {
  const agent = findAgentById(agents, need.fromAgentId);
  const who = agent ? agentLabel(agent, agents) : (need.fromAgentId ? String(need.fromAgentId) : 'неизвестный агент');
  const lines = [`От: ${who}`];
  if (need.where) lines.push(`Где: ${need.where}`);
  // В «Порядок» уходит только страница вопроса. Текст details, ответы и исходная
  // внешняя ссылка пункта в снимок не попадают.
  const actionUrl = need && need.id != null && String(need.id) !== '' ? needPageUrl(need.id) : null;
  const actionHint = actionUrl ? NEED_PAGE_HINT : null;
  if (actionUrl) lines.push(`Решить: ${actionUrl}`);
  if (actionHint) lines.push(actionHint);
  return {
    externalId: `kremlin-need-${need.id}`,
    title: String(need.what || '').trim() || 'Нужно от вас',
    priority: URGENCY_PRIORITY[need.urgency] || mapPriority(need.urgency),
    status: (isRetiredNeed(need) || needClosed(need)) ? 'Выполнено' : 'В ожидании',
    deadline: taskDeadline(need.deadline),
    description: lines.join('\n'),
    actionUrl,
    actionHint,
  };
}

function needTasks(needs, agents) {
  const list = listOf(needs).filter((item) => item && item.id != null && String(item.id) !== ''
    && item.kind !== 'test'
    && String(item.id) !== 'need-test-qa'
    && String(item.id) !== 'need-test-question');
  const seen = new Set(list.map((item) => String(item.id)));
  const tasks = list.map((item) => mapNeed(item, agents));
  for (const retired of RETIRED_NEEDS) {
    if (seen.has(retired.id)) continue;
    tasks.push(mapNeed({
      id: retired.id,
      what: retired.what,
      fromAgentId: retired.fromAgentId,
      where: retired.where,
      urgency: retired.urgency,
      closedAt: 'retired',
    }, agents));
  }
  return tasks;
}

function orderMapping(task) {
  const os = task.orderStatus != null && task.orderStatus !== '' ? String(task.orderStatus) : '';
  if (os === 'sent' || os === 'accepted') return { status: 'В ожидании', failed: false };
  if (os === 'in_progress') return { status: 'В процессе', failed: false };
  if (os === 'done') return { status: 'Выполнено', failed: false };
  if (os === 'failed') return { status: 'В ожидании', failed: true };
  const st = String(task.status || '');
  if (st === 'выполнена' || st === 'done') return { status: 'Выполнено', failed: false };
  if (st === 'failed' || st.includes('не выполнен')) return { status: 'В ожидании', failed: true };
  return { status: 'В ожидании', failed: false };
}

function isOwnerOrder(task) {
  if (!task || task.id == null || String(task.id) === '') return false;
  const from = task.fromAgentId;
  if (from == null) return true;
  const id = String(from).trim();
  return !id || id === 'owner';
}

function mapOwnerOrder(task, agents = []) {
  const mapped = orderMapping(task);
  const executorId = task.agentId || task.agent;
  const agent = findAgentById(agents, executorId);
  const who = agent ? agentLabel(agent, agents) : (executorId ? String(executorId) : 'неизвестный агент');
  const lines = [`Исполнитель: ${who}`];
  if (task.result) lines.push(`Результат: ${task.result}`);
  if (mapped.failed) lines.push('Не выполнен');
  return {
    externalId: `kremlin-order-${task.id}`,
    title: String(task.text || task.title || '').trim() || 'Поручение',
    priority: mapPriority(task.priority),
    status: mapped.status,
    deadline: taskDeadline(task.deadline),
    description: lines.join('\n'),
  };
}

function publicGoal(goal) {
  return {
    externalId: goal.externalId,
    title: goal.title,
    description: typeof goal.description === 'string' ? goal.description : '',
    deadline: goal.deadline == null ? null : goal.deadline,
    kpis: listOf(goal.kpis).map((k) => ({
      name: k.name,
      target: k.target == null ? null : k.target,
      current: k.current,
      unit: k.unit == null ? '' : String(k.unit),
    })),
  };
}

function buildPayload(state, goals, sentAt) {
  const src = state && typeof state === 'object' ? state : {};
  const agents = listOf(src.agents);
  // Открытые и закрытые пункты уходят в снимок. Снятые id, которых уже нет в хранилище,
  // добавляются как «Выполнено» с прежним externalId и не удаляются.
  const orders = listOf(src.tasks).filter(isOwnerOrder);
  return {
    source: 'kremlin',
    sentAt: sentAt || new Date().toISOString(),
    tasks: [
      ...needTasks(src.needs, agents),
      ...orders.map((task) => mapOwnerOrder(task, agents)),
    ],
    goals: listOf(goals).map(publicGoal),
  };
}

function countPayload(payload) {
  const tasks = payload && Array.isArray(payload.tasks) ? payload.tasks : [];
  return {
    needs: tasks.filter((t) => String(t.externalId || '').startsWith('kremlin-need-')).length,
    orders: tasks.filter((t) => String(t.externalId || '').startsWith('kremlin-order-')).length,
    goals: payload && Array.isArray(payload.goals) ? payload.goals.length : 0,
  };
}

function normalizeCurrent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeTarget(value) {
  if (value == null || value === '') return null;
  return normalizeCurrent(value);
}

function normalizeKpi(kpi) {
  if (!kpi || typeof kpi !== 'object') return null;
  const name = String(kpi.name || '').trim();
  if (!name) return null;
  return {
    name,
    target: normalizeTarget(kpi.target),
    current: normalizeCurrent(kpi.current),
    unit: kpi.unit == null ? '' : String(kpi.unit),
  };
}

function normalizeGoal(goal) {
  if (!goal || typeof goal !== 'object') return null;
  const externalId = String(goal.externalId || '').trim();
  const title = String(goal.title || '').trim();
  if (!externalId || !title) return null;
  return {
    externalId,
    title,
    description: typeof goal.description === 'string' ? goal.description : '',
    deadline: isoDate(goal.deadline),
    kpis: listOf(goal.kpis).map(normalizeKpi).filter(Boolean),
  };
}

function normalizeGoals(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.goals) ? data.goals : null);
  if (!list) {
    const error = new Error('ожидается массив целей');
    error.code = 'BAD_GOALS';
    throw error;
  }
  return list.map(normalizeGoal).filter(Boolean);
}

function readGoalFile(filePath) {
  return normalizeGoals(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function loadFinanceGoals(options = {}) {
  const filePath = options.filePath || DEFAULT_GOALS_FILE;
  const json = options.json !== undefined ? options.json : process.env.FINANCE_GOALS_JSON;
  if (json != null && String(json).trim() !== '') {
    try {
      return { goals: normalizeGoals(JSON.parse(String(json))), source: 'env', envError: false };
    } catch (_) {
      return { goals: readGoalFile(filePath), source: 'file', envError: true };
    }
  }
  return { goals: readGoalFile(filePath), source: 'file', envError: false };
}

function arm(delay, fn) {
  const timer = setTimeout(fn, delay);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function createPoryadokSync(options = {}) {
  const token = String(
    options.token !== undefined ? options.token : (process.env.PORYADOK_INGEST_TOKEN || '')
  ).trim();
  const enabled = token.length > 0;
  const url = endpoint(options.baseUrl !== undefined ? options.baseUrl : process.env.PORYADOK_URL);
  const debounceMs = readDelay(
    options.debounceMs !== undefined ? options.debounceMs : process.env.PORYADOK_SYNC_DEBOUNCE_MS,
    DEBOUNCE_MS
  );
  const startupDelayMs = readDelay(
    options.startupDelayMs !== undefined ? options.startupDelayMs : process.env.PORYADOK_SYNC_START_MS,
    START_DELAY_MS
  );
  const intervalMs = readDelay(options.intervalMs, INTERVAL_MS) || INTERVAL_MS;
  const timeoutMs = readDelay(options.timeoutMs, TIMEOUT_MS) || TIMEOUT_MS;
  const retryDelays = Array.isArray(options.retryDelays) && options.retryDelays.length
    ? options.retryDelays
    : RETRY_DELAYS;
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const log = options.log || ((msg) => console.log(msg));
  const logError = options.logError || ((msg) => console.error(msg));
  const getState = typeof options.getState === 'function' ? options.getState : () => ({});
  const hasGoalsOverride = Object.prototype.hasOwnProperty.call(options, 'financeGoalsJson');

  const status = { lastOkAt: null, lastError: null, lastCounts: null };
  let loggedDisabled = false;
  let goalsWarned = false;
  let debounceTimer = null;
  let retryTimer = null;
  let startupTimer = null;
  let interval = null;
  let running = false;
  let dirty = false;
  let attempt = 0;
  let stopped = false;
  let listeningArmed = false;
  let lastFp = '';

  function logDisabledOnce() {
    if (loggedDisabled) return;
    loggedDisabled = true;
    try { log('Синхронизация с Порядком выключена: не задан PORYADOK_INGEST_TOKEN'); } catch (_) {}
  }

  function goalsNow() {
    try {
      const loaded = loadFinanceGoals({
        json: hasGoalsOverride ? options.financeGoalsJson : undefined,
        filePath: options.goalsFile,
      });
      if (loaded.envError && !goalsWarned) {
        goalsWarned = true;
        try { log('FINANCE_GOALS_JSON не разобран, используются цели из config/finance-goals.json'); } catch (_) {}
      }
      return loaded.goals;
    } catch (_) {
      if (!goalsWarned) {
        goalsWarned = true;
        try { log('Цели для Порядка не прочитаны, отправляю без них'); } catch (_) { /* лог не должен ронять синхронизацию */ }
      }
      return [];
    }
  }

  function fingerprint() {
    return JSON.stringify(buildPayload(getState() || {}, []).tasks);
  }

  function safeMessage(err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError' || (err && (err.code === 23 || err.code === 'ABORT_ERR'))) {
      return 'timeout';
    }
    let msg = 'network_error';
    if (err && typeof err.message === 'string' && /^HTTP \d+$/.test(err.message.trim())) msg = err.message.trim();
    if (token && msg.includes(token)) msg = msg.split(token).join('***');
    return msg.slice(0, 200);
  }

  async function deliver(payload) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res && typeof res.arrayBuffer === 'function') await res.arrayBuffer().catch(() => {});
    else if (res && typeof res.text === 'function') await res.text().catch(() => {});
    if (!res || !res.ok) {
      const code = res && Number.isFinite(Number(res.status)) ? res.status : 0;
      throw new Error(`HTTP ${code}`);
    }
  }

  function scheduleRetry() {
    if (!enabled || stopped || attempt >= retryDelays.length) return;
    const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
    attempt += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = arm(delay, () => {
      retryTimer = null;
      void flush();
    });
  }

  async function flush() {
    if (!enabled || stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    running = true;
    dirty = false;
    try {
      const payload = buildPayload(getState() || {}, goalsNow());
      payload.sentAt = new Date().toISOString();
      await deliver(payload);
      attempt = 0;
      status.lastOkAt = payload.sentAt;
      status.lastError = null;
      status.lastCounts = countPayload(payload);
      try { lastFp = JSON.stringify(payload.tasks); } catch (_) {}
    } catch (err) {
      const message = safeMessage(err);
      status.lastError = message;
      try { logError(`Синхронизация с Порядком не удалась: ${message}`); } catch (_) {}
      scheduleRetry();
    } finally {
      running = false;
      if (dirty && !stopped && !retryTimer) schedule();
    }
  }

  function schedule() {
    try {
      if (!enabled || stopped) {
        if (!enabled) logDisabledOnce();
        return;
      }
      dirty = true;
      attempt = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (running) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = arm(debounceMs, () => {
        debounceTimer = null;
        void flush();
      });
    } catch (_) { /* синхронизация не роняет сервер */ }
  }

  function noteRequestFinished() {
    if (!enabled || stopped) return;
    try {
      const fp = fingerprint();
      if (fp === lastFp) return;
      lastFp = fp;
      schedule();
    } catch (_) {}
  }

  function onListening() {
    if (listeningArmed || stopped) return;
    listeningArmed = true;
    if (!enabled) {
      logDisabledOnce();
      return;
    }
    try {
      startupTimer = arm(startupDelayMs, () => {
        startupTimer = null;
        attempt = 0;
        void flush();
      });
      interval = setInterval(() => {
        attempt = 0;
        void flush();
      }, intervalMs);
      if (typeof interval.unref === 'function') interval.unref();
    } catch (_) {}
  }

  function start() {
    if (!enabled) logDisabledOnce();
  }

  function stop() {
    stopped = true;
    if (interval) clearInterval(interval);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (startupTimer) clearTimeout(startupTimer);
    interval = null;
    debounceTimer = null;
    retryTimer = null;
    startupTimer = null;
  }

  function publicStatus() {
    return {
      enabled,
      lastOkAt: status.lastOkAt,
      lastError: status.lastError,
      lastCounts: status.lastCounts ? { ...status.lastCounts } : null,
    };
  }

  function handles() {
    return { startup: startupTimer, interval, debounce: debounceTimer, retry: retryTimer };
  }

  try { lastFp = fingerprint(); } catch (_) { lastFp = ''; }

  return {
    start,
    stop,
    schedule,
    noteRequestFinished,
    onListening,
    publicStatus,
    handles,
    endpoint: url,
  };
}

module.exports = {
  START_DELAY_MS,
  DEBOUNCE_MS,
  INTERVAL_MS,
  DEFAULT_PORYADOK_URL,
  DEFAULT_GOALS_FILE,
  loadFinanceGoals,
  NEED_PAGE_HINT,
  needPageUrl,
  RETIRED_NEEDS,
  buildPayload,
  mapNeed,
  mapOwnerOrder,
  isOwnerOrder,
  createPoryadokSync,
  countPayload,
};
