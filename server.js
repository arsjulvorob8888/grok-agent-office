'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const GROK_WEBHOOK_URL = process.env.GROK_WEBHOOK_URL || '';
const GROK_WEBHOOK_KEY = process.env.GROK_WEBHOOK_KEY || '';
const GROK_WEBHOOK_HEADER = process.env.GROK_WEBHOOK_HEADER || 'Authorization';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const STATUS_LABELS = {
  working: 'Работает',
  idle: 'Свободен',
  waiting: 'Ждёт тебя',
};

const SEED_AGENTS = [
  {
    id: 'grok',
    name: 'Grok',
    color: '#222',
    accent: '#f7931e',
    role: 'Главный помощник',
    x: 380,
    y: 70,
    links: ['biz', 'poker', 'lang'],
  },
  {
    id: 'lang',
    name: 'Language Coach',
    color: '#f59e0b',
    accent: '#fff',
    role: 'Репетитор английского',
    x: 90,
    y: 340,
    links: [],
  },
  {
    id: 'poker',
    name: 'POKER APP BOT',
    color: '#ec4899',
    accent: '#fff',
    role: 'Покерное приложение',
    x: 380,
    y: 370,
    links: [],
  },
  {
    id: 'biz',
    name: 'Business Adviser',
    color: '#14b8a6',
    accent: '#fff',
    role: 'Бизнес-идеи и аналитика',
    x: 680,
    y: 340,
    links: [],
  },
];

const EXTRA_SLOTS = [
  { x: 90, y: 70 },
  { x: 680, y: 70 },
  { x: 230, y: 200 },
  { x: 530, y: 200 },
  { x: 90, y: 450 },
  { x: 680, y: 450 },
];

function seedAgent(base) {
  return {
    ...base,
    status: 'idle',
    now: 'Жду задач',
    done: [],
  };
}

const state = {
  agents: SEED_AGENTS.map(seedAgent),
  tasks: [],
  nextTaskId: 1,
};

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function publicState() {
  return {
    agents: state.agents.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      accent: a.accent,
      role: a.role,
      x: a.x,
      y: a.y,
      links: a.links || [],
      status: a.status,
      now: a.now,
      done: a.done.slice(),
    })),
    tasks: state.tasks.slice(0, 100).map((t) => ({
      id: t.id,
      agent: t.agent,
      text: t.text,
      status: t.status,
      createdAt: t.createdAt,
      forwardStatus: t.forwardStatus,
      result: t.result ?? null,
    })),
  };
}

function findAgent(id) {
  return state.agents.find((a) => a.id === id);
}

function nextSlot() {
  const used = new Set(state.agents.map((a) => `${a.x},${a.y}`));
  for (const slot of EXTRA_SLOTS) {
    if (!used.has(`${slot.x},${slot.y}`)) return slot;
  }
  const i = state.agents.length;
  return { x: 40 + (i % 5) * 170, y: 40 + Math.floor(i / 5) * 160 };
}

function webhookHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (!GROK_WEBHOOK_KEY) return headers;
  headers['x-webhook-key'] = GROK_WEBHOOK_KEY;
  const name = GROK_WEBHOOK_HEADER || 'Authorization';
  if (name.toLowerCase() !== 'x-webhook-key') {
    if (name.toLowerCase() === 'authorization') {
      headers[name] = `Bearer ${GROK_WEBHOOK_KEY}`;
    } else {
      headers[name] = GROK_WEBHOOK_KEY;
    }
  }
  return headers;
}

function pushTask(task) {
  state.tasks.unshift(task);
  if (state.tasks.length > 100) state.tasks.length = 100;
}

function requireAppPassword(req, res, next) {
  if (!APP_PASSWORD) {
    return res.status(503).json({ error: 'Пароль доступа не настроен (APP_PASSWORD)' });
  }
  const provided = req.get('x-app-password') || '';
  if (!safeEqual(provided, APP_PASSWORD)) {
    return res.status(401).json({ error: 'Неверный пароль доступа' });
  }
  next();
}

