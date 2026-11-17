'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const store = require('./lib/store');
const { activityFor, activeWindowMs } = require('./lib/activity');
const { deliveryCaption } = require('./public/js/feed');
const { registerHeartbeat } = require('./lib/heartbeat');
const { createPoryadokSync } = require('./lib/poryadok-sync');
const { senderName } = require('./public/js/sender-label');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// GROK_WEBHOOK_* больше не маршрут. Значения не читаем в запросы и не пишем в лог.
function noteIgnoredGrokWebhook() {
  const names = ['GROK_WEBHOOK_URL', 'GROK_WEBHOOK_KEY', 'GROK_WEBHOOK_HEADER'];
  const present = names.some((name) => String(process.env[name] || '').trim() !== '');
  if (present) console.log('GROK_WEBHOOK_URL больше не используется');
}
noteIgnoredGrokWebhook();

// Приказы, переписка, «Нужно от вас», очередь вебхука и байты вложений пишет lib/store.js в Postgres,
// если DATABASE_URL задан и база доступна при старте. Иначе всё остаётся в памяти,
// а файлы — в UPLOAD_DIR. Лимиты загрузки те же: 10 МБ и 5 файлов.
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
// kind — тип фигурки на клиенте: putin, army, poker, trading, devops, dev, qa,
//        temshik, blog, finance, invest, analyst, lang, biz, advisor, social,
//        routines, vacant, generic.
// tier — main (Путин), dept (направление), sub (помощник, parentId), extra (союзник).
// Номер на карте — среди видимых агентов, без пропусков. Помощники Финансов: 7.1, 7.2.
// trading, biz и lang в архиве: записи остаются, на карту и в новые приказы не попадают.
// grokAgentId — id агента в Grok. Для посевного агента это поле карточки из кода:
// после рестарта оно не берётся из payload в agent_state. У finance и помощников
// invest (7.1) и analyst (7.2) один и тот же id.
// ─────────────────────────────────────────────────────────────────────────────
const SEED_AGENTS = [
  {
    id: 'grok',
    name: 'Путин',
    color: '#c8102e',
    accent: '#f5c451',
    role: 'Главнокомандующий агентами',
    district: 'Кремль',
    kind: 'putin',
    tier: 'main',
    grokAgentId: '8b9d4ad0-4222-49a8-84b4-b125d3b7ec01',
    x: 800,
    y: 540,
    links: ['army', 'poker', 'devops', 'dev', 'qa', 'temshik', 'blog', 'finance', 'advisor', 'social', 'routines'],
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
    grokAgentId: 'b174ea11-d3ab-4ad7-ab65-8feacca27cf4',
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
    grokAgentId: 'e15adfa3-6299-4980-a224-1b7adea71c45',
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
    archived: true,
    grokAgentId: '504035c8-ccd8-467b-9e34-f16305493533',
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
    grokAgentId: 'd2ed048e-12e7-4b0e-b42c-36225ed71745',
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
    grokAgentId: '8117cf6a-c57d-42cc-ba6f-2421fe7af6ad',
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
    grokAgentId: '6a1deccc-2411-4fd1-8da7-e7ba9fce6df2',
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
    order: 9,
    grokAgentId: '118a97ac-2030-4f25-b684-ac19252fb4aa',
    x: 845,
    y: 150,
    links: [],
    responsibilities: [
      'Посты и статьи о технологиях',
      'Сценарии для видео и рилсов',
      'Контент-план и аналитика охватов',
    ],
  },
  // ── 7-е направление: Финансы, Китай-город (Ильинка, квартал банков и казны).
  {
    id: 'finance',
    name: 'Финансы',
    color: '#1a3a5c',
    accent: '#f5c451',
    role: 'Казна, бюджет и денежные решения',
    district: 'Китай-город · Ильинка',
    kind: 'finance',
    tier: 'dept',
    order: 7,
    grokAgentId: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
    x: 1080,
    y: 340,
    links: ['invest', 'analyst'],
    responsibilities: [
      'Бюджет, касса и платежи',
      'Сводит цифры направлений в одну картину',
      'Ставит задачи помощникам: инвестициям и аналитике',
    ],
  },
  {
    id: 'invest',
    name: 'Инвестиции',
    parentId: 'finance',
    color: '#c6a15a',
    accent: '#fff6d8',
    role: 'Портфель, рынки и долгие вложения',
    district: 'Китай-город · Ильинка',
    kind: 'invest',
    tier: 'sub',
    grokAgentId: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
    x: 1190,
    y: 270,
    links: [],
    responsibilities: [
      'Ищет, куда положить деньги',
      'Следит за рынком и рисками портфеля',
      'Готовит короткие инвестиционные записки',
    ],
  },
  {
    id: 'analyst',
    name: 'Бизнес-аналитик',
    parentId: 'finance',
    color: '#2f6b4f',
    accent: '#e7f6ec',
    role: 'Отчёты, юнит-экономика и модели',
    district: 'Китай-город · Ильинка',
    kind: 'analyst',
    tier: 'sub',
    grokAgentId: 'e5b4d1ad-52aa-4a3a-aa8e-ddd6dc1ac8f1',
    x: 980,
    y: 450,
    links: [],
    responsibilities: [
      'Считает юнит-экономику и сценарии',
      'Собирает отчёты для Финансов',
      'Проверяет, сходятся ли цифры в планах',
    ],
  },
  // ── 8-е направление: тестировщик. Id не менялись.
  {
    id: 'qa',
    name: 'Тестировщик ПО',
    color: '#0284c7',
    accent: '#e0f2fe',
    role: 'Проверка программ и регрессии',
    district: 'Лефортово',
    kind: 'qa',
    tier: 'dept',
    order: 8,
    grokAgentId: '892a92c9-8133-48d2-b22d-c77e653309af',
    x: 1304,
    y: 512,
    links: [],
    responsibilities: [
      'Проверяет, что новые правки не ломают старое',
      'Гоняет сценарии и смотрит краевые случаи',
      'Коротко сообщает, что сломалось и что уже проверено',
    ],
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
    archived: true,
    grokAgentId: '5f09e2b6-ec92-44ef-bcbd-b1f848daed18',
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
    archived: true,
    grokAgentId: 'a64c9436-36bc-4122-af1b-89d56950b0c1',
    x: 150,
    y: 640,
    links: [],
    responsibilities: ['Бизнес-идеи и их проверка', 'Финансовые расчёты'],
  },
  // Номер 10 — слот Language Coach. Без parentId советник получает целый номер
  // и в иерархии висит прямо на Путине, как остальные направления, а не как 1.1.
  {
    id: 'advisor',
    name: 'Советник Путина',
    color: '#7c2d3a',
    accent: '#f5c451',
    role: 'Стратегический советник Путина',
    district: 'Кремль',
    kind: 'advisor',
    tier: 'dept',
    order: 10,
    grokAgentId: '961b2d3d-5f80-4891-b87a-c6913bbf2971',
    x: 910,
    y: 400,
    links: [],
    responsibilities: [
      'Готовит стратегические записки для Путина',
      'Сводит позиции направлений в один совет',
      'Следит за рисками крупных решений',
    ],
  },
  // Порядок среди видимых: после Советника (10) идут 11 и 12.
  {
    id: 'social',
    name: 'Соцсети',
    color: '#c026d3',
    accent: '#fae8ff',
    role: 'Instagram, YouTube и охваты',
    district: 'ВДНХ',
    kind: 'social',
    tier: 'dept',
    order: 11,
    grokAgentId: 'a1bd53f2-5655-446b-8207-393e61fc20e1',
    x: 1160,
    y: 100,
    links: [],
    responsibilities: [
      'Ведёт Instagram и YouTube',
      'Публикует посты, сторис и ролики',
      'Следит за охватами и комментариями',
    ],
  },
  {
    id: 'routines',
    name: 'Рутины · Кремль',
    color: '#9a3412',
    accent: '#ffedd5',
    role: 'Советник по рутинам и автоматизации, обучает владельца',
    district: 'Хамовники',
    kind: 'routines',
    tier: 'dept',
    order: 12,
    grokAgentId: 'd6b45571-e211-4218-a1e2-1c0918973ddc',
    x: 360,
    y: 630,
    links: [],
    responsibilities: [
      'Учит владельца собирать и запускать рутины',
      'Автоматизирует повторяющиеся действия штаба',
      'Следит, чтобы рутины совпадали с приказами',
    ],
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
    parentId: base.parentId || null,
    archived: !!base.archived,
    status: 'idle',
    now: base.vacant ? 'Ждёт названия' : 'Жду задач',
    done: [],
    completed: 0,
    responsibilities: (base.responsibilities || []).slice(),
    links: (base.links || []).slice(),
  };
}

// Номера видимых направлений и союзников идут по порядку, без архивных.
// Помощники получают 7.1, 7.2 по порядку среди видимых детей одного родителя.
function prepareRoster(list) {
  let top = 0;
  const sib = {};
  const agents = list.map((base) => {
    const agent = seedAgent(base);
    if (agent.parentId) {
      agent.tier = 'sub';
      if (!agent.archived) {
        sib[agent.parentId] = (sib[agent.parentId] || 0) + 1;
        agent.order = agent.order || sib[agent.parentId];
      }
    } else if (!agent.archived) {
      top += 1;
      agent.order = agent.order || top;
    }
    return agent;
  });
  for (const agent of agents) {
    if (!agent.parentId) continue;
    const parent = agents.find((a) => a.id === agent.parentId);
    if (parent && !parent.links.includes(agent.id)) parent.links.push(agent.id);
  }
  return agents;
}

function visibleRoster(list) {
  return list.filter((a) => !a.archived);
}

function agentNumber(agent) {
  if (!agent || agent.archived) return '';
  if (agent.parentId) {
    const parent = findAgent(agent.parentId);
    const parentNum = parent && !parent.archived ? agentNumber(parent) : '?';
    const siblings = visibleRoster(state.agents)
      .filter((a) => a.parentId === agent.parentId)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
    const idx = siblings.findIndex((a) => a.id === agent.id);
    return `${parentNum}.${idx >= 0 ? idx + 1 : 1}`;
  }
  const tops = visibleRoster(state.agents)
    .filter((a) => !a.parentId)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
  const idx = tops.findIndex((a) => a.id === agent.id);
  return idx >= 0 ? String(idx + 1) : '';
}

