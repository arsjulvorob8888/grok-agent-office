'use strict';

// Постоянное хранилище приказов, пунктов «Нужно от вас», переписки и вложений.
// Сервер держит ту же память, что и раньше, и только дописывает изменения сюда,
// чтобы опрос /api/state не ходил в базу. Если DATABASE_URL нет или Postgres
// недоступен при старте, модуль ничего не пишет и процесс живёт как раньше.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { settleRawStatus } = require('./activity');

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

let pool = null;
let dbEnabled = false;
let allowUnref = false;
let uploadDir = '';
let maxMessagesPerAgent = 200;
let maxTasks = 100;
let qual = '"public"';
let nextSeq = 1;
let nextNeedOrd = -1;
let nextOutboxSeq = 1;
let seedAgentIds = new Set();
let settled = false;
let flushChain = Promise.resolve();

const dirtyTasks = new Set();
const dirtyMessages = new Map();
const deletedMessages = new Set();
const dirtyNeeds = new Map();
const dirtyFiles = new Map();
const deletedFiles = new Set();
const dirtyAgents = new Map();
const dirtyRoutines = new Map();
const deletedRoutines = new Set();
const dirtyOutbox = new Map();
const dirtyWebhookTargets = new Map();
const deletedWebhookTargets = new Set();
let dirtyMigrations = null;
let dirtyUsage = null;
const dirtyDecisions = new Map();
const dirtyAgentTokens = new Map();

let readyResolve = () => {};
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});

function finishReady() {
  if (settled) return;
  settled = true;
  readyResolve();
}

function logFallback(kind) {
  if (kind === 'unset') {
    console.log('Хранилище: DATABASE_URL не задан, данные остаются в памяти');
    return;
  }
  console.log('Хранилище: Postgres недоступен, данные остаются в памяти');
}

function quoteIdent(name) {
  if (!SCHEMA_RE.test(name)) throw new Error('bad identifier');
  return `"${name}"`;
}

function chooseSchema() {
  const explicit = typeof process.env.STORE_SCHEMA === 'string' ? process.env.STORE_SCHEMA.trim() : '';
  if (explicit) {
    if (!SCHEMA_RE.test(explicit)) throw new Error('bad schema');
    return explicit;
  }
  if (process.env.NODE_TEST_CONTEXT) return `t_${process.pid}`;
  return 'public';
}

function sslModeOf(connectionString) {
  try {
    return (new URL(connectionString).searchParams.get('sslmode') || '').toLowerCase();
  } catch (_) {
    const match = /(?:\?|&)sslmode=([^&]*)/i.exec(connectionString);
    return match ? decodeURIComponent(match[1]).toLowerCase() : '';
  }
}

// sslmode убираем из строки и задаём ssl сами: парсер pg для require пишет
// предупреждение и включает проверку сертификата, а Neon-строка с sslmode=require
// должна просто шифровать канал (как libpq). verify-full и verify-ca проверяют сертификат.
function connectionConfig(connectionString) {
  const mode = sslModeOf(connectionString);
  let stripped = connectionString;
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('uselibpqcompat');
    stripped = url.toString();
  } catch (_) { /* оставляем исходную строку, в лог её не пишем */ }
  const cfg = {
    connectionString: stripped,
    max: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    keepAlive: true,
  };
  if (mode === 'disable') cfg.ssl = false;
  else if (mode === 'verify-full' || mode === 'verify-ca') cfg.ssl = { rejectUnauthorized: true };
  else if (mode) cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}

function unrefClient(client) {
  const stream = client && client.connection && client.connection.stream;
  if (stream && typeof stream.unref === 'function') stream.unref();
}

// Сокеты базы не должны держать процесс после закрытия HTTP-сервера в тестах.
// До listen их не отпускаем, иначе процесс может выйти во время стартовой загрузки.
function unrefIdle() {
  allowUnref = true;
  if (!pool) return;
  for (const client of pool._clients || []) unrefClient(client);
}

