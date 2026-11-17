'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const GROK_WEBHOOK_URL = process.env.GROK_WEBHOOK_URL || '';
const GROK_WEBHOOK_KEY = process.env.GROK_WEBHOOK_KEY || '';
const GROK_WEBHOOK_HEADER = process.env.GROK_WEBHOOK_HEADER || 'Authorization';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Вложения лежат на диске процесса, метаданные — в памяти вместе с задачами.
// На бесплатном Render диск эфемерный: файлы пропадают вместе с перезапуском,
// засыпанием и новым деплоем, как и журнал задач. Платное хранилище не используется.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_MESSAGES_PER_AGENT = 200;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  messages: [],
  files: new Map(),
  nextTaskId: 1,
  nextMessageId: 1,
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
    tasks: state.tasks.slice(0, 100).map(publicTask),
    messages: messagesForState(),
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

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.expose = error;
  return err;
}

function absoluteUrl(urlPath) {
  if (!urlPath) return '';
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  const base = String(PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) return urlPath;
  return base + (urlPath.startsWith('/') ? urlPath : `/${urlPath}`);
}

function publicAttachment(rec) {
  return {
    id: rec.id || null,
    name: rec.name,
    mime: rec.mime || '',
    size: rec.size ?? null,
    url: rec.url,
  };
}

function publicTask(t) {
  return {
    id: t.id,
    agent: t.agent,
    text: t.text,
    status: t.status,
    createdAt: t.createdAt,
    forwardStatus: t.forwardStatus,
    result: t.result ?? null,
    messageId: t.messageId || null,
    attachments: (t.attachments || []).map(publicAttachment),
  };
}