function slotNear(parent) {
  const n = state.agents.filter((a) => a.parentId === parent.id && !a.archived).length;
  const angle = -0.9 + n * 1.15;
  return {
    x: Math.round(Math.max(40, Math.min(1560, parent.x + Math.cos(angle) * 120))),
    y: Math.round(Math.max(40, Math.min(1060, parent.y + Math.sin(angle) * 90))),
  };
}

const state = {
  agents: prepareRoster(SEED_AGENTS),
  tasks: [],
  messages: [],
  files: new Map(),
  needs: [],
  routines: [],
  outbox: [],
  nextTaskId: 1,
  nextMessageId: 1,
  nextNeedId: 1,
  nextRoutineId: 1,
  nextOutboxId: 1,
  migrations: { financeTextReopen: false },
};

const NEED_URGENCY = new Set(['low', 'normal', 'high']);
const RENDER_NEED_ID = 'need-render-api';
const ACADEMY_NEED_ID = 'need-academy';
const ACADEMY_WHAT = 'Одобрить Академию агентов: нажать «Да» в чатах Программирования и Тестировщика';
const ACADEMY_WHERE = 'Чаты агентов в Grok';
const TEST_NEED_ID = 'need-test-qa';
const TEST_NEED_WHAT = 'ТЕСТ: пройдите кнопки «Да» и «Нет» на странице вопроса';
const QUESTION_NEED_ID = 'need-test-question';
const QUESTION_NEED_WHAT = 'ТЕСТ: вопрос с ответом текстом';
const TEST_REOPEN_MS = 5 * 60 * 1000;
const ANSWERS_MAX = 20;
const NEED_KINDS = new Set(['money', 'outside_message', 'delete', 'publish', 'secret', 'approval', 'test']);
const FINANCE_NEED_ID = 'need-finance';
const FINANCE_WHERE = 'Чат Путина или Финансов';
const ACTION_URL_MAX = 500;
const ACTION_LABEL_MAX = 80;
const ACTION_HINT_MAX = 300;
const DETAILS_MAX = 20000;
const ANSWER_MAX = 5000;
const ACADEMY_ACTION_URL = 'https://cursor.com/canvas/store-497a06f4-8b81-4283-89e8-143a1091624a/21c8dde0-0aef-4ddb-8526-a5ca03e7f3e2';
const FINANCE_ACTION_URL = 'grokbot://app/v1/agent?id=8b9d4ad0-4222-49a8-84b4-b125d3b7ec01';
const FINANCE_ACTION_HINT = 'Откройте в Grok чат «Путин · Кремль»';
const SOCIAL_ACTION_URL = 'grokbot://app/v1/agent?id=a1bd53f2-5655-446b-8207-393e61fc20e1';
const SOCIAL_ACTION_HINT = 'Откройте в Grok чат «Соцсети · Кремль»';
const NEEDS_RESOLVE_MS = 3 * 60 * 1000;

function needAuthor(id) {
  const agent = findAgent(id);
  if (!agent || agent.archived) return 'grok';
  return agent.id;
}

function needSeeds() {
  return [
    {
      id: 'need-social',
      what: 'Войти в Instagram и YouTube для агента Соцсети',
      fromAgentId: needAuthor('social'),
      where: 'Instagram и YouTube',
      urgency: 'normal',
      kind: 'outside_message',
      docUrl: SOCIAL_ACTION_URL,
      actionLabel: null,
      actionHint: SOCIAL_ACTION_HINT,
    },
    {
      id: FINANCE_NEED_ID,
      what: 'Ответить на шесть финансовых вопросов',
      fromAgentId: needAuthor('finance'),
      where: FINANCE_WHERE,
      urgency: 'normal',
      kind: 'money',
      docUrl: FINANCE_ACTION_URL,
      actionLabel: null,
      actionHint: FINANCE_ACTION_HINT,
    },
    {
      id: TEST_NEED_ID,
      what: TEST_NEED_WHAT,
      fromAgentId: needAuthor('qa'),
      where: 'Страница вопроса',
      urgency: 'low',
      kind: 'test',
      answerable: true,
      answerMode: 'yesno',
      docUrl: null,
      actionLabel: null,
      actionHint: null,
    },
    {
      id: QUESTION_NEED_ID,
      what: QUESTION_NEED_WHAT,
      fromAgentId: needAuthor('qa'),
      where: 'Страница вопроса',
      urgency: 'low',
      kind: 'test',
      answerable: true,
      answerMode: 'text',
      docUrl: null,
      actionLabel: null,
      actionHint: null,
    },
  ];
}

// Часы без подтверждения, после которых открытый пункт «требует проверки».
// Читается при каждом запросе, чтобы тесты могли подменить NEEDS_STALE_HOURS.
function staleHours() {
  const raw = process.env.NEEDS_STALE_HOURS;
  if (raw == null || raw === '') return 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 24;
  return n;
}

function isNeedStale(item, now = Date.now(), hours = staleHours()) {
  if (!item || item.closedAt) return false;
  const checked = Date.parse(item.checkedAt || item.createdAt || '');
  if (Number.isNaN(checked)) return false;
  return now - checked > Number(hours) * 60 * 60 * 1000;
}

// Закрывает открытые пункты, у которых переменная resolvesWhenEnv уже непустая.
// В ответ и в логи попадает только имя переменной, не её значение.
function resolveNeedsByEnv(env = process.env, now = new Date().toISOString()) {
  let closed = 0;
  for (const item of state.needs) {
    if (!item || item.closedAt) continue;
    const name = item.resolvesWhenEnv;
    if (!name || typeof name !== 'string') continue;
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    item.closedAt = now;
    item.closedBy = 'auto-env';
    item.updatedAt = now;
    closed += 1;
    if (!isTestNeedItem(item)) {
      void deliverNeedEvent({ item, type: 'close', text: needCloseText(item) }).catch(() => {
        console.error('Не удалось поставить закрытие в очередь');
      });
    }
  }
  return closed;
}

function seedParticipantList(seed) {
  if (!seed || !Array.isArray(seed.participants)) return [];
  return seed.participants.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
}

function blankNeedField(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

// Дописывает ссылку и подсказку посева, только если своего значения ещё нет.
function fillSeedActions(item, seed) {
  if (!item || !seed) return;
  if (blankNeedField(item.actionUrl) && seed.actionUrl) item.actionUrl = seed.actionUrl;
  if (blankNeedField(item.actionLabel) && seed.actionLabel) item.actionLabel = seed.actionLabel;
  if (blankNeedField(item.actionHint) && seed.actionHint) item.actionHint = seed.actionHint;
}

// Идемпотентный посев и миграция. Ничего не удаляет.
// need-render-api в посев не входит: после деплоя он не появляется снова.
// Если копия уже лежит в хранилище и ещё открыта, старт её закрывает.
// У посевных пунктов пустые actionUrl и actionHint заполняются один раз.
// Текст академии и «где» у финансов обновляются на месте: пункт не закрывается и не удаляется.
// Текст вопросов из NEEDS_DETAILS_JSON дописывается здесь же: и на старте, и при повторной миграции.
function migrateOwnerNeeds(list = state.needs) {
  const now = new Date().toISOString();
  // Посев только в пустой список. Непустая база или уже собранный список новые id не получают.
  // need-render-api в needSeeds нет и сюда не добавляется.
  const allowInsert = list.length === 0;
  for (const seed of needSeeds()) {
    let item = list.find((n) => n && n.id === seed.id);
    if (!item) {
      if (seed.id === RENDER_NEED_ID || seed.id === ACADEMY_NEED_ID) continue;
      if (!allowInsert && seed.id !== TEST_NEED_ID && seed.id !== QUESTION_NEED_ID) continue;
      item = {
        id: seed.id,
        what: seed.what,
        fromAgentId: seed.fromAgentId,
        where: seed.where,
        urgency: seed.urgency,
        actionUrl: null,
        docUrl: seed.docUrl || null,
        kind: seed.kind || null,
        actionLabel: seed.actionLabel || null,
        actionHint: seed.actionHint || null,
        details: '',
        answerable: seed.answerable === true,
        answerMode: seed.answerMode || defaultAnswerMode(seed.kind),
        answers: [],
        answer: null,
        answeredAt: null,
        answerStatus: null,
        participants: seedParticipantList(seed),
        createdAt: now,
        checkedAt: now,
        closedAt: null,
        closedBy: null,
        resolvesWhenEnv: null,
      };
      list.push(item);
    } else {
      if (!item.checkedAt) item.checkedAt = item.createdAt || now;
      fillSeedActions(item, seed);
      if (!Array.isArray(item.answers)) item.answers = [];
      if (item.answerStatus !== 'answered') item.answerStatus = null;
      if (typeof item.details !== 'string') item.details = '';
      if (typeof item.answerable !== 'boolean') item.answerable = seed.answerable === true;
      if (item.answerMode !== 'text' && item.answerMode !== 'yesno') {
        item.answerMode = seed.answerMode || defaultAnswerMode(item.kind || seed.kind);
      }
      if (!Array.isArray(item.participants)) item.participants = seedParticipantList(seed);
      if (!item.docUrl && seed.docUrl) item.docUrl = seed.docUrl;
      if (!item.kind && seed.kind) item.kind = seed.kind;
      if (isExternalDoc(item.actionUrl) && !item.docUrl) item.docUrl = item.actionUrl;
    }
  }
  for (const item of list) {
    if (!item) continue;
    if (item.answerMode !== 'text' && item.answerMode !== 'yesno') item.answerMode = defaultAnswerMode(item.kind);
  }
  applyNeedsDetails(list, readNeedsDetailsCatalog());
  for (const item of list) {
    if (!item || item.id !== ACADEMY_NEED_ID) continue;
    item.what = stripAdvisor(item.what || ACADEMY_WHAT);
    item.where = ACADEMY_WHERE;
    if (!item.closedAt) {
      item.closedAt = now;
      item.closedBy = 'putin';
    }
  }
  for (const item of list) {
    if (!item || item.id !== TEST_NEED_ID) continue;
    if (!String(item.what || '').startsWith('ТЕСТ:')) item.what = TEST_NEED_WHAT;
    item.kind = 'test';
    item.answerable = true;
    item.answerMode = 'yesno';
    item.closedAt = null;
    item.closedBy = null;
    item.answer = null;
    item.answeredAt = null;
    item.answerStatus = null;
    item.answers = [];
  }
  for (const item of list) {
    if (!item || item.id !== QUESTION_NEED_ID) continue;
    item.what = QUESTION_NEED_WHAT;
    item.kind = 'test';
    item.answerable = true;
    item.answerMode = 'text';
    item.closedAt = null;
    item.closedBy = null;
    item.answer = null;
    item.answeredAt = null;
    item.answerStatus = null;
    item.answers = [];
  }
  for (const item of list) {
    if (!item || item.id !== FINANCE_NEED_ID) continue;
    item.where = FINANCE_WHERE;
  }
  for (const item of list) {
    if (!item || item.id !== RENDER_NEED_ID) continue;
    if (!item.closedAt) item.closedAt = now;
  }
  const reopenedFinance = reopenFinanceTextNeed(list);
  if (list === state.needs) resolveNeedsByEnv();
  if (reopenedFinance && list === state.needs) schedulePoryadok();
  return list;
}

const FINANCE_TEXT_NOTE = 'до текстового поля';

function migrationFlags(list) {
  if (list === state.needs) {
    if (!state.migrations || typeof state.migrations !== 'object') state.migrations = {};
    return state.migrations;
  }
  if (!Object.prototype.hasOwnProperty.call(list, 'migrationFlags')) {
    Object.defineProperty(list, 'migrationFlags', { value: {}, enumerable: false, writable: true });
  }
  return list.migrationFlags;
}

function yesNoLabel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'no' || text === 'нет') return 'Нет';
  if (text === 'yes' || text === 'да') return 'Да';
  return '';
}