function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return String(value);
  return new Date(parsed).toISOString();
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cmpMessage(a, b) {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function table(name) {
  return `${qual}.${name}`;
}

async function migrate(client, schema) {
  const orders = table('orders');
  const needs = table('needs');
  const messages = table('messages');
  const files = table('files');
  const version = table('schema_version');
  await client.query(`CREATE TABLE IF NOT EXISTS ${version} (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const found = await client.query(`SELECT version FROM ${version}`);
  const have = new Set(found.rows.map((row) => row.version));
  if (!have.has(1)) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${orders} (
    id text PRIMARY KEY,
    seq bigint NOT NULL,
    agent text NOT NULL,
    agent_id text,
    from_agent_id text,
    parent_order_id text,
    body text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT '',
    order_status text NOT NULL DEFAULT 'sent',
    progress integer,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL,
    forward_status integer,
    forward_error text,
    result text,
    message_id text,
    history jsonb NOT NULL DEFAULT '[]'::jsonb,
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${needs} (
    id text PRIMARY KEY,
    ord integer NOT NULL,
    what text NOT NULL,
    from_agent_id text NOT NULL,
    place text NOT NULL,
    urgency text NOT NULL,
    created_at timestamptz NOT NULL,
    closed_at timestamptz
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${messages} (
    id text PRIMARY KEY,
    agent_id text NOT NULL,
    role text NOT NULL,
    body text NOT NULL DEFAULT '',
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL,
    source text NOT NULL,
    task_id text
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${files} (
    id text PRIMARY KEY,
    name text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    stored_name text NOT NULL,
    created_at_ms bigint NOT NULL,
    bytes bytea NOT NULL
  )`);
  // Имя индекса не квалифицируется в этой версии Postgres: создаём его в search_path схемы.
  await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
  await client.query(`CREATE INDEX IF NOT EXISTS orders_seq_idx ON orders (seq DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS messages_agent_idx ON messages (agent_id, created_at)`);
  await client.query(
    `INSERT INTO ${version} (version) VALUES (1) ON CONFLICT (version) DO NOTHING`,
  );
  }
  if (!have.has(2)) {
    await client.query(`ALTER TABLE ${orders} ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE ${needs} ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE ${messages} ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('agent_state')} (
      id text PRIMARY KEY,
      archived boolean NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (2) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(3)) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('routines')} (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      name text NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz
    )`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (3) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(4)) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('app_state')} (
      key text PRIMARY KEY,
      value jsonb NOT NULL
    )`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (4) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(5)) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('outbox')} (
      id text PRIMARY KEY,
      seq bigint NOT NULL,
      created_at timestamptz NOT NULL,
      agent_id text NOT NULL,
      task_id text,
      status text NOT NULL,
      last_error text,
      attempts integer NOT NULL DEFAULT 0,
      last_attempt_at timestamptz,
      last_status integer,
      delivered_at timestamptz,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (5) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(6)) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('webhook_targets')} (
      id text PRIMARY KEY,
      iv text NOT NULL,
      tag text NOT NULL,
      ciphertext text NOT NULL,
      updated_at timestamptz NOT NULL
    )`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (6) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(7)) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('decisions')} (
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      need_id text NOT NULL,
      what text NOT NULL,
      answer text NOT NULL,
      from_agent_id text NOT NULL,
      source text NOT NULL
    )`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (7) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(8)) {
    await client.query(`ALTER TABLE ${table('outbox')} ADD COLUMN IF NOT EXISTS locked_at timestamptz`);
    await client.query(
      `INSERT INTO ${version} (version) VALUES (8) ON CONFLICT (version) DO NOTHING`,
    );
  }
  if (!have.has(9)) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table('agent_tokens')} (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      token_hash text NOT NULL,
      created_at timestamptz NOT NULL,
      revoked_at timestamptz
    )`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS agent_tokens_hash_idx ON ${table('agent_tokens')} (token_hash)`,
    );
    await client.query(
      `INSERT INTO ${version} (version) VALUES (9) ON CONFLICT (version) DO NOTHING`,
    );
  }
}

const TASK_KEYS = new Set(['id', 'seq', 'agent', 'agentId', 'fromAgentId', 'parentOrderId', 'text', 'status', 'orderStatus', 'progress', 'note', 'createdAt', 'forwardStatus', 'forwardError', 'result', 'messageId', 'history', 'attachments', 'extra']);
const NEED_KEYS = new Set(['id', 'ord', 'what', 'fromAgentId', 'where', 'urgency', 'createdAt', 'closedAt', 'extra', 'answering']);
const MESSAGE_KEYS = new Set(['id', 'agentId', 'role', 'text', 'attachments', 'createdAt', 'source', 'taskId', 'extra']);

function missingSeeds(existingIds, seeds) {
  const have = new Set(existingIds || []);
  const seen = new Set();
  const missing = [];
  for (const item of seeds || []) {
    if (!item || item.id == null || item.id === '') continue;
    const id = String(item.id);
    if (have.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(item);
  }
  return missing;
}

function extrasOf(obj, known) {
  const extra = {};
  if (!obj || typeof obj !== 'object') return extra;
  for (const key of Object.keys(obj)) {
    if (known.has(key) || obj[key] === undefined) continue;
    extra[key] = obj[key];
  }
  return extra;
}

function applyExtra(target, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return target;
  for (const [key, value] of Object.entries(extra)) {
    if (target[key] === undefined) target[key] = value;
  }
  return target;
}

function runtimeOf(agent) {
  const runtime = {};
  if (typeof agent.status === 'string') runtime.status = agent.status;
  if (typeof agent.now === 'string') runtime.now = agent.now;
  if (Array.isArray(agent.done)) runtime.done = agent.done.slice();
  runtime.completed = Number.isFinite(Number(agent.completed)) ? Number(agent.completed) : 0;
  if (agent.lastSeenAt) runtime.lastSeenAt = agent.lastSeenAt;
  if (typeof agent.heartbeatNote === 'string' && agent.heartbeatNote) runtime.heartbeatNote = agent.heartbeatNote;
  if (agent.lastStatusAt) runtime.lastStatusAt = agent.lastStatusAt;
  if (agent.lastDashboardAt) runtime.lastDashboardAt = agent.lastDashboardAt;
  if (typeof agent.dashboardNote === 'string' && agent.dashboardNote) runtime.dashboardNote = agent.dashboardNote;
  if (agent.analysis !== undefined) runtime.analysis = agent.analysis;
  return runtime;
}

function agentPayload(agent) {
  return {
    id: agent.id,
    name: agent.name,
    color: agent.color,
    accent: agent.accent,
    role: agent.role,
    district: agent.district || '',
    kind: agent.kind || 'generic',
    tier: agent.tier || 'dept',
    parentId: agent.parentId || null,
    order: agent.order || 0,
    x: agent.x,
    y: agent.y,
    links: Array.isArray(agent.links) ? agent.links.slice() : [],
    status: agent.status,
    now: agent.now,
    done: Array.isArray(agent.done) ? agent.done.slice() : [],
    completed: agent.completed || 0,
    responsibilities: Array.isArray(agent.responsibilities) ? agent.responsibilities.slice() : [],
    vacant: !!agent.vacant,
    archived: !!agent.archived,
    lastSeenAt: agent.lastSeenAt || null,
    heartbeatNote: agent.heartbeatNote || '',
    lastStatusAt: agent.lastStatusAt || null,
    lastDashboardAt: agent.lastDashboardAt || null,
    dashboardNote: agent.dashboardNote || '',
    ...(agent.analysis !== undefined ? { analysis: agent.analysis } : {}),
  };
}

let seededFromEmpty = false;
const needHooks = [];

function withNeeds(fn) {
  if (typeof fn === 'function') needHooks.push(fn);
}

async function ensureNeeds(client, seeds) {
  const needs = table('needs');
  const count = await client.query(`SELECT COUNT(*)::int AS n FROM ${needs}`);
  // Посев только в пустую таблицу. need-render-api и need-academy не возвращаются,
  // если в таблице уже есть строки и этих id там нет.
  if ((count.rows[0] && count.rows[0].n) > 0) {
    seededFromEmpty = false;
    return;
  }
  seededFromEmpty = true;
  const list = (seeds || []).filter((item) => item && item.id && item.id !== 'need-render-api' && item.id !== 'need-academy');
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    await client.query(
      `INSERT INTO ${needs} (id, ord, what, from_agent_id, place, urgency, created_at, closed_at, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [item.id, i, item.what, item.fromAgentId, item.where, item.urgency, item.createdAt, item.closedAt, JSON.stringify(extrasOf(item, NEED_KEYS))],
    );
  }
}

