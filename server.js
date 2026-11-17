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

// ─────────────────────────────────────────────────────────────────────────────
// РОСТЕР АГЕНТОВ. Это единственное место, где задаются агенты на карте Москвы.
// x / y — координаты на карте (холст 1600×1100, север сверху, Кремль ≈ 800×540).
// kind — тип фигурки на клиенте: putin, army, poker, trading, devops, dev,
//        temshik, blog, lang, biz, vacant, generic.
// tier — main (главный), dept (направление), extra (союзник, необязательный).
// ─────────────────────────────────────────────────────────────────────────────
const SEED_AGENTS = [
  {
    id: 'grok',
    name: 'Главный агент · GROK',
    color: '#c8102e',
    accent: '#f5c451',
    role: 'Главнокомандующий агентами',
    district: 'Кремль',
    kind: 'putin',
    tier: 'main',
    x: 800,
    y: 540,
    links: ['army', 'poker', 'trading', 'devops', 'dev', 'temshik', 'blog', 'slot8', 'lang', 'biz'],
    responsibilities: [
      'Принимает задачи и распределяет их по направлениям',
      'Следит за сроками и качеством результатов',
      'Собирает итоги и докладывает тебе',
    ],
  },
  {
    id: 'army',
    name: 'Военная служба',
    color: '#4d7c3a',
    accent: '#e8d9a8',
    role: 'Данные, законы и аналитика для командования',
    district: 'Фрунзенская набережная',
    kind: 'army',
    tier: 'dept',
    x: 590,
    y: 655,
    links: [],
    responsibilities: [
      'Работа с данными: Excel, Word, Python',
      'Законы о военной службе, льготы, социальные программы',
      'Воинские уставы',
      'Инфографика, аналитика, модели предсказания',
      'Дашборды и презентации из Excel для командования',
    ],
  },
  {
    id: 'poker',
    name: 'Покер',
    color: '#0f8a5f',
    accent: '#f5f0e1',
    role: 'POKER APP BOT · Spin&Go 3-max',
    district: 'Арбат',
    kind: 'poker',
    tier: 'dept',
    x: 545,
    y: 470,
    links: [],
    responsibilities: [
      'Изучение Spin&Go 3-max (app.gtobase.com, train-spin-go.onrender.com)',
      'Математика покера: эквити, шансы банка, вероятности, блеф',
      'Развитие приложения train-spin-go',
      'Новые сервисы для обучения',
      'Аналитика трекеров',
    ],
  },
  {
    id: 'trading',
    name: 'Трейдинг',
    color: '#1f7ae0',
    accent: '#bfe3ff',
    role: 'Торговый скрипт и аналитика',
    district: 'Москва-Сити',
    kind: 'trading',
    tier: 'dept',
    x: 345,
    y: 415,
    links: [],
    responsibilities: [
      'Скрипт для торговли по стратегии',
      'Вывод аналитики по сделкам',
    ],
  },
  {
    id: 'devops',
    name: 'DevOps',
    color: '#e0662b',
    accent: '#ffe0c7',
    role: 'Серверы, деплой, мониторинг',
    district: 'Таганка',
    kind: 'devops',
    tier: 'dept',
    x: 1110,
    y: 640,
    links: [],
    responsibilities: [
      'Деплой приложений (Render, GitHub)',
      'Мониторинг и аптайм сервисов',
      'Автоматизация и CI/CD',
    ],
  },
  {
    id: 'dev',
    name: 'Программирование',
    color: '#7c4dff',
    accent: '#e3d8ff',
    role: 'Разработка приложений и скриптов',
    district: 'Тверская',
    kind: 'dev',
    tier: 'dept',
    x: 640,
    y: 290,
    links: [],
    responsibilities: [
      'Пишет и дорабатывает код',
      'Веб-приложения и боты',
      'Код-ревью и исправление ошибок',
    ],
  },
  {
    id: 'temshik',
    name: 'Темщик',
    color: '#d4a017',
    accent: '#fff3c4',
    role: 'Поиск тем и способов заработка',
    district: 'Замоскворечье',
    kind: 'temshik',
    tier: 'dept',
    x: 960,
    y: 790,
    links: [],
    responsibilities: [
      'Ищет новые темы и связки для заработка',
      'Проверяет идеи на риски и окупаемость',
      'Готовит короткие планы запуска',
    ],
  },
  {
    id: 'blog',
    name: 'Technology Blog',
    color: '#e83e8c',
    accent: '#ffd6e8',
    role: 'Технологический блог и контент',
    district: 'Останкино',
    kind: 'blog',
    tier: 'dept',
    x: 845,
    y: 150,
    links: [],
    responsibilities: [
      'Посты и статьи о технологиях',
      'Сценарии для видео и рилсов',
      'Контент-план и аналитика охватов',
    ],
  },
  // ── 8-Е НАПРАВЛЕНИЕ: свободный слот. Чтобы занять его, поменяй name / role /
  //    responsibilities / kind и поставь vacant: false. Либо пришли
  //    POST /api/status с agent: "slot8" и полем name — слот займётся сам.
  {
    id: 'slot8',
    name: 'Свободное направление',
    color: '#8a8f9c',
    accent: '#e5e7eb',
    role: 'Назови направление — и здесь появится агент',
    district: 'Сокольники',
    kind: 'vacant',
    tier: 'dept',
    vacant: true,
    x: 1160,
    y: 300,
    links: [],
    responsibilities: ['Пока пусто: придумай, за что будет отвечать восьмой агент'],
  },
  // ── Союзники (необязательные): уже существующие боты пользователя.
  {
    id: 'lang',
    name: 'Language Coach',
    color: '#f59e0b',
    accent: '#fff',
    role: 'Репетитор английского',
    district: 'МГУ · Воробьёвы горы',
    kind: 'lang',
    tier: 'extra',
    x: 420,
    y: 905,
    links: [],
    responsibilities: ['Уроки и практика английского', 'Проверка текстов'],
  },
  {
    id: 'biz',
    name: 'Business Adviser',
    color: '#14b8a6',
    accent: '#fff',
    role: 'Бизнес-идеи и аналитика',
    district: 'Сколково',
    kind: 'biz',
    tier: 'extra',
    x: 150,
    y: 640,
    links: [],
    responsibilities: ['Бизнес-идеи и их проверка', 'Финансовые расчёты'],
  },
];