function needHasTextAnswer(item) {
  const answers = Array.isArray(item && item.answers) ? item.answers : [];
  return answers.some((entry) => {
    const text = entry && typeof entry.text === 'string' ? entry.text.trim() : '';
    return !!text && !yesNoLabel(text);
  });
}

// Один раз: need-finance, закрытый кнопкой «Да» до текстового поля, снова открыт.
// need-social не трогаем. Флаг в состоянии не даёт открыть пункт повторно.
function reopenFinanceTextNeed(list) {
  if (!Array.isArray(list)) return false;
  const flags = migrationFlags(list);
  if (flags.financeTextReopen) return false;
  flags.financeTextReopen = true;
  const item = list.find((n) => n && n.id === FINANCE_NEED_ID);
  if (!item || !item.closedAt || needHasTextAnswer(item)) return false;
  if (!Array.isArray(item.answers)) item.answers = [];
  let marked = false;
  for (const entry of item.answers) {
    if (!entry || typeof entry !== 'object') continue;
    if (!yesNoLabel(entry.text)) continue;
    entry.note = FINANCE_TEXT_NOTE;
    marked = true;
  }
  if (!marked && yesNoLabel(item.answer)) {
    item.answers.push({
      text: yesNoLabel(item.answer),
      at: item.answeredAt || item.closedAt || new Date().toISOString(),
      by: 'owner',
      note: FINANCE_TEXT_NOTE,
    });
  }
  item.answer = null;
  item.answeredAt = null;
  item.answerStatus = null;
  item.answerMode = 'text';
  item.closedAt = null;
  item.closedBy = null;
  item.updatedAt = new Date().toISOString();
  return true;
}

function schedulePoryadok() {
  try {
    if (poryadokSync && typeof poryadokSync.schedule === 'function') poryadokSync.schedule();
  } catch (_) { /* синхронизация ещё не собрана или выключена */ }
}

function migrateExternalNeedStore() {
  const file = path.join(__dirname, 'lib', 'store.js');
  if (!fs.existsSync(file)) return;
  let store;
  try {
    store = require(file);
  } catch (err) {
    console.error('Хранилище needs не подключено', err && err.message);
    return;
  }
  if (typeof store.withNeeds === 'function') {
    try {
      store.withNeeds((list) => {
        if (Array.isArray(list)) migrateOwnerNeeds(list);
        if (list === state.needs && state.migrations) store.noteMigrations(state.migrations);
      });
    } catch (err) {
      console.error('Миграция needs в хранилище не выполнена', err && err.message);
    }
  }
  if (Array.isArray(store.needs)) migrateOwnerNeeds(store.needs);
  if (store.state && Array.isArray(store.state.needs)) migrateOwnerNeeds(store.state.needs);
}

function reopenTestNeeds(now = Date.now(), force = false) {
  const opened = [];
  for (const item of state.needs) {
    if (!isTestNeedItem(item)) continue;
    if (!item.closedAt) continue;
    const closed = Date.parse(item.closedAt);
    if (!force && Number.isFinite(closed) && now - closed < TEST_REOPEN_MS) continue;
    item.closedAt = null;
    item.closedBy = null;
    item.answer = null;
    item.answeredAt = null;
    item.answerStatus = null;
    item.answers = [];
    opened.push(item);
  }
  for (const item of opened) store.noteNeed(item);
  if (opened.length) store.flush().catch(() => {});
  return opened.length;
}

migrateOwnerNeeds();
migrateExternalNeedStore();
reopenTestNeeds(Date.now(), true);
const testReopenTimer = setInterval(() => {
  try { reopenTestNeeds(); } catch (err) { console.error(err); }
}, 30 * 1000);
if (typeof testReopenTimer.unref === 'function') testReopenTimer.unref();
const needsResolveTimer = setInterval(() => {
  try {
    if (resolveNeedsByEnv()) poryadokSync.schedule();
  } catch (err) { console.error(err); }
}, NEEDS_RESOLVE_MS);
if (typeof needsResolveTimer.unref === 'function') needsResolveTimer.unref();

store.init(state, {
  uploadDir: UPLOAD_DIR,
  maxMessagesPerAgent: MAX_MESSAGES_PER_AGENT,
  maxTasks: 100,
  seedAgentIds: SEED_AGENTS.map((agent) => agent.id),
});

// Снимок в «Порядок» отдельно от списка «Нужно от вас» и приказов.
const poryadokSync = createPoryadokSync({ getState: () => state });
poryadokSync.start();

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

function publicState(opts = {}) {
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
      parentId: a.parentId || null,
      order: a.order || 0,
      number: agentNumber(a),
      archived: !!a.archived,
      grokAgentId: a.grokAgentId || null,
      vacant: !!a.vacant,
      completed: a.completed || 0,
      responsibilities: (a.responsibilities || []).slice(),
      ...activityFor(a, state.tasks, Date.now(), activeWindowMs(), activityExtras()),
      ...(a.analysis !== undefined ? { analysis: a.analysis } : {}),
    })),
    tasks: state.tasks.slice(0, 100).map(publicTask),
    outbox: (state.outbox || []).map(publicOutbox),
    messages: messagesForState(),
    needs: state.needs.map((item) => publicNeed(item, Date.now(), opts)),
    routines: state.routines.slice(0, 100).map(publicRoutine),
    poryadokSync: poryadokSync.publicStatus(),
  };
}

function activityExtras() {
  return { messages: state.messages, routines: state.routines, outbox: state.outbox || [] };
}

function publicRoutine(item) {
  return {
    id: item.id,
    agentId: item.agentId,
    name: item.name,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt || null,
    active: !item.finishedAt,
  };
}

function needHasDetails(item) {
  return !!(item && typeof item.details === 'string' && item.details.trim());
}

function needPagePath(id) {
  return `/needs/${encodeURIComponent(String(id))}`;
}

function defaultAnswerMode(kind) {
  return kind === 'approval' ? 'yesno' : 'text';
}

function answerModeOf(item) {
  if (item && (item.answerMode === 'text' || item.answerMode === 'yesno')) return item.answerMode;
  return defaultAnswerMode(item && item.kind);
}

function isTestNeedItem(item) {
  return !!(item && (item.kind === 'test' || item.id === TEST_NEED_ID || item.id === QUESTION_NEED_ID));
}

function isFixtureTestNeed(item) {
  return !!(item && (item.id === TEST_NEED_ID || item.id === QUESTION_NEED_ID));
}

function publicAnswers(item) {
  const list = Array.isArray(item && item.answers) ? item.answers : [];
  return list.slice(-ANSWERS_MAX).map((answer) => {
    const view = {
      text: typeof answer.text === 'string' ? answer.text : '',
      at: answer.at || null,
      by: typeof answer.by === 'string' && answer.by ? answer.by : null,
    };
    if (typeof answer.note === 'string' && answer.note.trim()) view.note = answer.note.trim();
    return view;
  });
}

function publicNeed(item, now = Date.now(), opts = {}) {
  const view = {
    id: item.id,
    what: item.what,
    fromAgentId: item.fromAgentId,
    where: item.where,
    urgency: item.urgency,
    kind: item.kind || null,
    participants: Array.isArray(item.participants) ? item.participants.slice() : [],
    actionUrl: needPagePath(item.id),
    docUrl: item.docUrl || null,
    actionLabel: item.actionLabel || null,
    actionHint: item.actionHint || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt || null,
    checkedAt: item.checkedAt || item.createdAt || null,
    closedAt: item.closedAt || null,
    closedBy: item.closedBy || null,
    resolvesWhenEnv: item.resolvesWhenEnv || null,
    stale: isNeedStale(item, now),
    hasDetails: needHasDetails(item),
    answerable: item.answerable === true,
    answerMode: answerModeOf(item),
    yesNo: answerModeOf(item) === 'yesno',
    answer: item.answer || null,
    answeredAt: item.answeredAt || null,
    answerStatus: item.answerStatus === 'answered' ? 'answered' : null,
  };
  if (opts.includePrivate || isFixtureTestNeed(item)) {
    view.details = typeof item.details === 'string' ? item.details : '';
    view.answers = publicAnswers(item);
  }
  return view;
}

function openNeeds() {
  return state.needs.filter((item) => !item.closedAt);
}

function needText(value, field, max) {
  if (typeof value !== 'string') throw httpError(400, `${field} должен быть строкой`);
  const text = value.trim();
  if (!text) throw httpError(400, `Нужно поле ${field}`);
  if (text.length > max) throw httpError(400, `${field} слишком длинное (максимум ${max} символов)`);
  return text;
}

function parseEnvName(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'resolvesWhenEnv должен быть строкой');
  const name = value.trim();
  if (!name) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name)) throw httpError(400, 'Некорректное имя resolvesWhenEnv');
  return name;
}