async function runNeedHooks(state) {
  for (const fn of needHooks) {
    try { fn(state.needs); } catch (_) { console.log('Хранилище: миграция пунктов не выполнена'); }
  }
  if (!dbEnabled) return;
  for (const item of state.needs) noteNeed(item);
  await flush();
}

function rowToTask(row) {
  return applyExtra({
    id: row.id,
    seq: num(row.seq),
    agent: row.agent,
    agentId: row.agent_id || row.agent,
    fromAgentId: row.from_agent_id || null,
    parentOrderId: row.parent_order_id || null,
    text: row.body || '',
    status: row.status || '',
    orderStatus: row.order_status || 'sent',
    progress: row.progress == null ? null : num(row.progress),
    note: row.note || '',
    createdAt: toIso(row.created_at),
    forwardStatus: row.forward_status == null ? null : num(row.forward_status),
    forwardError: row.forward_error || undefined,
    result: row.result == null ? null : row.result,
    messageId: row.message_id || '',
    history: Array.isArray(row.history) ? row.history : [],
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }, row.extra);
}

function rowToMessage(row) {
  return applyExtra({
    id: row.id,
    agentId: row.agent_id,
    role: row.role,
    text: row.body || '',
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    createdAt: toIso(row.created_at),
    source: row.source || 'relay',
    taskId: row.task_id || null,
  }, row.extra);
}

function rowToNeed(row) {
  return applyExtra({
    id: row.id,
    ord: num(row.ord),
    what: row.what,
    fromAgentId: row.from_agent_id,
    where: row.place,
    urgency: row.urgency,
    createdAt: toIso(row.created_at),
    closedAt: toIso(row.closed_at),
  }, row.extra);
}

function rowToOutbox(row) {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
  const lastStatus = num(row.last_status);
  return {
    id: row.id,
    seq: num(row.seq),
    at: toIso(row.created_at),
    agentId: row.agent_id,
    taskId: row.task_id || null,
    status: row.status === 'delivered' || row.status === 'sending' || row.status === 'cancelled' ? row.status : 'queued',
    lockedAt: row.locked_at ? toIso(row.locked_at) : null,
    lastError: row.last_error || null,
    attempts: num(row.attempts) || 0,
    lastAttemptAt: row.last_attempt_at ? toIso(row.last_attempt_at) : null,
    lastStatus: lastStatus != null && lastStatus > 0 ? lastStatus : null,
    deliveredAt: row.delivered_at ? toIso(row.delivered_at) : null,
    payload,
  };
}

function rowToFile(row) {
  const bytes = asBuffer(row.bytes) || Buffer.alloc(0);
  return {
    id: row.id,
    name: row.name,
    mime: row.mime || 'application/octet-stream',
    size: num(row.size) ?? bytes.length,
    storedName: row.stored_name,
    createdAtMs: num(row.created_at_ms) || 0,
    url: `/api/files/${row.id}`,
    bytes,
  };
}

async function readAll(client) {
  const orders = table('orders');
  const needs = table('needs');
  const messages = table('messages');
  const files = table('files');
  // Один клиент пула не выполняет запросы параллельно.
  const taskRows = await client.query(
    `SELECT id, seq, agent, agent_id, from_agent_id, parent_order_id, body, status,
            order_status, progress, note, created_at, forward_status, forward_error,
            result, message_id, history, attachments, extra
     FROM ${orders}
     ORDER BY seq DESC
     LIMIT $1`,
    [maxTasks],
  );
  const idRows = await client.query(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq,
            COALESCE(MAX(CAST(substring(id from '^t-([0-9]+)$') AS bigint)), 0) AS max_id
     FROM ${orders}`,
  );
  const needRows = await client.query(
    `SELECT id, ord, what, from_agent_id, place, urgency, created_at, closed_at, extra
     FROM ${needs}
     ORDER BY ord ASC`,
  );
  const messageRows = await client.query(
    `SELECT id, agent_id, role, body, attachments, created_at, source, task_id, extra
     FROM ${messages}
     ORDER BY created_at ASC, id ASC`,
  );
  const messageIdRows = await client.query(
    `SELECT COALESCE(MAX(CAST(substring(id from '^m-([0-9]+)$') AS bigint)), 0) AS max_id
     FROM ${messages}`,
  );
  const needIdRows = await client.query(
    `SELECT COALESCE(MAX(CAST(substring(id from '^n-([0-9]+)$') AS bigint)), 0) AS max_id,
            COALESCE(MIN(ord), 0) AS min_ord
     FROM ${needs}`,
  );
  const fileRows = await client.query(
    `SELECT id, name, mime, size, stored_name, created_at_ms, bytes FROM ${files}`,
  );
  const routineRows = await client.query(
    `SELECT id, agent_id, name, started_at, finished_at
     FROM ${table('routines')}
     ORDER BY started_at DESC
     LIMIT 100`,
  );
  const routineIdRows = await client.query(
    `SELECT COALESCE(MAX(CAST(substring(id from '^r-([0-9]+)$') AS bigint)), 0) AS max_id
     FROM ${table('routines')}`,
  );
  const outboxRows = await client.query(
    `SELECT id, seq, created_at, agent_id, task_id, status, last_error, attempts,
            last_attempt_at, last_status, delivered_at, payload, locked_at
     FROM ${table('outbox')}
     ORDER BY created_at ASC, id ASC`,
  );
  const outboxIdRows = await client.query(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq,
            COALESCE(MAX(CAST(substring(id from '^ob-([0-9]+)$') AS bigint)), 0) AS max_id
     FROM ${table('outbox')}`,
  );
  const webhookRows = await client.query(
    `SELECT id, iv, tag, ciphertext, updated_at FROM ${table('webhook_targets')}`,
  );
  const decisionRows = await client.query(
    `SELECT id, at, need_id, what, answer, from_agent_id, source
     FROM ${table('decisions')}
     ORDER BY at ASC, id ASC`,
  );
  const decisionIdRows = await client.query(
    `SELECT COALESCE(MAX(CAST(substring(id from '^dec-([0-9]+)$') AS bigint)), 0) AS max_id
     FROM ${table('decisions')}`,
  );
  const tokenRows = await client.query(
    `SELECT id, agent_id, token_hash, created_at, revoked_at
     FROM ${table('agent_tokens')}
     ORDER BY created_at ASC, id ASC`,
  );
  return {
    tasks: taskRows.rows.map(rowToTask),
    maxSeq: num(idRows.rows[0].max_seq) || 0,
    maxTaskId: num(idRows.rows[0].max_id) || 0,
    needs: needRows.rows.map(rowToNeed),
    messages: messageRows.rows.map(rowToMessage),
    maxMessageId: num(messageIdRows.rows[0].max_id) || 0,
    maxNeedId: num(needIdRows.rows[0].max_id) || 0,
    minNeedOrd: num(needIdRows.rows[0].min_ord) || 0,
    files: fileRows.rows.map(rowToFile),
    routines: routineRows.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      startedAt: toIso(row.started_at),
      finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    })),
    maxRoutineId: num(routineIdRows.rows[0].max_id) || 0,
    outbox: outboxRows.rows.map(rowToOutbox),
    maxOutboxSeq: num(outboxIdRows.rows[0].max_seq) || 0,
    maxOutboxId: num(outboxIdRows.rows[0].max_id) || 0,
    webhookTargets: webhookRows.rows.map(rowToWebhookTarget),
    decisions: decisionRows.rows.map(rowToDecision),
    maxDecisionId: num(decisionIdRows.rows[0].max_id) || 0,
    agentTokens: tokenRows.rows.map(rowToAgentToken),
  };
}