// Свободные участки на окраинах для агентов, созданных на лету через /api/status.
const EXTRA_SLOTS = [
  { x: 1390, y: 470 },
  { x: 1330, y: 880 },
  { x: 260, y: 230 },
  { x: 1400, y: 160 },
  { x: 700, y: 990 },
  { x: 160, y: 960 },
];

function seedAgent(base) {
  return {
    ...base,
    status: 'idle',
    now: base.vacant ? 'Ждёт названия' : 'Жду задач',
    done: [],
    completed: 0,
    responsibilities: (base.responsibilities || []).slice(),
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
      district: a.district || '',
      kind: a.kind || 'generic',
      tier: a.tier || 'dept',
      vacant: !!a.vacant,
      completed: a.completed || 0,
      responsibilities: (a.responsibilities || []).slice(),
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

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().slice(0, 300))
    .slice(0, 12);
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
  if (agent.vacant) {
    return res.status(400).json({ error: 'Это свободное направление: сначала дай ему название' });
  }
  if (text.length > 4000) {
    return res.status(400).json({ error: 'Слишком длинная задача (максимум 4000 символов)' });
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
      district: typeof body.district === 'string' && body.district.trim() ? body.district.trim() : 'Окраина',
      kind: typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'generic',
      tier: 'dept',
      x: slot.x,
      y: slot.y,
      links: [],
      status: 'idle',
      now: 'Жду задач',
      done: [],
      completed: 0,
      responsibilities: cleanList(body.responsibilities),
    };
    state.agents.push(agent);
    const main = findAgent('grok');
    if (main && !main.links.includes(agent.id)) main.links.push(agent.id);
  } else {
    if (typeof body.name === 'string' && body.name.trim()) agent.name = body.name.trim();
    if (typeof body.color === 'string' && body.color.trim()) agent.color = body.color.trim();
    if (typeof body.accent === 'string' && body.accent.trim()) agent.accent = body.accent.trim();
    if (typeof body.role === 'string' && body.role.trim()) agent.role = body.role.trim();
    if (typeof body.district === 'string' && body.district.trim()) agent.district = body.district.trim();
    if (typeof body.kind === 'string' && body.kind.trim()) agent.kind = body.kind.trim();
    if (Array.isArray(body.responsibilities)) agent.responsibilities = cleanList(body.responsibilities);
    // Свободный слот занимается, как только агенту дают имя.
    if (agent.vacant && typeof body.name === 'string' && body.name.trim()) {
      agent.vacant = false;
      if (agent.kind === 'vacant') agent.kind = 'generic';
      if (agent.now === 'Ждёт названия') agent.now = 'Жду задач';
    }
  }

  if (body.status) agent.status = body.status;
  if (typeof body.now === 'string') agent.now = body.now;

  if (typeof body.done === 'string' && body.done.trim()) {
    agent.done.unshift(body.done.trim());
    if (agent.done.length > 10) agent.done.length = 10;
  }

  let countedCompletion = false;
  if (body.taskId && typeof body.result === 'string') {
    const task = state.tasks.find((t) => t.id === body.taskId);
    if (task) {
      if (task.status !== 'выполнена') {
        const owner = findAgent(task.agent) || agent;
        owner.completed = (owner.completed || 0) + 1;
        countedCompletion = true;
      }
      task.result = body.result;
      task.status = 'выполнена';
    }
  }
  if (!countedCompletion && typeof body.done === 'string' && body.done.trim() && !body.taskId) {
    agent.completed = (agent.completed || 0) + 1;
  }

  res.json({
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      now: agent.now,
      done: agent.done.slice(),
      completed: agent.completed || 0,
      vacant: !!agent.vacant,
    },
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Агенты Москвы (GROK) слушают 0.0.0.0:${PORT}`);
  });
}

module.exports = { app, state };