function readNeedsDetailsCatalog(raw = process.env.NEEDS_DETAILS_JSON) {
  if (raw == null || String(raw).trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (_) {
    console.warn('NEEDS_DETAILS_JSON: невалидный JSON, значение проигнорировано');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('NEEDS_DETAILS_JSON: невалидный JSON, значение проигнорировано');
    return null;
  }
  return parsed;
}

function applyNeedsDetails(list, catalog) {
  if (!catalog || !Array.isArray(list)) return;
  let trimmed = false;
  for (const item of list) {
    if (!item || item.id == null) continue;
    const spec = catalog[String(item.id)];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    if (typeof spec.details === 'string') {
      item.details = spec.details.length > DETAILS_MAX ? spec.details.slice(0, DETAILS_MAX) : spec.details;
      if (spec.details.length > DETAILS_MAX) trimmed = true;
    }
    if (typeof spec.answerable === 'boolean') item.answerable = spec.answerable;
    if (spec.answerMode === 'text' || spec.answerMode === 'yesno') item.answerMode = spec.answerMode;
  }
  if (trimmed) console.warn('NEEDS_DETAILS_JSON: details обрезаны до лимита символов');
}

function optionalNeedText(value, field, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, `${field} должен быть строкой`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw httpError(400, `${field} слишком длинное (максимум ${max} символов)`);
  return text;
}

// Только https:// и grokbot://. Пустое значение — поле не задано.
function parseActionUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'actionUrl должен быть строкой');
  const url = value.trim();
  if (!url) return null;
  if (url.length > ACTION_URL_MAX) throw httpError(400, `actionUrl слишком длинное (максимум ${ACTION_URL_MAX} символов)`);
  if (!/^(https|grokbot):\/\/\S+$/i.test(url)) {
    throw httpError(400, 'actionUrl должен начинаться с https:// или grokbot://');
  }
  return url;
}

function parseNeed(body) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const what = needText(body.what, 'what', 500);
  const where = needText(body.where, 'where', 300);
  const fromAgentId = typeof body.fromAgentId === 'string' ? body.fromAgentId.trim() : '';
  if (!fromAgentId) throw httpError(400, 'Нужен fromAgentId');
  if (!findAgent(fromAgentId)) throw httpError(400, 'Неизвестный агент');
  const urgency = typeof body.urgency === 'string' ? body.urgency.trim() : '';
  if (!NEED_URGENCY.has(urgency)) throw httpError(400, 'urgency должен быть low, normal или high');
  const resolvesWhenEnv = parseEnvName(body.resolvesWhenEnv);
  const actionUrl = parseActionUrl(body.actionUrl);
  const actionLabel = optionalNeedText(body.actionLabel, 'actionLabel', ACTION_LABEL_MAX);
  const actionHint = optionalNeedText(body.actionHint, 'actionHint', ACTION_HINT_MAX);
  const details = parseDetails(body.details);
  const answerable = parseAnswerable(body.answerable);
  const participants = parseParticipants(body.participants);
  const kind = parseKind(body.kind);
  const answerMode = parseAnswerMode(body.answerMode, kind);
  const docUrl = parseDocUrl(body.docUrl != null ? body.docUrl : (isExternalDoc(actionUrl) ? actionUrl : null));
  return { what, where, fromAgentId, urgency, participants, kind, answerMode, resolvesWhenEnv, docUrl, actionLabel, actionHint, details, answerable };
}

function parseAnswerMode(value, kind) {
  if (value == null || value === '') return defaultAnswerMode(kind);
  if (typeof value !== 'string') throw httpError(400, 'answerMode должен быть text или yesno');
  const mode = value.trim();
  if (mode !== 'text' && mode !== 'yesno') throw httpError(400, 'answerMode должен быть text или yesno');
  return mode;
}

function parseDetails(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw httpError(400, 'details должен быть строкой');
  if (value.length > DETAILS_MAX) throw httpError(400, `details слишком длинное (максимум ${DETAILS_MAX} символов)`);
  return value.trim() ? value : '';
}

function parseAnswerable(value) {
  if (value == null || value === '') return false;
  if (typeof value !== 'boolean') throw httpError(400, 'answerable должен быть boolean');
  return value;
}

function parseKind(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !NEED_KINDS.has(value.trim())) {
    throw httpError(400, 'kind должен быть money, outside_message, delete, publish, secret, approval или test');
  }
  return value.trim();
}

function isExternalDoc(value) {
  return typeof value === 'string' && /^(https|grokbot):\/\/\S+$/i.test(value.trim());
}

function parseDocUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'docUrl должен быть строкой');
  const url = value.trim();
  if (!url) return null;
  if (!isExternalDoc(url) || url.length > ACTION_URL_MAX) {
    throw httpError(400, 'docUrl должен начинаться с https:// или grokbot://');
  }
  return url;
}

function stripAdvisor(text) {
  return String(text || '')
    .replace(/,?\s*и Business Adviser/g, '')
    .replace(/Business Adviser/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,:.])/g, '$1')
    .trim();
}

function parseParticipants(value) {
  if (value == null || value === '') return [];
  if (!Array.isArray(value)) throw httpError(400, 'participants должен быть массивом id агентов');
  const ids = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) throw httpError(400, 'participants должен содержать id агентов');
    const id = raw.trim();
    if (!findAgent(id)) throw httpError(400, 'Неизвестный участник');
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > 12) throw httpError(400, 'Слишком много участников (максимум 12)');
  }
  return ids;
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

function archivedAuthor(id) {
  const agent = findAgent(typeof id === 'string' ? id.trim() : '');
  return !!(agent && agent.archived);
}

function nextSlot() {
  const used = new Set(state.agents.map((a) => `${a.x},${a.y}`));
  for (const slot of EXTRA_SLOTS) {
    if (!used.has(`${slot.x},${slot.y}`)) return slot;
  }
  const i = state.agents.length;
  return { x: 40 + (i % 5) * 170, y: 40 + Math.floor(i / 5) * 160 };
}

// Голый ключ → `Bearer <key>`. Уже готовое значение (`Bearer …`, `Basic …`
// или целиком `Authorization: …`) уходит как есть. x-webhook-key всегда голый ключ.
function parseKremlinKey(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return { authorization: '', bare: '' };
  value = value.replace(/^authorization:\s*/i, '').trim();
  if (!value) return { authorization: '', bare: '' };
  const scheme = value.match(/^(bearer|basic)\s+(\S[\s\S]*)$/i);
  if (scheme) return { authorization: value, bare: scheme[2].trim() };
  return { authorization: `Bearer ${value}`, bare: value };
}

function kremlinWebhookHeaders(env = process.env) {
  const headers = { 'Content-Type': 'application/json' };
  const parsed = parseKremlinKey(env && env.KREMLIN_WEBHOOK_KEY);
  if (!parsed.authorization) return headers;
  if (parsed.bare) headers['x-webhook-key'] = parsed.bare;
  headers.Authorization = parsed.authorization;
  const name = String((env && env.KREMLIN_WEBHOOK_HEADER) || '').trim();
  if (name && name.toLowerCase() !== 'authorization' && name.toLowerCase() !== 'x-webhook-key') {
    headers[name] = parsed.authorization;
  }
  return headers;
}

function formatAtMsk(iso) {
  const date = new Date(iso);
  const when = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(when);
  const pick = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : '00';
  };
  return `${pick('day')}.${pick('month')} ${pick('hour')}:${pick('minute')} МСК`;
}

function pushTask(task) {
  state.tasks.unshift(task);
  if (state.tasks.length > 100) state.tasks.length = 100;
  store.noteTask(task);
}

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.expose = error;
  return err;
}

const PRIVATE_FIELDS = new Set(['seq', 'ord', 'bytes', 'extra', 'storedName', 'createdAtMs', 'forwardError']);