function rowToAgentToken(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    tokenHash: row.token_hash,
    createdAt: toIso(row.created_at),
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
  };
}

function rowToDecision(row) {
  return {
    id: row.id,
    at: toIso(row.at),
    needId: row.need_id,
    what: row.what,
    answer: row.answer,
    fromAgentId: row.from_agent_id || '',
    source: row.source || 'сайт',
  };
}

function rowToWebhookTarget(row) {
  return {
    id: row.id,
    iv: row.iv,
    tag: row.tag,
    ciphertext: row.ciphertext,
    updatedAt: toIso(row.updated_at),
  };
}

function capMessages(messages) {
  const byAgent = new Map();
  const sorted = [...messages].sort(cmpMessage);
  for (const message of sorted) {
    if (!byAgent.has(message.agentId)) byAgent.set(message.agentId, []);
    byAgent.get(message.agentId).push(message);
  }
  const keep = [];
  const drop = [];
  for (const list of byAgent.values()) {
    const overflow = list.length - maxMessagesPerAgent;
    if (overflow > 0) drop.push(...list.slice(0, overflow).map((message) => message.id));
    keep.push(...list.slice(Math.max(0, overflow)));
  }
  keep.sort(cmpMessage);
  return { keep, drop };
}

function applyLoaded(state, loaded) {
  const capped = capMessages(loaded.messages);
  state.tasks.length = 0;
  for (const task of loaded.tasks) state.tasks.push(task);
  state.messages.length = 0;
  for (const message of capped.keep) state.messages.push(message);
  state.needs.length = 0;
  for (const item of loaded.needs) state.needs.push(item);
  state.files.clear();
  for (const file of loaded.files) state.files.set(file.id, file);
  state.nextTaskId = loaded.maxTaskId + 1;
  state.nextMessageId = loaded.maxMessageId + 1;
  state.nextNeedId = loaded.maxNeedId + 1;
  if (Array.isArray(state.routines) && Array.isArray(loaded.routines)) {
    state.routines.length = 0;
    for (const item of loaded.routines) state.routines.push(item);
    state.nextRoutineId = loaded.maxRoutineId + 1;
  }
  if (!Array.isArray(state.outbox)) state.outbox = [];
  state.outbox.length = 0;
  for (const item of loaded.outbox || []) state.outbox.push(item);
  state.webhookTargets = {};
  for (const row of loaded.webhookTargets || []) {
    if (!row || !row.id) continue;
    state.webhookTargets[row.id] = row;
  }
  state.nextOutboxId = (loaded.maxOutboxId || 0) + 1;
  if (!Array.isArray(state.decisions)) state.decisions = [];
  state.decisions.length = 0;
  for (const row of loaded.decisions || []) state.decisions.push(row);
  if (!Array.isArray(state.agentTokens)) state.agentTokens = [];
  state.agentTokens.length = 0;
  for (const row of loaded.agentTokens || []) state.agentTokens.push(row);
  state.nextDecisionId = (loaded.maxDecisionId || 0) + 1;
  nextOutboxSeq = (loaded.maxOutboxSeq || 0) + 1;
  nextSeq = loaded.maxSeq + 1;
  nextNeedOrd = loaded.minNeedOrd < 0 ? loaded.minNeedOrd - 1 : -1;
  for (const agent of loaded.dynamicAgents || []) {
    if (state.agents.some((item) => item.id === agent.id)) continue;
    state.agents.push(agent);
    const parent = agent.parentId ? state.agents.find((item) => item.id === agent.parentId) : state.agents.find((item) => item.id === 'grok');
    if (parent && Array.isArray(parent.links) && !parent.links.includes(agent.id)) parent.links.push(agent.id);
  }
  return capped.drop;
}

