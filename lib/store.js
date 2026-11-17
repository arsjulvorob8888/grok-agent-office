'use strict';

// Постоянное хранилище приказов, пунктов «Нужно от вас», переписки и вложений.
// Сервер держит ту же память, что и раньше, и только дописывает изменения сюда,
// чтобы опрос /api/state не ходил в базу. Если DATABASE_URL нет или Postgres
// недоступен при старте, модуль ничего не пишет и процесс живёт как раньше.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

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
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 10000,
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
}

const TASK_KEYS = new Set(['id', 'seq', 'agent', 'agentId', 'fromAgentId', 'parentOrderId', 'text', 'status', 'orderStatus', 'progress', 'note', 'createdAt', 'forwardStatus', 'forwardError', 'result', 'messageId', 'history', 'attachments', 'extra']);
const NEED_KEYS = new Set(['id', 'ord', 'what', 'fromAgentId', 'where', 'urgency', 'createdAt', 'closedAt', 'extra']);
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
  if (agent.lastSeenAt) runtime.lastSeenAt = agent.lastSeenAt;
  if (typeof agent.heartbeatNote === 'string' && agent.heartbeatNote) runtime.heartbeatNote = agent.heartbeatNote;
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
  // Посев только в пустую таблицу. Уже лежащие пункты, включая снятый need-render-api, не дополняются.
  if ((count.rows[0] && count.rows[0].n) > 0) {
    seededFromEmpty = false;
    return;
  }
  seededFromEmpty = true;
  const list = (seeds || []).filter((item) => item && item.id && item.id !== 'need-render-api');
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
      if (agent) {
        if (stored.lastSeenAt) agent.lastSeenAt = stored.lastSeenAt;
        if (typeof stored.heartbeatNote === 'string' && stored.heartbeatNote) agent.heartbeatNote = stored.heartbeatNote;
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
    const loaded = await readAll(client);
    const capped = capMessages(loaded.messages);
    droppedMessageIds = capped.drop;
    if (droppedMessageIds.length) {
      await client.query(`DELETE FROM ${table('messages')} WHERE id = ANY($1::text[])`, [droppedMessageIds]);
    }
    const dynamicAgents = await syncAgents(client, state);
    await client.query('COMMIT');
    loaded.messages = capped.keep;
    loaded.dynamicAgents = dynamicAgents;
    applyLoaded(state, loaded);
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
  return { tasks, messages, dropMessages, needs, files, dropFiles, agents };
}

function batchEmpty(batch) {
  return !batch.tasks.length && !batch.messages.length && !batch.dropMessages.length
    && !batch.needs.length && !batch.files.length && !batch.dropFiles.length
    && !(batch.agents && batch.agents.length);
}

function restoreBatch(batch) {
  for (const task of batch.tasks) dirtyTasks.add(task);
  for (const message of batch.messages) dirtyMessages.set(message.id, message);
  for (const id of batch.dropMessages) deletedMessages.add(id);
  for (const item of batch.needs) dirtyNeeds.set(item.id, item);
  for (const file of batch.files) dirtyFiles.set(file.id, file);
  for (const id of batch.dropFiles) deletedFiles.add(id);
  for (const agent of batch.agents || []) dirtyAgents.set(agent.id, agent);
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
  missingSeeds,
  withNeeds,
};