function withStoredFields(base, source) {
  for (const key of Object.keys(source || {})) {
    if (PRIVATE_FIELDS.has(key) || base[key] !== undefined || source[key] === undefined) continue;
    base[key] = source[key];
  }
  return base;
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

// Приказ поверх старой задачи. Поле status («в очереди агента», «отправлена Путину»,
// «выполнена») не трогаем при смене orderStatus: его читают очередь и старые клиенты.
// Жизнь приказа живёт в orderStatus.
// Цепочка: sent → accepted → in_progress (шаг можно пропустить) → done, либо failed.
const ORDER_NEXT = {
  sent: new Set(['accepted', 'failed']),
  accepted: new Set(['accepted', 'in_progress', 'done', 'failed']),
  in_progress: new Set(['in_progress', 'done', 'failed']),
};

function publicHistoryEntry(h) {
  return {
    status: h.status,
    at: h.at,
    progress: h.progress ?? null,
    note: h.note || '',
    result: h.result || null,
  };
}

function publicTask(t) {
  const base = {
    id: t.id,
    agent: t.agent,
    agentId: t.agentId || t.agent,
    fromAgentId: t.fromAgentId || null,
    parentOrderId: t.parentOrderId || null,
    text: t.text,
    status: t.status,
    delivery: t.delivery || null,
    orderStatus: t.orderStatus || 'sent',
    progress: t.progress ?? null,
    note: t.note || '',
    createdAt: t.createdAt,
    forwardStatus: t.forwardStatus,
    result: t.result ?? null,
    messageId: t.messageId || null,
    history: (t.history || []).map(publicHistoryEntry),
    attachments: (t.attachments || []).map(publicAttachment),
  };
  const view = withStoredFields(base, t);
  view.deliveryLabel = deliveryLabelFor(t);
  return view;
}

function deliveryLabelFor(task) {
  if (!task) return null;
  if ((task.orderStatus || 'sent') !== 'sent') return null;
  return deliveryCaption(task.forwardStatus);
}

function publicOutbox(item) {
  return {
    id: item.id,
    at: item.at,
    agentId: item.agentId,
    taskId: item.taskId || null,
    status: item.status,
    lastError: item.lastError || null,
    attempts: item.attempts || 0,
    payload: item.payload || null,
  };
}

function agentLabel(id) {
  const owner = senderName(id);
  if (owner) return owner;
  const agent = findAgent(id);
  return agent ? agent.name : id;
}

function orderEventText(task, entry) {
  if (entry.status === 'sent') return `Приказ: ${agentLabel(task.fromAgentId)} → ${agentLabel(task.agentId || task.agent)}`;
  if (entry.status === 'accepted') return entry.note ? `Принял заказ · ${entry.note}` : 'Принял заказ';
  if (entry.status === 'in_progress') {
    const bits = ['В работе'];
    if (entry.progress != null) bits.push(`${entry.progress}%`);
    if (entry.note) bits.push(entry.note);
    return bits.join(' · ');
  }
  if (entry.status === 'done') return entry.result ? `Выполнено: ${entry.result}` : 'Выполнено';
  if (entry.status === 'failed') return entry.note ? `Не выполнено: ${entry.note}` : 'Не выполнено';
  return entry.status;
}

function pushOrderHistory(task, entry) {
  if (!Array.isArray(task.history)) task.history = [];
  task.history.push(entry);
  const index = task.history.length - 1;
  addMessage({
    id: `order:${task.id}:${index}`,
    agentId: task.agent,
    role: 'system',
    text: orderEventText(task, entry),
    attachments: [],
    createdAt: entry.at,
    source: 'order',
    taskId: task.id,
  });
  store.noteTask(task);
}

function orderSnapshot(task, status, progress, note, result) {
  return {
    status,
    progress: status === 'in_progress' ? (progress ?? null) : null,
    note: note || '',
    result: status === 'done' ? (result || '') : '',
  };
}

function sameOrderSnapshot(task, next) {
  const cur = orderSnapshot(task, task.orderStatus || 'sent', task.progress, task.note, task.result);
  return cur.status === next.status
    && cur.progress === next.progress
    && cur.note === next.note
    && cur.result === next.result;
}

// Повтор того же снимка ничего не дописывает. force нужен старому POST /api/status:
// он по-прежнему может закрыть задачу сразу, без шага «принял».
function applyOrderUpdate(task, input, opts = {}) {
  const status = input.status;
  let progress = input.progress ?? null;
  const note = input.note || '';
  const result = input.result || '';
  if (status === 'in_progress' && progress == null) progress = task.progress ?? null;
  const next = orderSnapshot(task, status, progress, note, result);
  if (sameOrderSnapshot(task, next)) return { changed: false };

  const current = task.orderStatus || 'sent';
  if ((current === 'done' || current === 'failed') && !opts.force) {
    throw httpError(400, 'Приказ уже закрыт');
  }
  if (current === 'done' && status === 'done') {
    task.result = result;
    const last = task.history && task.history[task.history.length - 1];
    if (last && last.status === 'done') last.result = result;
    const msg = state.messages.find((m) => m.id === `order:${task.id}:${(task.history || []).length - 1}`);
    if (msg && last) {
      msg.text = orderEventText(task, last);
      store.noteMessage(msg);
    }
    store.noteTask(task);
    return { changed: false };
  }
  if (!opts.force && !(ORDER_NEXT[current] && ORDER_NEXT[current].has(status))) {
    throw httpError(400, 'Недопустимый переход статуса');
  }

  const entry = {
    status,
    at: new Date().toISOString(),
    progress: next.progress,
    note,
    result: status === 'done' ? result : null,
  };
  task.orderStatus = status;
  task.progress = next.progress;
  task.note = note;
  if (status === 'done') {
    const firstDone = task.status !== 'выполнена';
    task.result = result;
    task.status = 'выполнена';
    if (firstDone) {
      const owner = findAgent(task.agent) || opts.creditAgent || null;
      if (owner) {
        owner.completed = (owner.completed || 0) + 1;
        store.noteAgent(owner);
      }
    }
  }
  pushOrderHistory(task, entry);
  return { changed: true };
}

function parseOrderUpdate(body) {
  body = body || {};
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!['accepted', 'in_progress', 'done', 'failed'].includes(status)) {
    throw httpError(400, 'status должен быть accepted, in_progress, done или failed');
  }
  let progress = null;
  if (body.progress != null && body.progress !== '') {
    if (status !== 'in_progress') throw httpError(400, 'progress допустим только для in_progress');
    if (typeof body.progress !== 'number' || !Number.isInteger(body.progress) || body.progress < 0 || body.progress > 100) {
      throw httpError(400, 'progress — целое число от 0 до 100');
    }
    progress = body.progress;
  }
  let note = '';
  if (body.note != null && body.note !== '') {
    if (typeof body.note !== 'string') throw httpError(400, 'note должен быть строкой');
    note = body.note.trim();
    if (note.length > 200) throw httpError(400, 'Слишком длинная заметка (максимум 200 символов)');
  }
  let result = '';
  if (status === 'done') {
    if (typeof body.result !== 'string' || !body.result.trim()) throw httpError(400, 'Для done нужен result');
    result = body.result.trim();
    if (result.length > 8000) throw httpError(400, 'Слишком длинный результат');
  } else if (body.result != null && String(body.result).trim() !== '') {
    throw httpError(400, 'result допустим только для done');
  }
  return { status, progress, note, result };
}

function resolveFromAgent(raw, agentId) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  const fromAgentId = id || (agentId === 'grok' ? 'owner' : 'grok');
  if (fromAgentId !== 'owner' && !findAgent(fromAgentId)) throw httpError(400, 'Неизвестный отправитель');
  return fromAgentId;
}

function resolveParentOrder(raw) {
  if (raw == null || raw === '') return null;
  const id = String(raw).trim();
  if (!id) return null;
  const parent = state.tasks.find((t) => t.id === id);
  if (!parent) throw httpError(400, 'Неизвестный родительский приказ');
  return parent.id;
}

function cmpMsg(a, b) {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function publicMessage(m) {
  const base = {
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
  return withStoredFields(base, m);
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
    store.noteFile(rec);
    return publicAttachment(rec);
  });
}

function releaseUnusedFiles() {
  const used = new Set();
  for (const t of state.tasks) for (const a of t.attachments || []) if (a.id) used.add(a.id);
  for (const m of state.messages) for (const a of m.attachments || []) if (a.id) used.add(a.id);
  const now = Date.now();
  const removed = [];
  for (const [id, rec] of state.files) {
    if (used.has(id)) continue;
    if (now - rec.createdAtMs < 30 * 60 * 1000) continue;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, rec.storedName)); } catch (_) { /* нет файла */ }
    state.files.delete(id);
    removed.push(id);
  }
  store.noteFilesRemoved(removed);
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
  store.noteMessagesRemoved(drop);
}

