'use strict';

// Дашборды направлений. Каждая публикация — новая версия, старые не затираются.
// DATABASE_URL задан — таблица agent_dashboards в Postgres (создаётся идемпотентно).
// Нет строки или база недоступна при старте — те же версии живут в памяти процесса.
// lib/store.js, если он уже на сервере и умеет query/pool, используется вместо своего пула.

const MAX_BYTES = 200 * 1024;
const HISTORY_LIMIT = 50;

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS agent_dashboards (
  id serial PRIMARY KEY,
  agent_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`;
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS agent_dashboards_agent_id_id_idx
  ON agent_dashboards (agent_id, id DESC)`;

const TRENDS = new Set(['up', 'down', 'flat']);
const CHART_KINDS = new Set(['line', 'bar']);

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.expose = error;
  return err;
}

function asObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, `${path} должен быть объектом`);
  }
  return value;
}

function str(value, path, max, required) {
  if (value == null || value === '') {
    if (required) throw httpError(400, `Нужно поле ${path}`);
    return '';
  }
  if (typeof value !== 'string') throw httpError(400, `${path} должен быть строкой`);
  const text = value.trim();
  if (required && !text) throw httpError(400, `Нужно поле ${path}`);
  if (text.length > max) throw httpError(400, `${path} слишком длинное (максимум ${max} символов)`);
  return text;
}

function metric(value, path, required) {
  if (value == null || value === '') {
    if (required) throw httpError(400, `Нужно поле ${path}`);
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw httpError(400, `${path} должен быть конечным числом`);
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      if (required) throw httpError(400, `Нужно поле ${path}`);
      return undefined;
    }
    if (text.length > 80) throw httpError(400, `${path} слишком длинное (максимум 80 символов)`);
    return text;
  }
  throw httpError(400, `${path} должен быть числом или строкой`);
}

function httpUrl(value, path) {
  if (typeof value !== 'string') throw httpError(400, `${path} должен быть строкой`);
  const text = value.trim();
  let url;
  try { url = new URL(text); } catch (_) { url = null; }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw httpError(400, `${path} должен быть ссылкой http или https`);
  }
  if (url.username || url.password) throw httpError(400, `${path} не должен содержать логин или пароль`);
  return url.href;
}

function parseKpi(block, path) {
  const label = str(block.label, `${path}.label`, 120, true);
  const value = metric(block.value, `${path}.value`, true);
  const out = { type: 'kpi', label, value };
  const unit = str(block.unit, `${path}.unit`, 24, false);
  if (unit) out.unit = unit;
  if (block.target != null && block.target !== '') out.target = metric(block.target, `${path}.target`, true);
  if (block.delta != null && block.delta !== '') out.delta = metric(block.delta, `${path}.delta`, true);
  if (block.trend != null && block.trend !== '') {
    const trend = typeof block.trend === 'string' ? block.trend.trim() : '';
    if (!TRENDS.has(trend)) throw httpError(400, `${path}.trend должен быть up, down или flat`);
    out.trend = trend;
  }
  return out;
}

function parseChart(block, path) {
  const title = str(block.title, `${path}.title`, 160, true);
  const kind = typeof block.kind === 'string' ? block.kind.trim() : '';
  if (!CHART_KINDS.has(kind)) throw httpError(400, `${path}.kind должен быть line или bar`);
  if (!Array.isArray(block.labels)) throw httpError(400, `${path}.labels должен быть массивом`);
  if (block.labels.length < 1 || block.labels.length > 48) {
    throw httpError(400, `${path}.labels: от 1 до 48 точек`);
  }
  const labels = block.labels.map((label, i) => str(label, `${path}.labels[${i}]`, 40, true));
  if (!Array.isArray(block.series) || block.series.length < 1) {
    throw httpError(400, `${path}.series должен быть непустым массивом`);
  }
  if (block.series.length > 6) throw httpError(400, `${path}.series: максимум 6 рядов`);
  const series = block.series.map((item, i) => {
    const sp = `${path}.series[${i}]`;
    const obj = asObject(item, sp);
    const name = str(obj.name, `${sp}.name`, 60, true);
    if (!Array.isArray(obj.data)) throw httpError(400, `${sp}.data должен быть массивом чисел`);
    if (obj.data.length !== labels.length) {
      throw httpError(400, `${sp}.data должен быть той же длины, что labels`);
    }
    const data = obj.data.map((n, j) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) throw httpError(400, `${sp}.data[${j}] должен быть числом`);
      return n;
    });
    return { name, data };
  });
  return { type: 'chart', title, kind, labels, series };
}