function cmpMsg(a, b) {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function publicMessage(m) {
  return {
    id: m.id,
    agentId: m.agentId,
    role: m.role,
    text: m.text,
    attachments: (m.attachments || []).map(publicAttachment),
    timestamp: m.createdAt,
    createdAt: m.createdAt,
    source: m.source,
    taskId: m.taskId || null,
  };
}

function messagesForState() {
  const byAgent = new Map();
  const sorted = [...state.messages].sort(cmpMsg);
  for (const m of sorted) {
    if (!byAgent.has(m.agentId)) byAgent.set(m.agentId, []);
    byAgent.get(m.agentId).push(m);
  }
  const out = [];
  for (const list of byAgent.values()) {
    for (const m of list.slice(-80)) out.push(publicMessage(m));
  }
  out.sort(cmpMsg);
  return out;
}

function decodeOriginalName(name) {
  const raw = String(name || 'file').replace(/[/\\]/g, '_').replace(/[\r\n"]/g, '').slice(0, 180) || 'file';
  if (/[^\u0000-\u00ff]/.test(raw)) return raw;
  const utf = Buffer.from(raw, 'latin1').toString('utf8');
  if (utf.includes('\uFFFD')) return raw;
  return utf.replace(/[\r\n"]/g, '').slice(0, 180) || 'file';
}

function discardUploads(files) {
  for (const file of files || []) {
    if (file && file.path) {
      try { fs.unlinkSync(file.path); } catch (_) { /* уже удалён */ }
    }
  }
}

function storeIncomingFiles(files) {
  return (files || []).map((file) => {
    const id = file.filename;
    const rec = {
      id,
      name: decodeOriginalName(file.originalname),
      mime: file.mimetype || 'application/octet-stream',
      size: file.size,
      storedName: file.filename,
      createdAtMs: Date.now(),
      url: `/api/files/${id}`,
    };
    state.files.set(id, rec);
    return publicAttachment(rec);
  });
}

function releaseUnusedFiles() {
  const used = new Set();
  for (const t of state.tasks) for (const a of t.attachments || []) if (a.id) used.add(a.id);
  for (const m of state.messages) for (const a of m.attachments || []) if (a.id) used.add(a.id);
  const now = Date.now();
  for (const [id, rec] of state.files) {
    if (used.has(id)) continue;
    if (now - rec.createdAtMs < 30 * 60 * 1000) continue;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, rec.storedName)); } catch (_) { /* нет файла */ }
    state.files.delete(id);
  }
}

function parseIdList(value) {
  if (value == null || value === '') return [];
  let list = value;
  if (typeof list === 'string') {
    const trimmed = list.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try { list = JSON.parse(trimmed); } catch (_) { throw httpError(400, 'attachmentIds должен быть массивом'); }
    } else {
      list = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) throw httpError(400, 'attachmentIds должен быть массивом');
  return list.map((id) => {
    const s = String(id || '').trim();
    if (!/^[a-f0-9]{32}$/.test(s) || !state.files.has(s)) throw httpError(400, 'Неизвестное вложение');
    return s;
  });
}

function collectTaskAttachments(req) {
  const uploadedFiles = req.files || [];
  let ids = [];
  try {
    ids = parseIdList(req.body?.attachmentIds);
  } catch (err) {
    discardUploads(uploadedFiles);
    throw err;
  }
  if (uploadedFiles.length + ids.length > MAX_FILES) {
    discardUploads(uploadedFiles);
    throw httpError(400, `Слишком много вложений (максимум ${MAX_FILES})`);
  }
  const uploaded = storeIncomingFiles(uploadedFiles);
  const referenced = ids.map((id) => publicAttachment(state.files.get(id)));
  return [...referenced, ...uploaded];
}

function isSafeAttachmentUrl(url) {
  if (typeof url !== 'string') return false;
  if (/^\/api\/files\/[a-f0-9]{32}$/.test(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeAttachmentList(value) {
  if (value == null || value === '') return [];
  let list = value;
  if (typeof list === 'string') {
    const trimmed = list.trim();
    if (!trimmed) return [];
    try { list = JSON.parse(trimmed); } catch (_) { throw httpError(400, 'attachments должен быть массивом'); }
  }
  if (!Array.isArray(list)) throw httpError(400, 'attachments должен быть массивом');
  if (list.length > MAX_FILES) throw httpError(400, `Слишком много вложений (максимум ${MAX_FILES})`);
  return list.map((item) => {
    if (!item || typeof item !== 'object') throw httpError(400, 'Некорректное вложение');
    if (item.id) {
      const rec = state.files.get(String(item.id));
      if (!rec) throw httpError(400, 'Неизвестное вложение');
      return publicAttachment(rec);
    }
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!isSafeAttachmentUrl(url)) throw httpError(400, 'У вложения нужна ссылка http(s) или id загруженного файла');
    const name = String(item.name || 'файл').replace(/[\r\n"]/g, '').slice(0, 200) || 'файл';
    const mime = typeof item.mime === 'string' ? item.mime.slice(0, 120) : '';
    const size = Number.isFinite(Number(item.size)) ? Number(item.size) : null;
    return { id: null, name, mime, size, url };
  });
}

function cleanMessageId(id) {
  if (id == null || id === '') return '';
  const s = String(id).trim();
  if (!/^[A-Za-z0-9:._-]{1,80}$/.test(s)) throw httpError(400, 'Некорректный id сообщения');
  return s;
}

function trimMessages(agentId) {
  const list = state.messages.filter((m) => m.agentId === agentId).sort(cmpMsg);
  if (list.length <= MAX_MESSAGES_PER_AGENT) return;
  const drop = new Set(list.slice(0, list.length - MAX_MESSAGES_PER_AGENT).map((m) => m.id));
  state.messages = state.messages.filter((m) => !drop.has(m.id));
}

function addMessage(input) {
  if (input.id) {
    const existing = state.messages.find((m) => m.id === input.id);
    if (existing) {
      if (input.source === 'status' && input.text && existing.text !== input.text) {
        existing.text = input.text;
        existing.createdAt = input.createdAt || existing.createdAt;
      }
      return { message: publicMessage(existing), duplicate: true };
    }
  }
  if (input.taskId && input.role === 'agent' && input.text) {
    const same = state.messages.find((m) => m.agentId === input.agentId && m.taskId === input.taskId && m.role === 'agent' && m.text === input.text);
    if (same) return { message: publicMessage(same), duplicate: true };
  }
  const message = {
    id: input.id || `m-${state.nextMessageId++}`,
    agentId: input.agentId,
    role: input.role,
    text: input.text || '',
    attachments: input.attachments || [],
    createdAt: input.createdAt || new Date().toISOString(),
    source: input.source || 'relay',
    taskId: input.taskId || null,
  };
  state.messages.push(message);
  trimMessages(message.agentId);
  return { message: publicMessage(message), duplicate: false };
}

function textForAgent(text, attachments) {
  if (!attachments || !attachments.length) return text;
  const lines = attachments.map((a) => `- ${a.name}: ${a.url}`);
  const head = text ? text : '(без текста)';
  return `${head}\n\nВложения:\n${lines.join('\n')}`;
}

function readTimestamp(body) {
  const raw = body.timestamp != null && body.timestamp !== '' ? body.timestamp : body.createdAt;
  if (raw == null || raw === '') return new Date().toISOString();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw httpError(400, 'Некорректный timestamp');
  if (t > Date.now() + 864e5) throw httpError(400, 'timestamp слишком далеко в будущем');
  return new Date(t).toISOString();
}

function prepareRelayMessage(body, uploaded) {
  body = body || {};
  const earlyId = body.id != null && body.id !== '' ? cleanMessageId(body.id) : '';
  if (earlyId) {
    const existing = state.messages.find((m) => m.id === earlyId);
    if (existing) return { message: publicMessage(existing), duplicate: true };
  }
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : (typeof body.agent === 'string' ? body.agent.trim() : '');
  if (!agentId) throw httpError(400, 'Нужен agentId');
  const agent = findAgent(agentId);
  if (!agent) throw httpError(400, 'Неизвестный агент');
  if (agent.vacant) throw httpError(400, 'Это свободное направление: сначала дай ему название');
  const role = typeof body.role === 'string' ? body.role.trim() : '';
  if (role !== 'owner' && role !== 'agent') throw httpError(400, 'role должен быть owner или agent');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > 20000) throw httpError(400, 'Слишком длинное сообщение (максимум 20000 символов)');
  const attachments = [...normalizeAttachmentList(body.attachments), ...(uploaded || [])];
  if (attachments.length > MAX_FILES) throw httpError(400, `Слишком много вложений (максимум ${MAX_FILES})`);
  if (!text && attachments.length === 0) throw httpError(400, 'Нужен text или вложения');
  const taskId = typeof body.taskId === 'string' && body.taskId.trim() ? body.taskId.trim().slice(0, 64) : null;
  return {
    duplicate: false,
    input: {
      id: earlyId || undefined,
      agentId,
      role,
      text,
      attachments,
      createdAt: readTimestamp(body),
      source: 'relay',
      taskId,
    },
  };
}

function ownerMessagesSince(agentId, since) {
  const owned = state.messages
    .filter((m) => m.agentId === agentId && m.role === 'owner' && m.source === 'app')
    .sort(cmpMsg);
  if (!since) return { messages: owned };
  const byId = state.messages.find((m) => m.id === since);
  if (byId) return { messages: owned.filter((m) => cmpMsg(byId, m) < 0) };
  const time = Date.parse(since);
  if (Number.isNaN(time)) return { error: 'since должен быть id сообщения или timestamp ISO' };
  return { messages: owned.filter((m) => Date.parse(m.createdAt) > time) };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});

function uploadArray(req, res, next) {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл больше 10 МБ' });
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: `Слишком много файлов (максимум ${MAX_FILES})` });
      }
    }
    return res.status(400).json({ error: 'Не удалось принять файл' });
  });
}