function addMessage(input) {
  if (input.id) {
    const existing = state.messages.find((m) => m.id === input.id);
    if (existing) {
      if (input.source === 'status' && input.text && existing.text !== input.text) {
        existing.text = input.text;
        existing.createdAt = input.createdAt || existing.createdAt;
        store.noteMessage(existing);
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
  store.noteMessage(message);
  return { message: publicMessage(message), duplicate: false };
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
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой (макс. 10 МБ)' });
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

function hqPasswordOk(req) {
  if (!APP_PASSWORD) return false;
  const provided = req.get('x-app-password') || '';
  if (!provided) return false;
  return safeEqual(provided, APP_PASSWORD);
}

function rejectBadPassword(req, res) {
  const provided = req.get('x-app-password') || '';
  if (!provided) return false;
  if (!APP_PASSWORD) {
    res.status(503).json({ error: 'Пароль доступа не настроен (APP_PASSWORD)' });
    return true;
  }
  if (!safeEqual(provided, APP_PASSWORD)) {
    res.status(401).json({ error: 'Неверный пароль доступа' });
    return true;
  }
  return false;
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

// Пароль посетителя важнее токена, если прислали оба. Иначе id агента из тела.
function needCloser(req) {
  const pw = req.get('x-app-password') || '';
  if (APP_PASSWORD && safeEqual(pw, APP_PASSWORD)) return { id: 'user' };
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const raw = typeof body.agentId === 'string' && body.agentId.trim()
    ? body.agentId.trim()
    : (typeof body.agent === 'string' ? body.agent.trim() : '');
  if (!raw) return { error: 'Для токена агента нужен agentId' };
  if (!findAgent(raw)) return { error: 'Неизвестный агент' };
  return { id: raw };
}

const app = express();
app.disable('x-powered-by');
// Текст задачи и id вложений — это JSON до 1 МБ. Сами файлы принимает multer: 10 МБ и не больше 5.
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.on('finish', () => {
    try { poryadokSync.noteRequestFinished(); } catch (_) { /* ответ уже ушёл */ }
  });
  store.ready.then(() => next(), next);
});

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

function deliveryAuthorized(req) {
  const header = String(req.get('authorization') || '');
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  const bearer = match ? match[1] : '';
  const agent = req.get('x-agent-token') || '';
  const password = req.get('x-app-password') || '';
  if (AGENT_TOKEN && bearer && safeEqual(bearer, AGENT_TOKEN)) return true;
  if (AGENT_TOKEN && agent && safeEqual(agent, AGENT_TOKEN)) return true;
  if (APP_PASSWORD && password && safeEqual(password, APP_PASSWORD)) return true;
  return false;
}

app.get('/api/health/delivery', (req, res) => {
  if (!deliveryAuthorized(req)) return res.status(401).json({ error: 'Нужна авторизация' });
  const list = state.outbox || [];
  res.json({
    webhookUrlSet: webhookUrl() !== '',
    webhookKeySet: String(process.env.KREMLIN_WEBHOOK_KEY || '').trim() !== '',
    lastDelivery: lastDeliveryView(),
    queued: list.filter((item) => item && item.status === 'queued').length,
    delivered: list.filter((item) => item && item.status === 'delivered').length,
  });
});

app.post('/api/outbox/retry', requireAppPassword, async (req, res) => {
  if (!webhookUrl()) return res.status(409).json({ error: 'KREMLIN_WEBHOOK_URL не задан' });
  const result = await flushOutbox();
  res.json({ ok: true, sent: result.sent, failed: result.failed });
});

app.get('/api/state', (req, res) => {
  if (resolveNeedsByEnv()) poryadokSync.schedule();
  res.json(publicState({ includePrivate: hqPasswordOk(req) }));
});

app.get('/api/needs', (req, res) => {
  if (resolveNeedsByEnv()) poryadokSync.schedule();
  const opts = { includePrivate: hqPasswordOk(req) };
  res.json({ needs: openNeeds().map((item) => publicNeed(item, Date.now(), opts)) });
});

app.get('/api/needs/:id', (req, res) => {
  if (rejectBadPassword(req, res)) return;
  const item = state.needs.find((n) => n.id === req.params.id);
  // Страница вопроса не показывает архивного автора: пункт остаётся в списках.
  if (!item || archivedAuthor(item.fromAgentId)) return res.status(404).json({ error: 'Пункт не найден' });
  res.json(publicNeed(item, Date.now(), { includePrivate: hqPasswordOk(req) }));
});

app.post('/api/needs', requireUserOrAgent, async (req, res) => {
  try {
    const parsed = parseNeed(req.body);
    const createdAt = new Date().toISOString();
    const item = {
      id: `n-${state.nextNeedId++}`,
      what: parsed.what,
      where: parsed.where,
      fromAgentId: parsed.fromAgentId,
      urgency: parsed.urgency,
      kind: parsed.kind,
      answerMode: parsed.answerMode,
      participants: parsed.participants,
      docUrl: parsed.docUrl,
      actionLabel: parsed.actionLabel,
      actionHint: parsed.actionHint,
      details: parsed.details,
      answerable: parsed.answerable || parsed.kind === 'approval' || parsed.kind === 'test',
      answers: [],
      answerStatus: null,
      resolvesWhenEnv: parsed.resolvesWhenEnv,
      createdAt,
      updatedAt: createdAt,
      checkedAt: createdAt,
      closedAt: null,
      closedBy: null,
    };
    state.needs.unshift(item);
    resolveNeedsByEnv();
    store.noteNeed(item);
    poryadokSync.schedule();
    await store.flush();
    res.status(201).json(publicNeed(item));
  } catch (err) {
    const status = err.status || 500;
    if (!err.status) console.error(err);
    res.status(status).json({ error: err.expose || 'Не удалось записать пункт' });
  }
});

app.post('/api/needs/:id/confirm', requireAgentToken, async (req, res) => {
  const item = state.needs.find((n) => n.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Пункт не найден' });
  item.checkedAt = new Date().toISOString();
  store.noteNeed(item);
  poryadokSync.schedule();
  await store.flush();
  res.json(publicNeed(item));
});

app.post('/api/needs/:id/close', requireUserOrAgent, async (req, res) => {
  const item = state.needs.find((n) => n.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Пункт не найден' });
  if (item.closedAt) return res.json(publicNeed(item));
  const who = needCloser(req);
  if (who.error) return res.status(400).json({ error: who.error });
  item.closedAt = new Date().toISOString();
  item.closedBy = who.id;
  item.updatedAt = item.closedAt;
  console.log(`need closed: ${item.id} by ${who.id}`);
  store.noteNeed(item);
  if (!isTestNeedItem(item)) {
    poryadokSync.schedule();
    await deliverNeedEvent({ item, type: 'close', text: needCloseText(item) });
  }
  await store.flush();
  res.json(publicNeed(item));
});

app.patch('/api/needs/:id', requireUserOrAgent, async (req, res) => {
  const item = state.needs.find((n) => n.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Пункт не найден' });
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  let justClosed = false;
  try {
    if (Object.prototype.hasOwnProperty.call(body, 'what')) item.what = needText(body.what, 'what', 500);
    if (Object.prototype.hasOwnProperty.call(body, 'where')) item.where = needText(body.where, 'where', 300);
    if (Object.prototype.hasOwnProperty.call(body, 'urgency')) {
      const urgency = typeof body.urgency === 'string' ? body.urgency.trim() : '';
      if (!NEED_URGENCY.has(urgency)) throw httpError(400, 'urgency должен быть low, normal или high');
      item.urgency = urgency;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'kind')) item.kind = parseKind(body.kind);
    if (Object.prototype.hasOwnProperty.call(body, 'answerMode')) item.answerMode = parseAnswerMode(body.answerMode, item.kind);
    else if (Object.prototype.hasOwnProperty.call(body, 'kind')) item.answerMode = defaultAnswerMode(item.kind);
    if (Object.prototype.hasOwnProperty.call(body, 'docUrl')) item.docUrl = parseDocUrl(body.docUrl);
    if (Object.prototype.hasOwnProperty.call(body, 'details')) item.details = parseDetails(body.details);
    if (body.closed === true || body.close === true) {
      if (!item.closedAt) {
        const who = needCloser(req);
        if (who.error) throw httpError(400, who.error);
        item.closedAt = new Date().toISOString();
        item.closedBy = who.id;
        justClosed = true;
      }
    }
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: err.expose || err.message || 'Некорректный пункт' });
  }
  item.updatedAt = new Date().toISOString();
  store.noteNeed(item);
  if (!isTestNeedItem(item)) poryadokSync.schedule();
  if (justClosed) await deliverNeedEvent({ item, type: 'close', text: needCloseText(item) });
  await store.flush();
  res.json(publicNeed(item, Date.now(), { includePrivate: hqPasswordOk(req) }));
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
  if (agent.archived) {
    discardUploads(req.files);
    return res.status(409).json({ error: 'Агент в архиве: новые задачи и приказы ему не ставятся' });
  }
  if (text.length > 4000) {
    discardUploads(req.files);
    return res.status(400).json({ error: 'Слишком длинная задача (максимум 4000 символов)' });
  }

  let fromAgentId;
  let parentOrderId;
  try {
    fromAgentId = resolveFromAgent(req.body?.fromAgentId, agentId);
    parentOrderId = resolveParentOrder(req.body?.parentOrderId);
  } catch (err) {
    discardUploads(req.files);
    return res.status(err.status || 400).json({ error: err.expose || 'Некорректный приказ' });
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

  try {
    const task = await issueOwnerTask({ agentId, text, fromAgentId, parentOrderId, attachments });
    await store.flush();
    res.status(201).json(publicTask(task));
  } catch (err) {
    const status = err.status || 500;
    if (!err.status) console.error(err);
    res.status(status).json({ error: err.expose || 'Не удалось поставить задачу' });
  }
});

function needCloseText(item) {
  return `Пункт «${item && item.what ? item.what : ''}» закрыт`;
}

function needAnswerText(item, text) {
  return `Ответ Арсения на «${item && item.what ? item.what : ''}»: ${text}`;
}

// Ждущий агент забирает задачу сам. Нет способа забрать — запись в очереди Путина (grok).
function queueRecipient(fromAgentId) {
  const id = typeof fromAgentId === 'string' ? fromAgentId.trim() : '';
  if (!id || id === 'owner' || id === 'grok') return 'grok';
  const agent = findAgent(id);
  if (!agent || agent.archived || agent.vacant) return 'grok';
  return agent.id;
}

function openTask(task) {
  if (!task) return false;
  if (task.orderStatus === 'done' || task.orderStatus === 'failed') return false;
  if (task.status === 'выполнена') return false;
  return true;
}

const outboxInflight = new Set();
let outboxChain = Promise.resolve();
let startupFlushStarted = false;

function webhookUrl() {
  return String(process.env.KREMLIN_WEBHOOK_URL || '').trim();
}

function logDeliveryAttempt(item, label, ms) {
  const id = String(item && item.id || '').replace(/[\r\n]/g, '');
  const agent = String(item && item.agentId || '').replace(/[\r\n]/g, '');
  const result = String(label || '').replace(/[\r\n]/g, '');
  const attempt = item && item.attempts ? item.attempts : 0;
  console.log(`webhook attempt id=${id} agent=${agent} attempt=${attempt} ${result} ms=${ms}`);
}

function createOutboxItem(task, notice) {
  const id = `ob-${state.nextOutboxId++}`;
  const at = (notice && notice.at) || task.createdAt || new Date().toISOString();
  const payload = {
    id,
    type: notice && notice.type ? notice.type : 'owner_task',
    agentId: notice && notice.agentId ? notice.agentId : (task.agentId || task.agent),
    text: notice && notice.text != null ? notice.text : (task.text || ''),
    at,
    atMsk: formatAtMsk(at),
    appUrl: PUBLIC_URL,
  };
  if (notice && notice.needId) payload.needId = notice.needId;
  else payload.taskId = task.id;
  return {
    id,
    at,
    agentId: task.agentId || task.agent,
    taskId: task.id,
    status: 'queued',
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
    lastStatus: null,
    deliveredAt: null,
    payload,
  };
}

function applyOutboxResult(item, result) {
  if (!item || !result || !result.attempted) return;
  item.lastAttemptAt = new Date().toISOString();
  if (result.sent) {
    item.status = 'delivered';
    item.deliveredAt = item.lastAttemptAt;
    item.lastError = null;
    item.lastStatus = result.status;
    return;
  }
  item.status = 'queued';
  item.lastError = result.error || 'network_error';
  item.lastStatus = Number.isInteger(result.status) && result.status > 0 ? result.status : null;
}

function markDeliveredAgent(item, task) {
  const agent = findAgent((task && (task.agentId || task.agent)) || (item && item.agentId));
  if (!agent || agent.archived) return;
  const text = (task && task.text) || (item && item.payload && item.payload.text) || '';
  agent.status = 'working';
  if (text) agent.now = String(text).slice(0, 300);
  store.noteAgent(agent);
}

async function sendOutboxItem(item) {
  if (!item || item.status === 'delivered') return { sent: false, attempted: false, skipped: true };
  if (outboxInflight.has(item.id)) return { sent: false, attempted: false, skipped: true };
  const url = webhookUrl();
  if (!url) return { sent: false, attempted: false };
  outboxInflight.add(item.id);
  item.attempts = (Number(item.attempts) || 0) + 1;
  const started = Date.now();
  try {
    const headers = kremlinWebhookHeaders();
    headers['x-outbox-id'] = String(item.id);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(item.payload),
      signal: AbortSignal.timeout(10000),
    });
    if (response && typeof response.arrayBuffer === 'function') await response.arrayBuffer().catch(() => {});
    const ms = Date.now() - started;
    if (!response || !response.ok) {
      const code = response && Number.isFinite(Number(response.status)) ? response.status : 0;
      console.error(`Вебхук Кремля не доставлен: HTTP ${code}`);
      logDeliveryAttempt(item, `http=${code}`, ms);
      return { sent: false, attempted: true, status: code, error: `HTTP ${code}` };
    }
    logDeliveryAttempt(item, `http=${response.status}`, ms);
    return { sent: true, attempted: true, status: response.status };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const kind = timeout ? 'timeout' : 'network_error';
    console.error(`Вебхук Кремля не доставлен: ${kind}`);
    logDeliveryAttempt(item, `error=${kind}`, Date.now() - started);
    return { sent: false, attempted: true, status: 0, error: kind };
  } finally {
    outboxInflight.delete(item.id);
  }
}

async function drainOutbox() {
  const url = webhookUrl();
  if (!url) return { sent: 0, failed: 0 };
  const pending = (state.outbox || [])
    .filter((item) => item && item.status === 'queued')
    .slice()
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  let sent = 0;
  let failed = 0;
  for (const item of pending) {
    if (item.status !== 'queued') continue;
    const result = await sendOutboxItem(item);
    if (!result || result.skipped || !result.attempted) continue;
    applyOutboxResult(item, result);
    const task = state.tasks.find((entry) => entry.id === item.taskId);
    applyKremlinResult(task, result);
    if (result.sent) markDeliveredAgent(item, task);
    if (task) store.noteTask(task);
    store.noteOutbox(item);
    if (result.sent) sent += 1;
    else failed += 1;
  }
  await store.flush();
  return { sent, failed };
}

function flushOutbox() {
  const run = outboxChain.then(() => drainOutbox());
  outboxChain = run.then(() => {}, () => {});
  return run;
}

function kickStartupFlush() {
  if (startupFlushStarted) return;
  startupFlushStarted = true;
  store.ready.then(() => flushOutbox()).catch(() => {
    console.error('Очередь вебхука не отправлена');
  });
}

function lastDeliveryView() {
  let best = null;
  for (const item of state.outbox || []) {
    if (!item || !item.lastAttemptAt) continue;
    if (!best || item.lastAttemptAt > best.lastAttemptAt || (item.lastAttemptAt === best.lastAttemptAt && String(item.id) > String(best.id))) {
      best = item;
    }
  }
  if (!best) return null;
  const view = { at: best.lastAttemptAt, outboxId: best.id };
  if (Number.isInteger(best.lastStatus) && best.lastStatus > 0) view.status = best.lastStatus;
  else view.error = best.lastError || 'network_error';
  return view;
}

function applyKremlinResult(task, result) {
  if (!task || !result || !result.attempted) return;
  if (result.sent) {
    task.status = 'отправлена Путину';
    task.forwardStatus = result.status;
    task.forwardError = null;
    return;
  }
  task.status = 'в очереди агента';
  task.forwardStatus = result.status;
  if (result.error) task.forwardError = result.error;
}

async function enqueueQueueTask({ agentId, text, fromAgentId, parentOrderId, attachments, event }) {
  const agent = findAgent(agentId);
  if (!agent) throw httpError(400, 'Неизвестный агент');
  const bodyText = typeof text === 'string' ? text : '';
  const files = Array.isArray(attachments) ? attachments : [];
  if (bodyText.length > 20000) throw httpError(400, 'Слишком длинная задача (максимум 20000 символов)');
  if (!bodyText && files.length === 0) throw httpError(400, 'Нужны поля agent и text');

  const task = {
    id: `t-${state.nextTaskId++}`,
    agent: agentId,
    agentId,
    fromAgentId: fromAgentId || 'owner',
    parentOrderId: parentOrderId || null,
    text: bodyText,
    status: 'в очереди агента',
    delivery: 'queue',
    orderStatus: 'sent',
    progress: null,
    note: '',
    createdAt: new Date().toISOString(),
    forwardStatus: null,
    forwardError: null,
    result: null,
    history: [],
    attachments: files,
    messageId: '',
  };
  task.messageId = `task:${task.id}`;

  addMessage({
    id: task.messageId,
    agentId,
    role: 'owner',
    text: bodyText,
    attachments: files,
    createdAt: task.createdAt,
    source: 'app',
    taskId: task.id,
  });
  pushOrderHistory(task, {
    status: 'sent',
    at: new Date(Date.parse(task.createdAt) + 1).toISOString(),
    progress: null,
    note: '',
    result: null,
  });

  pushTask(task);
  releaseUnusedFiles();

  const notice = {
    type: event && event.type ? event.type : 'owner_task',
    agentId: event && event.agentId ? event.agentId : agentId,
    text: event && event.text != null ? event.text : bodyText,
    at: task.createdAt,
  };
  if (event && event.needId) notice.needId = event.needId;
  if (!notice.needId) notice.taskId = task.id;
  const item = createOutboxItem(task, notice);
  if (!Array.isArray(state.outbox)) state.outbox = [];
  state.outbox.push(item);
  store.noteOutbox(item);
  const result = await sendOutboxItem(item);
  applyOutboxResult(item, result);
  applyKremlinResult(task, result);
  if (result && result.sent) {
    agent.status = 'working';
    agent.now = (bodyText || `Файлы: ${files.map((a) => a.name).join(', ')}`).slice(0, 300);
    store.noteAgent(agent);
  }
  store.noteTask(task);
  store.noteOutbox(item);
  return task;
}

async function issueOwnerTask({ agentId, text, fromAgentId, parentOrderId, attachments }) {
  const agent = findAgent(agentId);
  if (!agent) throw httpError(400, 'Неизвестный агент');
  if (agent.vacant) throw httpError(400, 'Это свободное направление: сначала дай ему название');
  if (agent.archived) throw httpError(409, 'Агент в архиве: новые задачи и приказы ему не ставятся');
  const bodyText = typeof text === 'string' ? text : '';
  return enqueueQueueTask({
    agentId,
    text: bodyText,
    fromAgentId,
    parentOrderId,
    attachments,
    event: { type: 'owner_task', agentId, text: bodyText },
  });
}

async function deliverNeedEvent({ item, type, text }) {
  if (!item || isTestNeedItem(item)) return null;
  const agentId = queueRecipient(item.fromAgentId);
  try {
    return await enqueueQueueTask({
      agentId,
      text,
      fromAgentId: 'owner',
      parentOrderId: null,
      attachments: [],
      event: { type, needId: item.id, agentId, text },
    });
  } catch (_) {
    console.error('Не удалось поставить событие пункта в очередь');
    return null;
  }
}

function parseYesNo(body) {
  if (!body || (body.answer == null && body.choice == null)) return null;
  const raw = body.answer != null ? body.answer : body.choice;
  if (typeof raw !== 'string') throw httpError(400, 'answer должен быть yes или no');
  const value = raw.trim().toLowerCase();
  if (value === 'yes' || value === 'да') return 'yes';
  if (value === 'no' || value === 'нет') return 'no';
  throw httpError(400, 'answer должен быть yes или no');
}

function yesNoWord(answer) {
  return answer === 'no' ? 'Нет' : 'Да';
}

function parsePartial(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'partial') || body.partial == null || body.partial === false) return false;
  if (body.partial === true) return true;
  throw httpError(400, 'partial должен быть boolean');
}