function parseForecast(block, path) {
  const label = str(block.label, `${path}.label`, 120, true);
  const value = metric(block.value, `${path}.value`, true);
  const horizon = str(block.horizon, `${path}.horizon`, 80, true);
  if (typeof block.confidence !== 'number' || !Number.isFinite(block.confidence) || block.confidence < 0 || block.confidence > 1) {
    throw httpError(400, `${path}.confidence должен быть числом от 0 до 1`);
  }
  const out = { type: 'forecast', label, value, horizon, confidence: block.confidence };
  const unit = str(block.unit, `${path}.unit`, 24, false);
  if (unit) out.unit = unit;
  return out;
}

function parseMarkdown(block, path) {
  if (typeof block.text !== 'string') throw httpError(400, `${path}.text должен быть строкой`);
  if (block.text.length > 20000) throw httpError(400, `${path}.text слишком длинный (максимум 20000 символов)`);
  return { type: 'markdown', text: block.text };
}

function parseLinks(block, path) {
  if (!Array.isArray(block.items)) throw httpError(400, `${path}.items должен быть массивом`);
  if (block.items.length > 20) throw httpError(400, `${path}.items: максимум 20 ссылок`);
  const items = block.items.map((item, i) => {
    const ip = `${path}.items[${i}]`;
    const obj = asObject(item, ip);
    return {
      label: str(obj.label, `${ip}.label`, 160, true),
      url: httpUrl(obj.url, `${ip}.url`),
    };
  });
  return { type: 'links', items };
}

function parseBlock(block, index) {
  const path = `blocks[${index}]`;
  const obj = asObject(block, path);
  const type = typeof obj.type === 'string' ? obj.type.trim() : '';
  if (type === 'kpi') return parseKpi(obj, path);
  if (type === 'chart') return parseChart(obj, path);
  if (type === 'forecast') return parseForecast(obj, path);
  if (type === 'markdown') return parseMarkdown(obj, path);
  if (type === 'links') return parseLinks(obj, path);
  throw httpError(400, `${path}.type должен быть kpi, chart, forecast, markdown или links`);
}

function parseDashboard(body) {
  const obj = asObject(body, 'Тело');
  let title = null;
  if (obj.title != null && obj.title !== '') title = str(obj.title, 'title', 200, true);
  let updatedAt;
  if (obj.updatedAt == null || obj.updatedAt === '') {
    updatedAt = new Date().toISOString();
  } else if (typeof obj.updatedAt !== 'string') {
    throw httpError(400, 'updatedAt должен быть строкой ISO');
  } else {
    const t = Date.parse(obj.updatedAt);
    if (Number.isNaN(t)) throw httpError(400, 'Некорректный updatedAt');
    if (t > Date.now() + 864e5) throw httpError(400, 'updatedAt слишком далеко в будущем');
    updatedAt = new Date(t).toISOString();
  }
  if (!Array.isArray(obj.blocks)) throw httpError(400, 'Нужен массив blocks');
  if (obj.blocks.length > 40) throw httpError(400, 'Слишком много блоков (максимум 40)');
  const blocks = obj.blocks.map(parseBlock);
  const dashboard = { title, updatedAt, blocks };
  return dashboard;
}

function sslModeOf(connectionString) {
  try {
    return (new URL(connectionString).searchParams.get('sslmode') || '').toLowerCase();
  } catch (_) {
    const match = /(?:\?|&)sslmode=([^&]*)/i.exec(connectionString);
    return match ? decodeURIComponent(match[1]).toLowerCase() : '';
  }
}

function connectionConfig(connectionString) {
  const mode = sslModeOf(connectionString);
  let stripped = connectionString;
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('uselibpqcompat');
    stripped = url.toString();
  } catch (_) { /* оставляем исходную строку */ }
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

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return String(value);
  return new Date(parsed).toISOString();
}

function asDashboard(payload) {
  const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
  return {
    title: obj.title || null,
    updatedAt: obj.updatedAt,
    blocks: Array.isArray(obj.blocks) ? obj.blocks : [],
  };
}

function tryStoreQuery() {
  let store;
  try {
    store = require('./store');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    return null;
  }
  if (store && typeof store.query === 'function') return (text, params) => store.query(text, params);
  if (store && store.pool && typeof store.pool.query === 'function') {
    return (text, params) => store.pool.query(text, params);
  }
  return null;
}