function requireAgentToken(req, res, next) {
  if (!AGENT_TOKEN) {
    return res.status(503).json({ error: 'Токен агентов не настроен (AGENT_TOKEN)' });
  }
  const provided = req.get('x-agent-token') || '';
  if (!safeEqual(provided, AGENT_TOKEN)) {
    return res.status(401).json({ error: 'Неверный токен агента' });
  }
  next();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/api/state', (_req, res) => {
  res.json(publicState());
});

app.post('/api/task', requireAppPassword, async (req, res) => {
  const agentId = typeof req.body?.agent === 'string' ? req.body.agent.trim() : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!agentId || !text) {
    return res.status(400).json({ error: 'Нужны поля agent и text' });
  }
  const agent = findAgent(agentId);
  if (!agent) {
    return res.status(400).json({ error: 'Неизвестный агент' });
  }

  const task = {
    id: `t-${state.nextTaskId++}`,
    agent: agentId,
    text,
    status: GROK_WEBHOOK_URL ? 'отправлена' : 'не отправлена: вебхук не настроен',
    createdAt: new Date().toISOString(),
    forwardStatus: null,
    result: null,
  };

  agent.status = 'working';
  agent.now = text;
  pushTask(task);

  if (GROK_WEBHOOK_URL) {
    try {
      const response = await fetch(GROK_WEBHOOK_URL, {
        method: 'POST',
        headers: webhookHeaders(),
        body: JSON.stringify({
          agent: agentId,
          text,
          taskId: task.id,
          appUrl: PUBLIC_URL,
        }),
        signal: AbortSignal.timeout(10000),
      });
      task.forwardStatus = response.status;
    } catch (err) {
      task.forwardStatus = 0;
      task.forwardError = err && err.name === 'TimeoutError' ? 'timeout' : 'network_error';
    }
  }

  const out = {
    id: task.id,
    agent: task.agent,
    text: task.text,
    status: task.status,
    createdAt: task.createdAt,
    forwardStatus: task.forwardStatus,
    result: task.result,
  };
  res.status(201).json(out);
});

app.post('/api/status', requireAgentToken, (req, res) => {
  const body = req.body || {};
  const agentId = typeof body.agent === 'string' ? body.agent.trim() : '';
  if (!agentId) {
    return res.status(400).json({ error: 'Нужно поле agent' });
  }
  if (body.status != null && !STATUS_LABELS[body.status]) {
    return res.status(400).json({ error: 'status должен быть working, idle или waiting' });
  }

  let agent = findAgent(agentId);
  if (!agent) {
    const slot = nextSlot();
    agent = {
      id: agentId,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : agentId,
      color: typeof body.color === 'string' && body.color.trim() ? body.color.trim() : '#64748b',
      accent: typeof body.accent === 'string' && body.accent.trim() ? body.accent.trim() : '#fff',
      role: typeof body.role === 'string' && body.role.trim() ? body.role.trim() : 'Агент',
      x: slot.x,
      y: slot.y,
      links: [],
      status: 'idle',
      now: 'Жду задач',
      done: [],
    };
    state.agents.push(agent);
  } else {
    if (typeof body.name === 'string' && body.name.trim()) agent.name = body.name.trim();
    if (typeof body.color === 'string' && body.color.trim()) agent.color = body.color.trim();
    if (typeof body.accent === 'string' && body.accent.trim()) agent.accent = body.accent.trim();
    if (typeof body.role === 'string' && body.role.trim()) agent.role = body.role.trim();
  }

  if (body.status) agent.status = body.status;
  if (typeof body.now === 'string') agent.now = body.now;

  if (typeof body.done === 'string' && body.done.trim()) {
    agent.done.unshift(body.done.trim());
    if (agent.done.length > 10) agent.done.length = 10;
  }

  if (body.taskId && typeof body.result === 'string') {
    const task = state.tasks.find((t) => t.id === body.taskId);
    if (task) {
      task.result = body.result;
      task.status = 'выполнена';
    }
  }

  res.json({
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      now: agent.now,
      done: agent.done.slice(),
    },
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Офис агентов Grok слушает 0.0.0.0:${PORT}`);
});