async function syncAgents(client, state) {
  const rows = await client.query(`SELECT id, archived, payload FROM ${table('agent_state')}`);
  const restored = [];
  for (const row of rows.rows) {
    const stored = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
    if (seedAgentIds.has(row.id)) {
      const agent = state.agents.find((item) => item.id === row.id);
      // Имя, место, archived и grokAgentId остаются из кода ростера.
      // Из payload сюда попадают только занятость, пульс, дашборд и analysis.
      if (agent) {
        if (typeof stored.status === 'string' && stored.status) agent.status = stored.status;
        if (typeof stored.now === 'string') agent.now = stored.now;
        if (Array.isArray(stored.done)) agent.done = stored.done.slice();
        if (stored.completed != null && Number.isFinite(Number(stored.completed))) agent.completed = Number(stored.completed);
        if (stored.lastSeenAt) agent.lastSeenAt = stored.lastSeenAt;
        if (typeof stored.heartbeatNote === 'string' && stored.heartbeatNote) agent.heartbeatNote = stored.heartbeatNote;
        if (stored.lastStatusAt) agent.lastStatusAt = stored.lastStatusAt;
        if (stored.lastDashboardAt) agent.lastDashboardAt = stored.lastDashboardAt;
        if (typeof stored.dashboardNote === 'string' && stored.dashboardNote) agent.dashboardNote = stored.dashboardNote;
        if (stored.analysis !== undefined) agent.analysis = stored.analysis;
      }
      continue;
    }
    if (state.agents.some((agent) => agent.id === row.id)) continue;
    const payload = { ...stored };
    if (!payload.id) continue;
    payload.archived = !!row.archived;
    payload.links = Array.isArray(payload.links) ? payload.links.slice() : [];
    payload.done = Array.isArray(payload.done) ? payload.done.slice() : [];
    payload.responsibilities = Array.isArray(payload.responsibilities) ? payload.responsibilities.slice() : [];
    restored.push(payload);
  }
  settleRawStatus(state.agents, Date.now());
  for (const agent of state.agents) {
    if (!seedAgentIds.has(agent.id)) continue;
    await client.query(
      `INSERT INTO ${table('agent_state')} (id, archived, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET archived = EXCLUDED.archived, payload = EXCLUDED.payload`,
      [agent.id, !!agent.archived, JSON.stringify(runtimeOf(agent))],
    );
  }
  return restored;
}

async function connectAndLoad(state, connectionString) {
  const schema = chooseSchema();
  qual = quoteIdent(schema);
  pool = new Pool(connectionConfig(connectionString));
  pool.on('error', () => {
    if (!dbEnabled) return;
    console.log('Хранилище: ошибка соединения Postgres');
  });
  pool.on('connect', (client) => {
    if (allowUnref) unrefClient(client);
  });
  const client = await pool.connect();
  let droppedMessageIds = [];
  try {
    await client.query('BEGIN');
    if (schema !== 'public') await client.query(`CREATE SCHEMA IF NOT EXISTS ${qual}`);
    await migrate(client, schema);
    await ensureNeeds(client, state.needs.map((item) => ({ ...item })));
    await client.query(
      `UPDATE ${table('outbox')}
       SET status = 'queued', locked_at = NULL
       WHERE status = 'sending'
         AND (locked_at IS NULL OR locked_at < now() - interval '60 seconds')`,
    );
    const loaded = await readAll(client);
    const capped = capMessages(loaded.messages);
    droppedMessageIds = capped.drop;
    if (droppedMessageIds.length) {
      await client.query(`DELETE FROM ${table('messages')} WHERE id = ANY($1::text[])`, [droppedMessageIds]);
    }
    const dynamicAgents = await syncAgents(client, state);
    const migrationRows = await client.query(
      `SELECT value FROM ${table('app_state')} WHERE key = 'migrations'`,
    );
    const usageRows = await client.query(
      `SELECT value FROM ${table('app_state')} WHERE key = 'grokUsage'`,
    );
    await client.query('COMMIT');
    loaded.messages = capped.keep;
    loaded.dynamicAgents = dynamicAgents;
    applyLoaded(state, loaded);
    const savedMigrations = migrationRows.rows[0] && migrationRows.rows[0].value;
    if (savedMigrations && typeof savedMigrations === 'object' && !Array.isArray(savedMigrations)) {
      state.migrations = savedMigrations;
    } else if (state.migrations && typeof state.migrations === 'object') {
      state.migrations.financeTextReopen = false;
    }
    const savedUsage = usageRows.rows[0] && usageRows.rows[0].value;
    if (savedUsage && typeof savedUsage === 'object' && !Array.isArray(savedUsage)) {
      state.grokUsage = {
        latest: savedUsage.latest && typeof savedUsage.latest === 'object' ? savedUsage.latest : null,
        history: Array.isArray(savedUsage.history) ? savedUsage.history : [],
      };
    }
    dbEnabled = true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* транзакция уже закрыта */ }
    throw err;
  } finally {
    client.release();
  }
  if (dbEnabled) {
    await runNeedHooks(state);
    console.log('Хранилище: Postgres подключен');
  }
}

async function shutdownPool() {
  const current = pool;
  pool = null;
  dbEnabled = false;
  if (!current) return;
  try { await current.end(); } catch (_) { /* соединение и так не открылось */ }
}

function init(state, options = {}) {
  uploadDir = options.uploadDir || uploadDir;
  if (Array.isArray(options.seedAgentIds) && options.seedAgentIds.length) {
    seedAgentIds = new Set(options.seedAgentIds);
  } else {
    seedAgentIds = new Set(state.agents.map((agent) => agent.id));
  }
  if (Number.isInteger(options.maxMessagesPerAgent)) maxMessagesPerAgent = options.maxMessagesPerAgent;
  if (Number.isInteger(options.maxTasks) && options.maxTasks > 0) maxTasks = options.maxTasks;
  const url = typeof process.env.DATABASE_URL === 'string' ? process.env.DATABASE_URL.trim() : '';
  (async () => {
    try {
      if (!url) {
        logFallback('unset');
        await runNeedHooks(state);
        return;
      }
      await connectAndLoad(state, url);
    } catch (_) {
      await shutdownPool();
      logFallback('down');
      await runNeedHooks(state);
    } finally {
      finishReady();
    }
  })();
}

function enabled() {
  return dbEnabled;
}

function noteTask(task) {
  if (!dbEnabled || !task) return;
  if (task.seq == null) task.seq = nextSeq++;
  dirtyTasks.add(task);
}