function createDashboardStore() {
  const memory = new Map();
  const current = new Map();
  let mode = 'memory';
  let pool = null;
  let query = null;
  let lastMs = 0;

  function stamp() {
    let ms = Date.now();
    if (ms <= lastMs) ms = lastMs + 1;
    lastMs = ms;
    return new Date(ms).toISOString();
  }

  function remember(agentId, row) {
    current.set(agentId, row);
  }

  function saveMemory(agentId, dashboard) {
    const list = memory.get(agentId) || [];
    const row = {
      version: list.length + 1,
      storedAt: stamp(),
      dashboard,
    };
    list.push(row);
    memory.set(agentId, list);
    remember(agentId, row);
    return { versions: row.version, dashboard, storedAt: row.storedAt };
  }

  async function savePg(agentId, dashboard) {
    const storedAt = stamp();
    await query(
      `INSERT INTO agent_dashboards (agent_id, payload, created_at) VALUES ($1, $2::jsonb, $3)`,
      [agentId, JSON.stringify(dashboard), storedAt],
    );
    const count = await query(
      `SELECT count(*)::int AS n FROM agent_dashboards WHERE agent_id = $1`,
      [agentId],
    );
    const versions = count.rows[0].n;
    const row = { version: versions, storedAt, dashboard };
    remember(agentId, row);
    return { versions, dashboard, storedAt };
  }

  async function historyPg(agentId) {
    const count = await query(
      `SELECT count(*)::int AS n FROM agent_dashboards WHERE agent_id = $1`,
      [agentId],
    );
    const total = count.rows[0].n;
    const found = await query(
      `SELECT id, payload, created_at
       FROM agent_dashboards
       WHERE agent_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [agentId, HISTORY_LIMIT],
    );
    return found.rows.map((row, index) => ({
      version: total - index,
      storedAt: toIso(row.created_at),
      dashboard: asDashboard(row.payload),
    }));
  }

  async function boot() {
    const url = process.env.DATABASE_URL || '';
    if (!url) return;
    const shared = tryStoreQuery();
    try {
      if (shared) {
        query = shared;
      } else {
        const { Pool } = require('pg');
        pool = new Pool(connectionConfig(url));
        pool.on('error', () => {
          console.log('Дашборды: ошибка соединения Postgres');
        });
        if (process.env.NODE_TEST_CONTEXT) {
          pool.on('connect', (client) => {
            const stream = client && client.connection && client.connection.stream;
            if (stream && typeof stream.unref === 'function') stream.unref();
          });
        }
        query = (text, params) => pool.query(text, params);
      }
      await query(SCHEMA_SQL);
      await query(INDEX_SQL);
      const latest = await query(
        `SELECT DISTINCT ON (agent_id) agent_id, payload, created_at
         FROM agent_dashboards
         ORDER BY agent_id, id DESC`,
      );
      const counts = await query(
        `SELECT agent_id, count(*)::int AS n FROM agent_dashboards GROUP BY agent_id`,
      );
      const byCount = new Map(counts.rows.map((row) => [row.agent_id, row.n]));
      for (const row of latest.rows) {
        remember(row.agent_id, {
          version: byCount.get(row.agent_id) || 1,
          storedAt: toIso(row.created_at),
          dashboard: asDashboard(row.payload),
        });
      }
      mode = 'pg';
      console.log('Дашборды: Postgres, таблица agent_dashboards');
    } catch (err) {
      console.log(`Дашборды: Postgres недоступен, версии остаются в памяти${err && err.message ? ` (${err.message})` : ''}`);
      if (pool) {
        try { await pool.end(); } catch (_) { /* пул уже закрыт */ }
      }
      pool = null;
      query = null;
      mode = 'memory';
    }
  }

  const ready = boot();

  function updatedAt(agentId) {
    const row = current.get(agentId);
    return row ? row.storedAt : null;
  }

  function view(agentId) {
    const row = current.get(agentId);
    if (!row) return { agentId, versions: 0, updatedAt: null, dashboard: null };
    return {
      agentId,
      versions: row.version,
      updatedAt: row.storedAt,
      dashboard: row.dashboard,
    };
  }

  return {
    ready: () => ready,
    mode: () => mode,
    schemaSql: SCHEMA_SQL,
    maxBytes: MAX_BYTES,
    updatedAt,
    parse: parseDashboard,
    async save(agentId, dashboard) {
      await ready;
      try {
        if (mode === 'pg') return await savePg(agentId, dashboard);
        return saveMemory(agentId, dashboard);
      } catch (err) {
        if (err.status) throw err;
        console.log(`Дашборды: не удалось записать версию${err && err.message ? ` (${err.message})` : ''}`);
        throw httpError(503, 'Хранилище дашбордов недоступно');
      }
    },
    async current(agentId) {
      await ready;
      return view(agentId);
    },
    async history(agentId) {
      await ready;
      try {
        const rows = mode === 'pg'
          ? await historyPg(agentId)
          : (memory.get(agentId) || []).slice(-HISTORY_LIMIT).reverse();
        return {
          agentId,
          versions: rows.map((row) => ({
            version: row.version,
            createdAt: row.storedAt,
            updatedAt: row.dashboard.updatedAt,
            dashboard: row.dashboard,
          })),
        };
      } catch (err) {
        if (err.status) throw err;
        console.log(`Дашборды: не удалось прочитать историю${err && err.message ? ` (${err.message})` : ''}`);
        throw httpError(503, 'Хранилище дашбордов недоступно');
      }
    },
  };
}

module.exports = {
  MAX_BYTES,
  SCHEMA_SQL,
  parseDashboard,
  createDashboardStore,
};