function maybeUpload(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) return uploadArray(req, res, next);
  return next();
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

function requireUserOrAgent(req, res, next) {
  const pw = req.get('x-app-password') || '';
  const tok = req.get('x-agent-token') || '';
  if (APP_PASSWORD && safeEqual(pw, APP_PASSWORD)) return next();
  if (AGENT_TOKEN && safeEqual(tok, AGENT_TOKEN)) return next();
  if (!APP_PASSWORD && !AGENT_TOKEN) return res.status(503).json({ error: 'Доступ не настроен' });
  return res.status(401).json({ error: 'Нужен пароль доступа или токен агента' });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/api/state', (_req, res) => {
  res.json(publicState());
});

app.post('/api/task', requireAppPassword, maybeUpload, async (req, res) => {
  const agentId = typeof req.body?.agent === 'string' ? req.body.agent.trim() : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!agentId) {
    discardUploads(req.files);
    return res.status(400).json({ error: 'Нужны поля agent и text' });
  }
  const agent = findAgent(agentId);
  if (!agent) {
    discardUploads(req.files);
    return res.status(400).json({ error: 'Неизвестный агент' });
  }
  if (agent.vacant) {
    discardUploads(req.files);
    return res.status(400).json({ error: 'Это свободное направление: сначала дай ему название' });
  }
  if (text.length > 4000) {
    discardUploads(req.files);
    return res.status(400).json({ error: 'Слишком длинная задача (максимум 4000 символов)' });
  }

  let attachments;
  try {
    attachments = collectTaskAttachments(req);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.expose || 'Некорректные вложения' });
  }
  if (!text && attachments.length === 0) {
    return res.status(400).json({ error: 'Нужны поля agent и text' });
  }

  const task = {
    id: `t-${state.nextTaskId++}`,
    agent: agentId,
    text,
    status: GROK_WEBHOOK_URL ? 'отправлена' : 'не отправлена: вебхук не настроен',
    createdAt: new Date().toISOString(),
    forwardStatus: null,
    result: null,
    attachments,
    messageId: '',
  };
  task.messageId = `task:${task.id}`;

  addMessage({
    id: task.messageId,
    agentId,
    role: 'owner',
    text,
    attachments,
    createdAt: task.createdAt,
    source: 'app',
    taskId: task.id,
  });

  agent.status = 'working';
  agent.now = text || `Файлы: ${attachments.map((a) => a.name).join(', ')}`.slice(0, 300);
  pushTask(task);
  releaseUnusedFiles();

  const forwardedAttachments = attachments.map((a) => ({
    name: a.name,
    mime: a.mime,
    size: a.size,
    url: absoluteUrl(a.url),
  }));
  const payload = {
    agent: agentId,
    text: textForAgent(text, forwardedAttachments),
    taskId: task.id,
    messageId: task.messageId,
    appUrl: PUBLIC_URL,
  };
  if (forwardedAttachments.length) payload.attachments = forwardedAttachments;

  if (GROK_WEBHOOK_URL) {
    try {
      const response = await fetch(GROK_WEBHOOK_URL, {
        method: 'POST',
        headers: webhookHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      task.forwardStatus = response.status;
    } catch (err) {
      task.forwardStatus = 0;
      task.forwardError = err && err.name === 'TimeoutError' ? 'timeout' : 'network_error';
    }
  }

  res.status(201).json(publicTask(task));
});