function noteMessage(message) {
  if (!dbEnabled || !message) return;
  dirtyMessages.set(message.id, message);
  deletedMessages.delete(message.id);
}

function noteMessagesRemoved(ids) {
  if (!dbEnabled) return;
  for (const id of ids || []) {
    deletedMessages.add(id);
    dirtyMessages.delete(id);
  }
}

function noteNeed(item) {
  if (!dbEnabled || !item) return;
  if (item.ord == null) item.ord = nextNeedOrd--;
  dirtyNeeds.set(item.id, item);
}

function noteFile(rec) {
  if (!dbEnabled || !rec) return;
  if (!Buffer.isBuffer(rec.bytes)) {
    try {
      rec.bytes = fs.readFileSync(path.join(uploadDir, rec.storedName));
    } catch (_) {
      rec.bytes = null;
    }
  }
  if (!Buffer.isBuffer(rec.bytes)) return;
  dirtyFiles.set(rec.id, rec);
  deletedFiles.delete(rec.id);
}

function noteAgent(agent) {
  if (!dbEnabled || !agent || !agent.id) return;
  dirtyAgents.set(agent.id, agent);
}

function noteMigrations(flags) {
  if (!dbEnabled || !flags || typeof flags !== 'object') return;
  dirtyMigrations = flags;
}

function noteGrokUsage(record) {
  if (!dbEnabled || !record || typeof record !== 'object') return;
  dirtyUsage = {
    latest: record.latest || null,
    history: Array.isArray(record.history) ? record.history.slice() : [],
  };
}

function noteRoutine(item) {
  if (!dbEnabled || !item || !item.id) return;
  dirtyRoutines.set(item.id, item);
  deletedRoutines.delete(item.id);
}

function noteRoutinesRemoved(ids) {
  if (!dbEnabled) return;
  for (const id of ids || []) {
    if (!id) continue;
    deletedRoutines.add(id);
    dirtyRoutines.delete(id);
  }
}

function noteOutbox(item) {
  if (!dbEnabled || !item || !item.id) return;
  if (item.seq == null) item.seq = nextOutboxSeq++;
  dirtyOutbox.set(item.id, item);
}

function noteWebhookTarget(record) {
  if (!dbEnabled || !record || !record.id) return;
  dirtyWebhookTargets.set(record.id, record);
  deletedWebhookTargets.delete(record.id);
}

function noteWebhookTargetRemoved(id) {
  if (!dbEnabled || !id) return;
  deletedWebhookTargets.add(id);
  dirtyWebhookTargets.delete(id);
}

function noteDecision(row) {
  if (!dbEnabled || !row || !row.id) return;
  dirtyDecisions.set(row.id, row);
}

function noteAgentToken(row) {
  if (!dbEnabled || !row || !row.id) return;
  dirtyAgentTokens.set(row.id, {
    id: row.id,
    agentId: row.agentId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt || null,
  });
}

function noteFilesRemoved(ids) {
  if (!dbEnabled) return;
  for (const id of ids || []) {
    if (!id) continue;
    deletedFiles.add(id);
    dirtyFiles.delete(id);
  }
}

function takeBatch() {
  const tasks = [...dirtyTasks];
  dirtyTasks.clear();
  const messages = [...dirtyMessages.values()].filter((message) => !deletedMessages.has(message.id));
  dirtyMessages.clear();
  const dropMessages = [...deletedMessages];
  deletedMessages.clear();
  const needs = [...dirtyNeeds.values()];
  dirtyNeeds.clear();
  const files = [...dirtyFiles.values()].filter((file) => !deletedFiles.has(file.id));
  dirtyFiles.clear();
  const dropFiles = [...deletedFiles];
  deletedFiles.clear();
  const agents = [...dirtyAgents.values()];
  dirtyAgents.clear();
  const routines = [...dirtyRoutines.values()].filter((item) => !deletedRoutines.has(item.id));
  dirtyRoutines.clear();
  const dropRoutines = [...deletedRoutines];
  deletedRoutines.clear();
  const outbox = [...dirtyOutbox.values()];
  dirtyOutbox.clear();
  const webhookTargets = [...dirtyWebhookTargets.values()];
  dirtyWebhookTargets.clear();
  const dropWebhookTargets = [...deletedWebhookTargets];
  deletedWebhookTargets.clear();
  const migrations = dirtyMigrations;
  dirtyMigrations = null;
  const grokUsage = dirtyUsage;
  dirtyUsage = null;
  const decisions = [...dirtyDecisions.values()];
  dirtyDecisions.clear();
  const agentTokens = [...dirtyAgentTokens.values()];
  dirtyAgentTokens.clear();
  return {
    tasks, messages, dropMessages, needs, files, dropFiles, agents, routines, dropRoutines,
    outbox, webhookTargets, dropWebhookTargets, migrations, grokUsage, decisions, agentTokens,
  };
}

function batchEmpty(batch) {
  return !batch.tasks.length && !batch.messages.length && !batch.dropMessages.length
    && !batch.needs.length && !batch.files.length && !batch.dropFiles.length
    && !(batch.agents && batch.agents.length)
    && !(batch.routines && batch.routines.length)
    && !(batch.dropRoutines && batch.dropRoutines.length)
    && !(batch.outbox && batch.outbox.length)
    && !(batch.webhookTargets && batch.webhookTargets.length)
    && !(batch.dropWebhookTargets && batch.dropWebhookTargets.length)
    && !batch.migrations
    && !batch.grokUsage
    && !(batch.decisions && batch.decisions.length)
    && !(batch.agentTokens && batch.agentTokens.length);
}