function pushNeedAnswer(item, entry) {
  if (!Array.isArray(item.answers)) item.answers = [];
  item.answers.push(entry);
  if (item.answers.length > ANSWERS_MAX) item.answers.splice(0, item.answers.length - ANSWERS_MAX);
}

function settleNeedAnswer(item, nowIso, partial) {
  item.answerStatus = 'answered';
  item.updatedAt = nowIso;
  if (!partial) {
    item.closedAt = nowIso;
    item.closedBy = 'owner';
  }
  if (!isTestNeedItem(item)) poryadokSync.schedule();
}

app.post('/api/needs/:id/answer', async (req, res) => {
  const item = state.needs.find((n) => n.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Пункт не найден' });
  const testNeed = isTestNeedItem(item);
  if (!testNeed && !hqPasswordOk(req)) {
    if (!APP_PASSWORD) return res.status(503).json({ error: 'Пароль доступа не настроен (APP_PASSWORD)' });
    return res.status(401).json({ error: 'Неверный пароль доступа' });
  }
  if (item.closedAt || item.answering) return res.status(409).json({ error: 'Пункт уже закрыт' });
  let partial = false;
  try {
    partial = parsePartial(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.expose || 'Некорректный ответ' });
  }
  const mode = answerModeOf(item);
  const nowIso = new Date().toISOString();
  item.answering = true;
  try {
    if (mode === 'yesno') {
      let choice = null;
      try {
        choice = parseYesNo(req.body);
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.expose || 'Некорректный ответ' });
      }
      if (!choice) return res.status(400).json({ error: 'answer должен быть yes или no' });
      const word = yesNoWord(choice);
      if (!testNeed) await deliverNeedEvent({ item, type: 'answer', text: needAnswerText(item, word) });
      if (item.closedAt) return res.status(409).json({ error: 'Пункт уже закрыт' });
      item.answer = choice;
      item.answeredAt = nowIso;
      pushNeedAnswer(item, { text: word, at: nowIso, by: 'owner' });
      settleNeedAnswer(item, nowIso, partial);
      store.noteNeed(item);
      await store.flush();
      return res.status(201).json(publicNeed(item, Date.now(), { includePrivate: true }));
    }
    const raw = req.body && typeof req.body.text === 'string' ? req.body.text : '';
    if (req.body && req.body.text != null && typeof req.body.text !== 'string') {
      return res.status(400).json({ error: 'Нужен текст ответа' });
    }
    const text = raw.trim();
    if (!text) return res.status(400).json({ error: 'Нужен текст ответа' });
    if (text.length > ANSWER_MAX) {
      return res.status(400).json({ error: `Слишком длинный ответ (максимум ${ANSWER_MAX} символов)` });
    }
    if (!testNeed) await deliverNeedEvent({ item, type: 'answer', text: needAnswerText(item, text) });
    if (item.closedAt) return res.status(409).json({ error: 'Пункт уже закрыт' });
    pushNeedAnswer(item, { text, at: nowIso, by: 'owner' });
    settleNeedAnswer(item, nowIso, partial);
    store.noteNeed(item);
    await store.flush();
    return res.status(201).json(publicNeed(item, Date.now(), { includePrivate: true }));
  } finally {
    item.answering = false;
  }
});

app.post('/api/upload', requireUserOrAgent, uploadArray, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл в поле files' });
  const attachments = storeIncomingFiles(files);
  await store.flush();
  res.status(201).json({ attachments });
});