app.post('/api/upload', requireUserOrAgent, uploadArray, (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл в поле files' });
  const attachments = storeIncomingFiles(files);
  res.status(201).json({ attachments });
});

app.get('/api/files/:id', (req, res) => {
  const id = String(req.params.id || '');
  const rec = /^[a-f0-9]{32}$/.test(id) ? state.files.get(id) : null;
  if (!rec) return res.status(404).json({ error: 'Файл не найден' });
  const root = path.resolve(UPLOAD_DIR);
  const resolved = path.resolve(root, rec.storedName);
  if (path.dirname(resolved) !== root || !fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  const inline = INLINE_MIME.has(rec.mime);
  const encoded = encodeURIComponent(rec.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encoded}`);
  res.type(inline ? rec.mime : 'application/octet-stream');
  res.sendFile(resolved);
});

app.get('/api/messages', requireAgentToken, (req, res) => {
  const agentId = String(req.query.agentId || req.query.agent || '').trim();
  if (!agentId) return res.status(400).json({ error: 'Нужен agentId' });
  if (!findAgent(agentId)) return res.status(400).json({ error: 'Неизвестный агент' });
  const since = req.query.since != null ? String(req.query.since) : '';
  const selected = ownerMessagesSince(agentId, since);
  if (selected.error) return res.status(400).json({ error: selected.error });
  const page = selected.messages.slice(0, 100);
  const last = page[page.length - 1];
  res.json({
    agentId,
    messages: page.map(publicMessage),
    cursor: last ? last.id : (since || null),
    timestamp: last ? last.createdAt : (since || null),
  });
});

function forgetUploads(files) {
  for (const file of files || []) {
    if (file && file.filename) state.files.delete(file.filename);
    if (file && file.path) {
      try { fs.unlinkSync(file.path); } catch (_) { /* уже удалён */ }
    }
  }
}

app.post('/api/messages', requireAgentToken, maybeUpload, (req, res) => {
  try {
    if (Array.isArray(req.body?.messages)) {
      if (req.files && req.files.length) {
        discardUploads(req.files);
        return res.status(400).json({ error: 'Пакет messages не сочетается с загрузкой файлов. Сначала POST /api/upload.' });
      }
      if (req.body.messages.length > 20) return res.status(400).json({ error: 'Слишком много сообщений за раз (максимум 20)' });
      const prepared = req.body.messages.map((item) => prepareRelayMessage(item, []));
      const results = prepared.map((item) => (item.duplicate ? item : addMessage(item.input)));
      const created = results.some((r) => !r.duplicate);
      releaseUnusedFiles();
      return res.status(created ? 201 : 200).json({ ok: true, results });
    }
    const body = req.body || {};
    const earlyId = body.id != null && body.id !== '' ? cleanMessageId(body.id) : '';
    if (earlyId) {
      const existing = state.messages.find((m) => m.id === earlyId);
      if (existing) {
        discardUploads(req.files);
        return res.status(200).json({ ok: true, duplicate: true, message: publicMessage(existing) });
      }
    }
    const uploaded = storeIncomingFiles(req.files || []);
    const prepared = prepareRelayMessage(body, uploaded);
    const result = prepared.duplicate ? prepared : addMessage(prepared.input);
    releaseUnusedFiles();
    return res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate, message: result.message });
  } catch (err) {
    forgetUploads(req.files);
    const status = err.status || 500;
    if (!err.status) console.error(err);
    return res.status(status).json({ error: err.expose || 'Не удалось сохранить сообщение' });
  }
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
      if (body.result.trim()) {
        addMessage({
          id: `result:${task.id}`,
          agentId: task.agent,
          role: 'agent',
          text: body.result.trim(),
          attachments: [],
          createdAt: new Date().toISOString(),
          source: 'status',
          taskId: task.id,
        });
      }
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