function restoreBatch(batch) {
  for (const task of batch.tasks) dirtyTasks.add(task);
  for (const message of batch.messages) dirtyMessages.set(message.id, message);
  for (const id of batch.dropMessages) deletedMessages.add(id);
  for (const item of batch.needs) dirtyNeeds.set(item.id, item);
  for (const file of batch.files) dirtyFiles.set(file.id, file);
  for (const id of batch.dropFiles) deletedFiles.add(id);
  for (const agent of batch.agents || []) dirtyAgents.set(agent.id, agent);
  for (const item of batch.routines || []) dirtyRoutines.set(item.id, item);
  for (const id of batch.dropRoutines || []) deletedRoutines.add(id);
  for (const item of batch.outbox || []) dirtyOutbox.set(item.id, item);
  for (const item of batch.webhookTargets || []) dirtyWebhookTargets.set(item.id, item);
  for (const id of batch.dropWebhookTargets || []) deletedWebhookTargets.add(id);
  if (batch.migrations) dirtyMigrations = batch.migrations;
  if (batch.grokUsage) dirtyUsage = batch.grokUsage;
  for (const row of batch.decisions || []) dirtyDecisions.set(row.id, row);
  for (const row of batch.agentTokens || []) dirtyAgentTokens.set(row.id, row);
}

