'use strict';

// Живой статус агента: отдельный токен, короткий TTL и лимит частоты.
// Секрет из окружения в ответ и в лог не попадает.

const crypto = require('crypto');
const { STATUS_HOLD_MS, settleRawStatus, activeWindowMs } = require('./activity');

const TTL_MS = STATUS_HOLD_MS;
const DOING_MAX = 80;
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60 * 1000;
let nowFn = () => Date.now();
const hits = new Map();

function now() {
  return nowFn();
}

function setNow(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

function resetForTests() {
  hits.clear();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function configuredToken(env = process.env) {
  const raw = env && env.AGENT_STATUS_TOKEN;
  return typeof raw === 'string' ? raw : '';
}

function bearer(header) {
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  if (!match) return '';
  return match[1].trim();
}

function normalize(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function dotFold(raw) {
  return normalize(raw).replace(/\s*·\s*/g, ' · ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function withoutKremlin(raw) {
  return dotFold(raw).replace(/\s·\s*кремль$/, '').trim();
}

// «Grok» в любом регистре, кроме точной строки id `grok`, — другой бот.
function rejectBareGrok(raw) {
  const core = normalize(raw).replace(/\s*·\s*кремль\s*$/i, '').trim();
  return core.toLowerCase() === 'grok' && core !== 'grok';
}

function aliasKeys(agent) {
  const bag = [];
  if (agent && typeof agent.name === 'string') bag.push(agent.name);
  if (agent && typeof agent.id === 'string') bag.push(agent.id);
  if (agent && Array.isArray(agent.aliases)) bag.push(...agent.aliases);
  return bag.filter((item) => typeof item === 'string' && item.trim());
}

function resolveAgent(raw, agents) {
  const text = normalize(raw);
  if (!text) return null;
  if (rejectBareGrok(text)) return null;
  const list = (Array.isArray(agents) ? agents : []).filter(Boolean);
  const folded = dotFold(text);
  const core = withoutKremlin(text);
  const exactCore = text.replace(/\s*·\s*кремль\s*$/i, '').trim();
  const byId = list.find((agent) => {
    const id = String(agent.id);
    return id === exactCore || id.toLowerCase() === core;
  });
  if (byId) return byId;
  const named = list.filter((agent) => aliasKeys(agent).some((name) => {
    const foldedName = dotFold(name);
    const nameCore = withoutKremlin(name);
    return folded === foldedName || folded === nameCore || core === foldedName || core === nameCore;
  }));
  if (named.length === 1) return named[0];
  return null;
}

function cleanDoing(value) {
  if (typeof value !== 'string') return { error: 'doing должен быть строкой' };
  const text = value.trim();
  if (!text) return { doing: null };
  if (/[<>]/.test(text)) return { error: 'doing не должен содержать HTML' };
  if (text.length > DOING_MAX) return { error: 'doing длиннее 80 символов' };
  return { doing: text };
}

function liveOn(agent, at) {
  const live = agent && agent.live;
  if (!live || live.status !== 'working') return false;
  const until = Date.parse(live.until);
  return Number.isFinite(until) && at < until;
}

function allow(agentId, at) {
  const list = (hits.get(agentId) || []).filter((stamp) => at - stamp < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    hits.set(agentId, list);
    return false;
  }
  list.push(at);
  hits.set(agentId, list);
  return true;
}

function resolveBehalf(raw, agents) {
  const text = normalize(raw);
  if (!text) return { forAgent: null };
  if (text.toLowerCase() === 'putin') {
    const grok = (agents || []).find((agent) => agent && agent.id === 'grok');
    return grok ? { forAgent: grok.id } : { error: 'Неизвестный forAgent' };
  }
  const found = resolveAgent(text, agents);
  if (!found) return { error: 'Неизвестный forAgent' };
  if (found.archived) return { error: 'Агент в архиве' };
  return { forAgent: found.id };
}

function apply(agent, input, at) {
  const active = liveOn(agent, at);
  if (input.status === 'idle') {
    const transition = active ? 'idle' : null;
    agent.live = { status: 'idle', doing: null, since: null, until: null, forAgent: null };
    return { transition, doing: null, forAgent: null };
  }
  const since = active && agent.live && agent.live.since ? agent.live.since : new Date(at).toISOString();
  let nextDoing = null;
  if (input.hasDoing) nextDoing = input.doing || null;
  else if (active && agent.live) nextDoing = agent.live.doing || null;
  let forAgent = null;
  if (input.hasFor) forAgent = input.forAgent || null;
  else if (active && agent.live) forAgent = agent.live.forAgent || null;
  agent.live = {
    status: 'working',
    doing: nextDoing,
    since,
    until: new Date(at + TTL_MS).toISOString(),
    forAgent,
  };
  return { transition: active ? null : 'working', doing: nextDoing, forAgent };
}

function extend(agent, at) {
  if (!liveOn(agent, at)) return false;
  agent.live.until = new Date(at + TTL_MS).toISOString();
  return true;
}

function expire(agents, at) {
  const gone = [];
  for (const agent of agents || []) {
    const record = agent && agent.live;
    if (!record || record.status !== 'working') continue;
    const until = Date.parse(record.until);
    if (Number.isFinite(until) && at < until) continue;
    agent.live = {
      status: 'idle',
      doing: null,
      since: null,
      until: null,
      forAgent: null,
      updatedAt: record.updatedAt || null,
    };
    gone.push(agent);
  }
  return gone;
}

// Будильник на границе окна. Срок живого хода уже лежит в until (TTL = STATUS_HOLD_MS).
// Сырой status снимает settleRawStatus. Пульс и дашборд смотрят в activeWindowMs.
// Новых 10 или 15 минут здесь нет.
function createStatusSweep(opts) {
  const list = opts.agents;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const publish = opts.publish;
  const onSettled = opts.onSettled;
  const activityOf = opts.activityOf;
  const setTimer = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.cancel || ((timer) => clearTimeout(timer));
  const windowMs = typeof opts.windowMs === 'function' ? opts.windowMs : () => activeWindowMs();
  let timer = null;
  let stopped = false;
  let lastSig = null;

  function stamp(agent, at) {
    let view = {};
    try {
      if (typeof activityOf === 'function') view = activityOf(agent, at) || {};
    } catch (_) { view = {}; }
    return [
      agent && agent.id,
      agent && agent.status,
      view.activity || '',
      view.doing || '',
      view.currentTask || '',
    ].join('\u001f');
  }

  function signature(at) {
    return (list() || []).map((agent) => stamp(agent, at)).join('\n');
  }

  function consider(times, value) {
    if (!Number.isFinite(value)) return;
    times.push(value);
  }

  function dueNow(at) {
    for (const agent of list() || []) {
      if (!agent) continue;
      const record = agent.live;
      if (record && record.status === 'working') {
        const until = Date.parse(record.until);
        if (!Number.isFinite(until) || at >= until) return true;
      }
      if (agent.status !== 'working') continue;
      const until = record && Date.parse(record.until);
      const liveHolds = !!(record && record.status === 'working' && Number.isFinite(until) && at < until);
      const stampAt = Date.parse(agent.lastStatusAt);
      const age = at - stampAt;
      const manual = Number.isFinite(stampAt) && (age < 0 || age < STATUS_HOLD_MS);
      if (!liveHolds && !manual) return true;
    }
    return false;
  }

  function nextDelay(at) {
    const win = windowMs();
    const times = [];
    for (const agent of list() || []) {
      if (!agent) continue;
      const record = agent.live;
      if (record && record.status === 'working') consider(times, Date.parse(record.until));
      if (agent.status === 'working') {
        const manual = Date.parse(agent.lastStatusAt);
        consider(times, Number.isFinite(manual) ? manual + STATUS_HOLD_MS : at);
      }
      const seen = Date.parse(agent.lastSeenAt);
      if (Number.isFinite(seen)) consider(times, seen + win + 1);
      const dash = Date.parse(agent.lastDashboardAt);
      if (Number.isFinite(dash)) consider(times, dash + win + 1);
    }
    const ahead = times.filter((value) => value > at);
    if (!ahead.length) return null;
    return Math.min(...ahead) - at;
  }

  function arm() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = null;
    const at = now();
    if (lastSig == null) lastSig = signature(at);
    const delay = dueNow(at) ? 0 : nextDelay(at);
    if (delay == null) return;
    timer = setTimer(run, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function run() {
    timer = null;
    if (stopped) return;
    const at = now();
    const before = lastSig;
    const gone = expire(list(), at);
    const settled = settleRawStatus(list(), at);
    if (settled.length && typeof onSettled === 'function') {
      try { onSettled(settled); } catch (_) { /* запись карточки не должна ронять поток */ }
    }
    const sig = signature(at);
    const changed = before != null && sig !== before;
    lastSig = sig;
    if ((gone.length || settled.length || changed) && typeof publish === 'function') {
      try { publish(); } catch (_) { /* поток не обязателен */ }
    }
    arm();
  }

  function touch() {
    if (stopped) return;
    lastSig = signature(now());
    arm();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return {
    arm,
    run,
    touch,
    stop,
    armed: () => timer != null,
  };
}

const REPLY_MAX = 4000;

function readReply(body) {
  const hasTask = Object.prototype.hasOwnProperty.call(body, 'taskId')
    && body.taskId != null
    && String(body.taskId).trim() !== '';
  const hasReply = Object.prototype.hasOwnProperty.call(body, 'reply')
    && body.reply != null
    && String(body.reply).trim() !== '';
  if (!hasTask && !hasReply) return { present: false };
  if (!hasTask || !hasReply) return { error: 'Нужны taskId и reply' };
  if (typeof body.taskId !== 'string') return { error: 'taskId должен быть строкой' };
  if (typeof body.reply !== 'string') return { error: 'reply должен быть строкой' };
  const taskId = body.taskId.trim().slice(0, 64);
  const text = body.reply.trim();
  if (!taskId || !text) return { error: 'Нужны taskId и reply' };
  if (text.length > REPLY_MAX) return { error: 'Слишком длинное сообщение (максимум 4000 символов)' };
  return { present: true, taskId, text };
}

function touchSeen(agent, at) {
  const iso = new Date(at).toISOString();
  const prev = Date.parse(agent && agent.lastSeenAt);
  if (!Number.isFinite(prev) || at >= prev) agent.lastSeenAt = iso;
  agent.statusSeenAt = agent.lastSeenAt;
  if (agent.live && typeof agent.live === 'object') agent.live.updatedAt = iso;
  agent.liveUpdatedAt = iso;
  return agent.lastSeenAt;
}

function feedText(agent, transition, doing) {
  const name = (agent && agent.name) || (agent && agent.id) || 'Агент';
  if (transition === 'working') {
    return doing ? `${name} отметился: работает · ${doing}` : `${name} отметился: работает`;
  }
  return `${name} отметился: свободен`;
}

function register(app, deps) {
  app.post('/api/agent-status', async (req, res) => {
    try {
      const token = configuredToken();
      if (!token) {
        return res.status(503).json({ error: 'Токен живого статуса не настроен (AGENT_STATUS_TOKEN)' });
      }
      const provided = bearer(req.get('authorization') || '');
      if (!provided || !safeEqual(provided, token)) {
        return res.status(401).json({ error: 'Неверный токен живого статуса' });
      }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      if (!body) return res.status(400).json({ error: 'Нужен JSON-объект' });
      const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
      if (!agentId) return res.status(400).json({ error: 'Нужен agentId' });
      const agent = resolveAgent(agentId, deps.agents());
      if (!agent) return res.status(404).json({ error: 'Неизвестный агент' });
      if (agent.archived && !agent.parentId) {
        return res.status(409).json({
          error: 'агент в архиве на карте — статус не принят',
          agentId: agent.id,
        });
      }
      if (body.status !== 'working' && body.status !== 'idle') {
        return res.status(400).json({ error: 'status должен быть working или idle' });
      }
      let hasDoing = Object.prototype.hasOwnProperty.call(body, 'doing') && body.doing != null;
      let doing = null;
      if (hasDoing) {
        const cleaned = cleanDoing(body.doing);
        if (cleaned.error) return res.status(400).json({ error: cleaned.error });
        doing = cleaned.doing;
      }
      let hasFor = false;
      let rawFor;
      if (Object.prototype.hasOwnProperty.call(body, 'forAgent')) {
        hasFor = true;
        rawFor = body.forAgent;
      } else if (Object.prototype.hasOwnProperty.call(body, 'onBehalfOf')) {
        hasFor = true;
        rawFor = body.onBehalfOf;
      }
      let forAgent = null;
      if (hasFor && rawFor != null && rawFor !== '') {
        if (typeof rawFor !== 'string') return res.status(400).json({ error: 'forAgent должен быть строкой' });
        const resolved = resolveBehalf(rawFor, deps.agents());
        if (resolved.error) return res.status(400).json({ error: resolved.error });
        forAgent = resolved.forAgent;
      }
      const reply = readReply(body);
      if (reply.error) return res.status(400).json({ error: reply.error });
      if (reply.present && typeof deps.previewReply === 'function') {
        const gate = deps.previewReply(agent, reply);
        if (gate && gate.error) return res.status(gate.status || 400).json({ error: gate.error });
      }
      if (reply.present && typeof deps.allowMessage === 'function' && !deps.allowMessage(agent.id)) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Слишком часто' });
      }
      const at = now();
      if (!allow(agent.id, at)) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Слишком часто' });
      }
      const result = apply(agent, { status: body.status, hasDoing, doing, hasFor, forAgent }, at);
      touchSeen(agent, at);
      let saved = null;
      if (reply.present && typeof deps.commitReply === 'function') {
        saved = deps.commitReply(agent, reply, at);
      }
      if (result.transition && typeof deps.addFeed === 'function') {
        deps.addFeed(agent, feedText(agent, result.transition, result.doing), at);
      }
      if (typeof deps.persist === 'function') await deps.persist(agent);
      if (typeof deps.publish === 'function') {
        try { deps.publish(); } catch (_) { /* поток не обязателен для ответа */ }
      }
      const view = deps.activityView(agent);
      const active = liveOn(agent, at);
      const payload = {
        ok: true,
        id: agent.id,
        status: active ? 'working' : 'idle',
        activity: view.activity,
        doing: view.doing,
        since: view.doingSince,
        until: active ? agent.live.until : null,
        forAgent: active && agent.live && agent.live.forAgent ? agent.live.forAgent : null,
      };
      if (saved) {
        payload.duplicate = !!saved.duplicate;
        payload.message = saved.message;
      }
      return res.json(payload);
    } catch (err) {
      const status = err.status || 500;
      if (!err.status) console.error(err);
      if (!res.headersSent) return res.status(status).json({ error: err.expose || 'Не удалось сохранить статус' });
      return undefined;
    }
  });
}

module.exports = {
  TTL_MS,
  now,
  setNow,
  resetForTests,
  resolveAgent,
  readReply,
  touchSeen,
  extend,
  expire,
  createStatusSweep,
  register,
};