app.get('/api/files/:id', (req, res) => {
  const id = String(req.params.id || '');
  const rec = /^[a-f0-9]{32}$/.test(id) ? state.files.get(id) : null;
  if (!rec) return res.status(404).json({ error: 'Файл не найден' });
  const bytes = Buffer.isBuffer(rec.bytes) ? rec.bytes : null;
  let resolved = null;
  if (!bytes) {
    const root = path.resolve(UPLOAD_DIR);
    resolved = path.resolve(root, rec.storedName);
    if (path.dirname(resolved) !== root || !fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
  }
  const inline = INLINE_MIME.has(rec.mime);
  const encoded = encodeURIComponent(rec.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encoded}`);
  if (bytes) {
    res.setHeader('Content-Type', inline ? rec.mime : 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes.length));
    return res.end(bytes);
  }
  res.type(inline ? rec.mime : 'application/octet-stream');
  return res.sendFile(resolved);
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
  const removed = [];
  for (const file of files || []) {
    if (file && file.filename) {
      state.files.delete(file.filename);
      removed.push(file.filename);
    }
    if (file && file.path) {
      try { fs.unlinkSync(file.path); } catch (_) { /* уже удалён */ }
    }
  }
  store.noteFilesRemoved(removed);
}

app.post('/api/messages', requireAgentToken, maybeUpload, async (req, res) => {
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
      await store.flush();
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
    await store.flush();
    return res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate, message: result.message });
  } catch (err) {
    forgetUploads(req.files);
    await store.flush();
    const status = err.status || 500;
    if (!err.status) console.error(err);
    return res.status(status).json({ error: err.expose || 'Не удалось сохранить сообщение' });
  }
});

app.post('/api/status', requireAgentToken, async (req, res) => {
  const body = req.body || {};
  const agentId = typeof body.agent === 'string' ? body.agent.trim() : '';
  if (!agentId) {
    return res.status(400).json({ error: 'Нужно поле agent' });
  }
  if (body.status != null && !STATUS_LABELS[body.status]) {
    return res.status(400).json({ error: 'status должен быть working, idle или waiting' });
  }
  if (body.dashboard != null && body.dashboard !== '' && typeof body.dashboard !== 'string') {
    return res.status(400).json({ error: 'dashboard должен быть строкой' });
  }
  if (typeof body.dashboard === 'string' && body.dashboard.trim().length > 500) {
    return res.status(400).json({ error: 'Слишком длинный dashboard (максимум 500 символов)' });
  }

  let parent = null;
  if (typeof body.parentId === 'string' && body.parentId.trim()) {
    parent = findAgent(body.parentId.trim());
    if (!parent) return res.status(400).json({ error: 'Неизвестный родитель' });
    if (parent.parentId) return res.status(400).json({ error: 'Помощник может подчиняться только направлению' });
    if (parent.id === agentId) return res.status(400).json({ error: 'Агент не может быть родителем сам себе' });
  }

  let agent = findAgent(agentId);
  if (!agent) {
    const slot = parent ? slotNear(parent) : nextSlot();
    const siblings = parent ? state.agents.filter((a) => a.parentId === parent.id && !a.archived) : [];
    const tops = state.agents.filter((a) => !a.parentId && !a.archived);
    agent = {
      id: agentId,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : agentId,
      color: typeof body.color === 'string' && body.color.trim() ? body.color.trim() : '#64748b',
      accent: typeof body.accent === 'string' && body.accent.trim() ? body.accent.trim() : '#fff',
      role: typeof body.role === 'string' && body.role.trim() ? body.role.trim() : 'Агент',
      district: typeof body.district === 'string' && body.district.trim() ? body.district.trim() : (parent ? parent.district : 'Окраина'),
      kind: typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'generic',
      tier: parent ? 'sub' : 'dept',
      archived: false,
      parentId: parent ? parent.id : null,
      order: parent
        ? siblings.reduce((m, a) => Math.max(m, a.order || 0), 0) + 1
        : tops.reduce((m, a) => Math.max(m, a.order || 0), 0) + 1,
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
    if (parent) {
      if (!parent.links.includes(agent.id)) parent.links.push(agent.id);
    } else {
      const main = findAgent('grok');
      if (main && !main.links.includes(agent.id)) main.links.push(agent.id);
    }
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

  if (typeof body.dashboard === 'string' && body.dashboard.trim()) {
    agent.dashboardNote = body.dashboard.trim().slice(0, 300);
    agent.lastDashboardAt = new Date().toISOString();
  }

  if (body.status) agent.status = body.status;
  if (typeof body.now === 'string') agent.now = body.now;
  agent.lastStatusAt = new Date().toISOString();

  if (typeof body.done === 'string' && body.done.trim()) {
    agent.done.unshift(body.done.trim());
    if (agent.done.length > 10) agent.done.length = 10;
  }

  let countedCompletion = false;
  if (body.taskId && typeof body.result === 'string') {
    const task = state.tasks.find((t) => t.id === body.taskId);
    if (task) {
      const before = task.status;
      applyOrderUpdate(task, {
        status: 'done',
        progress: null,
        note: '',
        result: body.result,
      }, { force: true, creditAgent: agent });
      task.result = body.result;
      task.status = 'выполнена';
      if (before !== 'выполнена') {
        countedCompletion = true;
        poryadokSync.schedule();
      }
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

  store.noteAgent(agent);
  await store.flush();
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
      parentId: agent.parentId || null,
      number: agentNumber(agent),
    },
  });
});

app.post('/api/orders/:id', requireAgentToken, async (req, res) => {
  const task = state.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Приказ не найден' });
  try {
    const input = parseOrderUpdate(req.body);
    const result = applyOrderUpdate(task, input);
    if (result.changed && (task.orderStatus === 'done' || task.orderStatus === 'failed')) poryadokSync.schedule();
    await store.flush();
    return res.json({ ok: true, unchanged: !result.changed, task: publicTask(task) });
  } catch (err) {
    const status = err.status || 500;
    if (!err.status) console.error(err);
    return res.status(status).json({ error: err.expose || 'Не удалось обновить приказ' });
  }
});

registerHeartbeat(app, {
  requireAgentToken,
  findAgent,
  orders: () => state.tasks,
  onSeen: async (agent) => {
    store.noteAgent(agent);
    await store.flush();
  },
  activityExtras,
});

// Рутина сообщает старт и финиш. Пока finishedAt пустой, агент не спит,
// даже если старт был раньше окна ACTIVITY_WINDOW_MIN.
app.get('/api/agents/:id/tasks', requireAgentToken, (req, res) => {
  const agent = findAgent(String(req.params.id || ''));
  if (!agent) return res.status(404).json({ error: 'Неизвестный агент' });
  const raw = req.query.status == null || req.query.status === '' ? 'open' : String(req.query.status);
  if (raw !== 'open' && raw !== 'all') {
    return res.status(400).json({ error: 'status должен быть open или all' });
  }
  let tasks = state.tasks.filter((task) => (task.agentId || task.agent) === agent.id);
  if (raw === 'open') tasks = tasks.filter(openTask);
  res.json({ agentId: agent.id, tasks: tasks.map(publicTask) });
});

app.post('/api/agents/:id/routine', requireAgentToken, async (req, res) => {
  const agent = findAgent(String(req.params.id || ''));
  if (!agent) return res.status(404).json({ error: 'Неизвестный агент' });
  if (agent.archived) return res.status(409).json({ error: 'Агент в архиве' });
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  let action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!action && typeof body.status === 'string') {
    const status = body.status.trim();
    if (status === 'active' || status === 'started' || status === 'start') action = 'start';
    else if (status === 'finished' || status === 'finish' || status === 'done') action = 'finish';
  }
  if (action !== 'start' && action !== 'finish') {
    return res.status(400).json({ error: 'action должен быть start или finish' });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 200) {
    return res.status(400).json({ error: 'Слишком длинное имя рутины (максимум 200 символов)' });
  }
  const nowIso = new Date().toISOString();
  let routine;
  if (action === 'start') {
    if (!name) return res.status(400).json({ error: 'Для старта нужно имя рутины' });
    routine = state.routines.find((r) => r.agentId === agent.id && r.name === name && !r.finishedAt);
    if (!routine) {
      routine = {
        id: `r-${state.nextRoutineId++}`,
        agentId: agent.id,
        name,
        startedAt: nowIso,
        finishedAt: null,
      };
      state.routines.unshift(routine);
      if (state.routines.length > 100) {
        const dropped = state.routines.splice(100);
        store.noteRoutinesRemoved(dropped.map((item) => item.id));
      }
    }
  } else {
    const open = state.routines.filter((r) => r.agentId === agent.id && !r.finishedAt && (!name || r.name === name));
    if (!open.length) return res.status(404).json({ error: 'Активная рутина не найдена' });
    for (const item of open) {
      item.finishedAt = nowIso;
      store.noteRoutine(item);
    }
    routine = open[0];
  }
  store.noteRoutine(routine);
  await store.flush();
  const view = activityFor(agent, state.tasks, Date.now(), activeWindowMs(), activityExtras());
  res.json({ ok: true, routine: publicRoutine(routine), ...view });
});

app.get('/needs/:id', (req, res, next) => {
  if (!req.params.id || req.params.id.includes('/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Лимит JSON (1 МБ) и лимит multer (10 МБ) оба должны отвечать JSON, а не HTML-страницей Express.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode);
  if (status === 413 || (err && err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'Файл слишком большой (макс. 10 МБ)' });
  }
  return next(err);
});

const listen = app.listen.bind(app);
app.listen = function listenWithPoryadokSync(...args) {
  const server = listen(...args);
  const start = () => {
    poryadokSync.onListening();
    kickStartupFlush();
  };
  if (server && server.listening) start();
  else if (server && typeof server.once === 'function') {
    server.once('listening', start);
  }
  return server;
};

if (require.main === module) {
  store.ready.then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      store.unrefIdle();
      console.log(`Агенты Москвы (GROK) слушают 0.0.0.0:${PORT}`);
    });
    // Дольше типичной загрузки 10 МБ, но не дольше прокси Render, чтобы зависший сокет не держал процесс.
    server.requestTimeout = 100000;
    server.headersTimeout = 60000;
    server.timeout = 100000;
  });
} else {
  store.ready.then(() => store.unrefIdle());
}

module.exports = {
  app,
  state,
  migrateOwnerNeeds,
  isNeedStale,
  resolveNeedsByEnv,
  staleHours,
  ACADEMY_WHAT,
  ACADEMY_WHERE,
  FINANCE_WHERE,
  ACADEMY_ACTION_URL,
  TEST_NEED_ID,
  TEST_NEED_WHAT,
  QUESTION_NEED_ID,
  QUESTION_NEED_WHAT,
  TEST_REOPEN_MS,
  ANSWERS_MAX,
  reopenTestNeeds,
  FINANCE_ACTION_URL,
  FINANCE_ACTION_HINT,
  SOCIAL_ACTION_URL,
  SOCIAL_ACTION_HINT,
  ACTION_URL_MAX,
  parseKremlinKey,
  kremlinWebhookHeaders,
  formatAtMsk,
  FINANCE_TEXT_NOTE,
};
