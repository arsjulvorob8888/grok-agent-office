'use strict';

// Живой статус агента: отдельный токен, короткий TTL и лимит частоты.
// Секрет из окружения в ответ и в лог не попадает.

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const DOING_MAX = 80;
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60 * 1000;
const KREMLIN_SUFFIX = /\s*·\s*кремль\s*$/i;

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

function stripKremlin(raw) {
  return normalize(raw).replace(KREMLIN_SUFFIX, '').trim();
}

function resolveAgent(raw, agents) {
  const text = normalize(raw);
  if (!text) return null;
  const list = Array.isArray(agents) ? agents : [];
  const byId = (value) => list.find((agent) => agent && String(agent.id).toLowerCase() === value.toLowerCase()) || null;
  const direct = byId(text);
  if (direct) return direct;
  const stripped = stripKremlin(text);
  if (stripped && stripped.toLowerCase() !== text.toLowerCase()) {
    const again = byId(stripped);
    if (again) return again;
  }
  const name = (stripped || text).toLowerCase();
  const named = list.filter((agent) => agent && stripKremlin(agent.name).toLowerCase() === name);
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

function apply(agent, input, at) {
  const active = liveOn(agent, at);
  if (input.status === 'idle') {
    const transition = active ? 'idle' : null;
    agent.live = { status: 'idle', doing: null, since: null, until: null };
    return { transition, doing: null };
  }
  const since = active && agent.live && agent.live.since ? agent.live.since : new Date(at).toISOString();
  let nextDoing = null;
  if (input.hasDoing) nextDoing = input.doing || null;
  else if (active && agent.live) nextDoing = agent.live.doing || null;
  agent.live = {
    status: 'working',
    doing: nextDoing,
    since,
    until: new Date(at + TTL_MS).toISOString(),
  };
  return { transition: active ? null : 'working', doing: nextDoing };
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
    agent.live = { status: 'idle', doing: null, since: null, until: null };
    gone.push(agent);
  }
  return gone;
}

function feedText(agent, transition, doing) {
  const name = (agent && agent.name) || (agent && agent.id) || 'Агент';
  if (transition === 'working') {
    return doing ? `${name} отметился: работает · ${doing}` : `${name} отметился: работает`;
  }
  return `${name} отметился: свободен`;
}

function register(app, deps) {
  app.post('/api/agent-status', (req, res) => {
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
    if (agent.archived) return res.status(409).json({ error: 'Агент в архиве' });
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
    const at = now();
    if (!allow(agent.id, at)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'Слишком часто' });
    }
    const result = apply(agent, { status: body.status, hasDoing, doing }, at);
    if (result.transition && typeof deps.addFeed === 'function') {
      deps.addFeed(agent, feedText(agent, result.transition, result.doing), at);
    }
    const view = deps.activityView(agent);
    const active = liveOn(agent, at);
    return res.json({
      ok: true,
      id: agent.id,
      status: active ? 'working' : 'idle',
      activity: view.activity,
      doing: view.doing,
      since: view.doingSince,
      until: active ? agent.live.until : null,
    });
  });
}

module.exports = {
  TTL_MS,
  now,
  setNow,
  resetForTests,
  resolveAgent,
  extend,
  expire,
  register,
};