async function writeBatch(batch) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const task of batch.tasks) {
      const progress = Number.isInteger(task.progress) ? task.progress : null;
      const forwardStatus = Number.isInteger(task.forwardStatus) ? task.forwardStatus : null;
      await client.query(
        `INSERT INTO ${table('orders')} (
           id, seq, agent, agent_id, from_agent_id, parent_order_id, body, status,
           order_status, progress, note, created_at, forward_status, forward_error,
           result, message_id, history, attachments, extra
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14,
           $15, $16, $17::jsonb, $18::jsonb, $19::jsonb
         )
         ON CONFLICT (id) DO UPDATE SET
           agent = EXCLUDED.agent,
           agent_id = EXCLUDED.agent_id,
           from_agent_id = EXCLUDED.from_agent_id,
           parent_order_id = EXCLUDED.parent_order_id,
           body = EXCLUDED.body,
           status = EXCLUDED.status,
           order_status = EXCLUDED.order_status,
           progress = EXCLUDED.progress,
           note = EXCLUDED.note,
           created_at = EXCLUDED.created_at,
           forward_status = EXCLUDED.forward_status,
           forward_error = EXCLUDED.forward_error,
           result = EXCLUDED.result,
           message_id = EXCLUDED.message_id,
           history = EXCLUDED.history,
           attachments = EXCLUDED.attachments,
           extra = EXCLUDED.extra`,
        [
          task.id,
          task.seq,
          task.agent,
          task.agentId || task.agent,
          task.fromAgentId || null,
          task.parentOrderId || null,
          task.text || '',
          task.status || '',
          task.orderStatus || 'sent',
          progress,
          task.note || '',
          task.createdAt,
          forwardStatus,
          task.forwardError || null,
          task.result == null ? null : task.result,
          task.messageId || null,
          JSON.stringify(task.history || []),
          JSON.stringify(task.attachments || []),
          JSON.stringify(extrasOf(task, TASK_KEYS)),
        ],
      );
    }
    for (const message of batch.messages) {
      await client.query(
        `INSERT INTO ${table('messages')} (id, agent_id, role, body, attachments, created_at, source, task_id, extra)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id,
           role = EXCLUDED.role,
           body = EXCLUDED.body,
           attachments = EXCLUDED.attachments,
           created_at = EXCLUDED.created_at,
           source = EXCLUDED.source,
           task_id = EXCLUDED.task_id,
           extra = EXCLUDED.extra`,
        [
          message.id,
          message.agentId,
          message.role,
          message.text || '',
          JSON.stringify(message.attachments || []),
          message.createdAt,
          message.source || 'relay',
          message.taskId || null,
          JSON.stringify(extrasOf(message, MESSAGE_KEYS)),
        ],
      );
    }
    if (batch.dropMessages.length) {
      await client.query(`DELETE FROM ${table('messages')} WHERE id = ANY($1::text[])`, [batch.dropMessages]);
    }
    for (const item of batch.needs) {
      await client.query(
        `INSERT INTO ${table('needs')} (id, ord, what, from_agent_id, place, urgency, created_at, closed_at, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           what = EXCLUDED.what,
           from_agent_id = EXCLUDED.from_agent_id,
           place = EXCLUDED.place,
           urgency = EXCLUDED.urgency,
           created_at = EXCLUDED.created_at,
           closed_at = EXCLUDED.closed_at,
           extra = EXCLUDED.extra`,
        [
          item.id,
          item.ord,
          item.what,
          item.fromAgentId,
          item.where,
          item.urgency,
          item.createdAt,
          item.closedAt || null,
          JSON.stringify(extrasOf(item, NEED_KEYS)),
        ],
      );
    }
    for (const file of batch.files) {
      const bytes = asBuffer(file.bytes);
      if (!bytes) continue;
      await client.query(
        `INSERT INTO ${table('files')} (id, name, mime, size, stored_name, created_at_ms, bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           mime = EXCLUDED.mime,
           size = EXCLUDED.size,
           stored_name = EXCLUDED.stored_name,
           created_at_ms = EXCLUDED.created_at_ms,
           bytes = EXCLUDED.bytes`,
        [file.id, file.name, file.mime || 'application/octet-stream', file.size ?? bytes.length, file.storedName, file.createdAtMs, bytes],
      );
    }
    if (batch.dropFiles.length) {
      await client.query(`DELETE FROM ${table('files')} WHERE id = ANY($1::text[])`, [batch.dropFiles]);
    }
    for (const agent of batch.agents || []) {
      if (seedAgentIds.has(agent.id)) {
        await client.query(
          `INSERT INTO ${table('agent_state')} (id, archived, payload)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (id) DO UPDATE SET archived = EXCLUDED.archived, payload = EXCLUDED.payload`,
          [agent.id, !!agent.archived, JSON.stringify(runtimeOf(agent))],
        );
      } else {
        await client.query(
          `INSERT INTO ${table('agent_state')} (id, archived, payload)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (id) DO UPDATE SET archived = EXCLUDED.archived, payload = EXCLUDED.payload`,
          [agent.id, !!agent.archived, JSON.stringify(agentPayload(agent))],
        );
      }
    }
    for (const item of batch.routines || []) {
      await client.query(
        `INSERT INTO ${table('routines')} (id, agent_id, name, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id,
           name = EXCLUDED.name,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at`,
        [item.id, item.agentId, item.name, item.startedAt, item.finishedAt || null],
      );
    }
    if (batch.dropRoutines && batch.dropRoutines.length) {
      await client.query(`DELETE FROM ${table('routines')} WHERE id = ANY($1::text[])`, [batch.dropRoutines]);
    }
    for (const item of batch.outbox || []) {
      const attempts = Number.isInteger(item.attempts) ? item.attempts : (Number(item.attempts) || 0);
      const lastStatus = Number.isInteger(item.lastStatus) && item.lastStatus > 0 ? item.lastStatus : null;
      const status = item.status === 'delivered' || item.status === 'sending' || item.status === 'cancelled'
        ? item.status
        : 'queued';
      const lockedAt = status === 'sending' ? (item.lockedAt || new Date().toISOString()) : null;
      await client.query(
        `INSERT INTO ${table('outbox')} (
           id, seq, created_at, agent_id, task_id, status, last_error, attempts,
           last_attempt_at, last_status, delivered_at, payload, locked_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12::jsonb, $13
         )
         ON CONFLICT (id) DO UPDATE SET
           seq = EXCLUDED.seq,
           created_at = EXCLUDED.created_at,
           agent_id = EXCLUDED.agent_id,
           task_id = EXCLUDED.task_id,
           status = EXCLUDED.status,
           last_error = EXCLUDED.last_error,
           attempts = EXCLUDED.attempts,
           last_attempt_at = EXCLUDED.last_attempt_at,
           last_status = EXCLUDED.last_status,
           delivered_at = EXCLUDED.delivered_at,
           payload = EXCLUDED.payload,
           locked_at = EXCLUDED.locked_at`,
        [
          item.id,
          item.seq,
          item.at,
          item.agentId || '',
          item.taskId || null,
          status,
          item.lastError || null,
          attempts,
          item.lastAttemptAt || null,
          lastStatus,
          item.deliveredAt || null,
          JSON.stringify(item.payload || {}),
          lockedAt,
        ],
      );
    }
    for (const item of batch.webhookTargets || []) {
      await client.query(
        `INSERT INTO ${table('webhook_targets')} (id, iv, tag, ciphertext, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           iv = EXCLUDED.iv,
           tag = EXCLUDED.tag,
           ciphertext = EXCLUDED.ciphertext,
           updated_at = EXCLUDED.updated_at`,
        [item.id, item.iv, item.tag, item.ciphertext, item.updatedAt],
      );
    }
    if (batch.dropWebhookTargets && batch.dropWebhookTargets.length) {
      await client.query(
        `DELETE FROM ${table('webhook_targets')} WHERE id = ANY($1::text[])`,
        [batch.dropWebhookTargets],
      );
    }
    if (batch.migrations) {
      await client.query(
        `INSERT INTO ${table('app_state')} (key, value) VALUES ('migrations', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(batch.migrations)],
      );
    }
    if (batch.grokUsage) {
      await client.query(
        `INSERT INTO ${table('app_state')} (key, value) VALUES ('grokUsage', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(batch.grokUsage)],
      );
    }
    for (const row of batch.decisions || []) {
      await client.query(
        `INSERT INTO ${table('decisions')} (id, at, need_id, what, answer, from_agent_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.at, row.needId, row.what || '', row.answer || '', row.fromAgentId || '', row.source || 'сайт'],
      );
    }
    for (const row of batch.agentTokens || []) {
      await client.query(
        `INSERT INTO ${table('agent_tokens')} (id, agent_id, token_hash, created_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id,
           token_hash = EXCLUDED.token_hash,
           created_at = EXCLUDED.created_at,
           revoked_at = EXCLUDED.revoked_at`,
        [row.id, row.agentId, row.tokenHash, row.createdAt, row.revokedAt || null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* транзакция уже закрыта */ }
    throw err;
  } finally {
    client.release();
  }
}

async function drain() {
  if (!dbEnabled || !pool) return;
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const batch = takeBatch();
    if (batchEmpty(batch)) return;
    try {
      await writeBatch(batch);
    } catch (_) {
      restoreBatch(batch);
      console.log('Хранилище: не удалось записать изменения');
      return;
    }
  }
}

function flush() {
  if (!dbEnabled) return Promise.resolve();
  const run = flushChain.then(() => drain());
  flushChain = run.then(() => {}, () => {});
  return run;
}

async function claimOutbox(id) {
  if (!dbEnabled || !pool || !id) return true;
  const client = await pool.connect();
  try {
    const updated = await client.query(
      `UPDATE ${table('outbox')}
       SET status = 'sending', locked_at = now()
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [id],
    );
    if (updated.rowCount === 1) return true;
    const found = await client.query(`SELECT 1 FROM ${table('outbox')} WHERE id = $1`, [id]);
    return found.rowCount === 0;
  } finally {
    client.release();
  }
}

async function releaseStaleOutbox(seconds = 60) {
  if (!dbEnabled || !pool) return 0;
  const wait = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.floor(Number(seconds)) : 60;
  const client = await pool.connect();
  try {
    const updated = await client.query(
      `UPDATE ${table('outbox')}
       SET status = 'queued', locked_at = NULL
       WHERE status = 'sending'
         AND (locked_at IS NULL OR locked_at < now() - ($1::int * interval '1 second'))`,
      [wait],
    );
    return updated.rowCount || 0;
  } finally {
    client.release();
  }
}

module.exports = {
  ready,
  init,
  unrefIdle,
  flush,
  enabled,
  noteTask,
  noteMessage,
  noteMessagesRemoved,
  noteNeed,
  noteFile,
  noteFilesRemoved,
  noteAgent,
  noteMigrations,
  noteGrokUsage,
  noteRoutine,
  noteRoutinesRemoved,
  noteOutbox,
  claimOutbox,
  releaseStaleOutbox,
  noteWebhookTarget,
  noteWebhookTargetRemoved,
  noteDecision,
  noteAgentToken,
  missingSeeds,
  withNeeds,
};
