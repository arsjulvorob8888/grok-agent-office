'use strict';

// Лимит Grok: токен, проверка тела, последнее значение, 7 дней истории, пороги.
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let view = null;
try {
  view = require('../public/js/usage-widget');
} catch (_) {
  view = null;
}
let usage = null;
try {
  usage = require('../lib/usage');
} catch (_) {
  usage = null;
}

const DAY = 24 * 60 * 60 * 1000;
const root = path.join(__dirname, '..');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-usage-'));
process.env.APP_PASSWORD = 'pw-usage';
process.env.AGENT_TOKEN = 'tok-usage';
process.env.AGENT_STATUS_TOKEN = 'status-usage';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.KREMLIN_WEBHOOK_URL;
delete process.env.GROK_WEBHOOK_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app, state } = require('../server.js');

let base;
let server;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (usage && usage.setNow) usage.setNow(null);
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  state.grokUsage = { latest: null, history: [] };
  if (usage && usage.setNow) usage.setNow(null);
});

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => null),
  }));

function sample(over = {}) {
  return {
    plan: 'Super',
    usedPct: 42,
    used: 42,
    limit: 100,
    resetsAt: '2026-11-18T21:00:00.000Z',
    source: 'grok',
    ...over,
  };
}

function post(body, headers = {}) {
  return json('/api/usage', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-usage', ...headers },
    body: JSON.stringify(body),
  });
}

describe('лимит Grok', { concurrency: 1 }, () => {
  test('без токена и с чужим токеном POST /api/usage отвечает 401', async () => {
    const missing = await json('/api/usage', { method: 'POST', body: JSON.stringify(sample()) });
    assert.equal(missing.status, 401);
    assert.match(missing.body.error, /токен/i);

    const wrongAgent = await post(sample(), { 'x-agent-token': 'nope' });
    assert.equal(wrongAgent.status, 401);

    const wrongBearer = await post(sample(), {
      'x-agent-token': '',
      Authorization: 'Bearer nope',
    });
    assert.equal(wrongBearer.status, 401);

    const password = await post(sample(), {
      'x-agent-token': '',
      'x-app-password': 'pw-usage',
    });
    assert.equal(password.status, 401);

    const bearerAsAgent = await post(sample(), {
      'x-agent-token': '',
      Authorization: 'Bearer tok-usage',
    });
    assert.equal(bearerAsAgent.status, 401);

    const agentAsStatus = await post(sample(), { 'x-agent-token': 'status-usage' });
    assert.equal(agentAsStatus.status, 401);
  });

  test('мусор в теле POST /api/usage отвечает 400', async () => {
    const cases = [
      {},
      [],
      { plan: 'Super' },
      { plan: 12, usedPct: 10, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'x'.repeat(41), usedPct: 10, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'Super', usedPct: 10, resetsAt: '2026-11-18T00:00:00.000Z', source: 'y'.repeat(41) },
      { plan: ' ', usedPct: 10, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'Super', usedPct: '10', resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'Super', usedPct: 101, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'Super', usedPct: -1, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'Super', usedPct: 10, resetsAt: 'завтра', source: 'grok' },
      { plan: 'Super', usedPct: 10, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok', secret: 'nope' },
      { plan: 'Super', used: 150, limit: 100, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
      { plan: 'Super', used: 10, resetsAt: '2026-11-18T00:00:00.000Z', source: 'grok' },
    ];
    for (const body of cases) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test('последнее значение сохраняется и процент считается из used/limit', async () => {
    const first = await post(sample({ plan: 'Super', usedPct: 42 }));
    assert.equal(first.status, 200);
    assert.equal(first.body.latest.plan, 'Super');
    assert.equal(first.body.latest.usedPct, 42);
    assert.equal(first.body.latest.source, 'grok');
    assert.equal(first.body.latest.resetsAt, '2026-11-18T21:00:00.000Z');
    assert.equal(first.body.history.length, 1);
    assert.equal(JSON.stringify(first.body).includes('tok-usage'), false);
    assert.equal(JSON.stringify(first.body).includes('status-usage'), false);

    const byBearer = await post(sample({ plan: 'Max', usedPct: 15 }), {
      'x-agent-token': '',
      Authorization: 'Bearer status-usage',
    });
    assert.equal(byBearer.status, 200);
    assert.equal(byBearer.body.latest.plan, 'Max');
    assert.equal(byBearer.body.latest.usedPct, 15);
    assert.equal(byBearer.body.history.length, 2);
    assert.equal(byBearer.body.history[0].plan, 'Super');
    assert.equal(byBearer.body.history[1].plan, 'Max');

    const counted = await post({
      plan: 'Meter',
      used: 1,
      limit: 3,
      resetsAt: '2026-11-18',
      source: 'calc',
    });
    assert.equal(counted.status, 200);
    assert.equal(counted.body.latest.usedPct, 33.33);
    assert.equal(counted.body.latest.used, 1);
    assert.equal(counted.body.latest.limit, 3);

    const viaGet = await json('/api/usage');
    assert.equal(viaGet.status, 200);
    assert.equal(viaGet.body.latest.plan, 'Meter');
    assert.equal(viaGet.body.latest.usedPct, 33.33);
    const viaState = await json('/api/state');
    assert.equal(viaState.status, 200);
    assert.equal(viaState.body.grokUsage.latest.plan, 'Meter');
    assert.equal(viaState.body.grokUsage.history.length, viaGet.body.history.length);
  });

  test('история старше 7 дней отбрасывается, граница семи суток остаётся', async () => {
    assert.ok(usage && typeof usage.setNow === 'function', 'нет lib/usage.js');
    const t0 = Date.parse('2026-10-01T00:00:00.000Z');
    usage.setNow(() => t0);
    const edge = await post(sample({ plan: 'Edge', usedPct: 11 }));
    assert.equal(edge.status, 200);

    usage.setNow(() => t0 + 7 * DAY);
    const kept = await post(sample({ plan: 'Edge2', usedPct: 12 }));
    assert.equal(kept.status, 200);
    assert.deepEqual(kept.body.history.map((item) => item.plan), ['Edge', 'Edge2']);

    usage.setNow(() => t0 + 7 * DAY + 1);
    const dropped = await post(sample({ plan: 'Edge3', usedPct: 13 }));
    assert.equal(dropped.status, 200);
    assert.equal(dropped.body.latest.plan, 'Edge3');
    assert.equal(dropped.body.history.some((item) => item.plan === 'Edge'), false);
    assert.deepEqual(dropped.body.history.map((item) => item.plan), ['Edge2', 'Edge3']);

    const listed = await json('/api/usage');
    assert.deepEqual(listed.body.history.map((item) => item.plan), ['Edge2', 'Edge3']);
    assert.equal(listed.body.latest.plan, 'Edge3');
  });

  test('пороги 80 и 95 попадают в level', async () => {
    const ok = await post(sample({ usedPct: 79 }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.latest.level, 'ok');

    const warn = await post(sample({ usedPct: 80 }));
    assert.equal(warn.body.latest.level, 'warn');

    const still = await post(sample({ usedPct: 94 }));
    assert.equal(still.body.latest.level, 'warn');

    const hot = await post(sample({ usedPct: 95 }));
    assert.equal(hot.body.latest.level, 'critical');

    const full = await post(sample({ usedPct: 100 }));
    assert.equal(full.body.latest.level, 'critical');
  });

  test('пустой снимок — не ошибка, виджет показывает «нет данных»', async () => {
    assert.ok(view && typeof view.present === 'function', 'нет public/js/usage-widget.js');
    const empty = view.present(null);
    assert.equal(empty.plan, 'нет данных');
    assert.equal(empty.level, 'empty');
    assert.equal(empty.banner, '');
    assert.equal(empty.meter, 0);
    const none = view.present({ latest: null, history: [] });
    assert.equal(none.plan, 'нет данных');
    assert.equal(none.level, 'empty');

    const warn = view.present({
      latest: {
        plan: 'Super',
        usedPct: 80,
        resetsAt: '2026-11-18T21:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
        source: 'grok',
      },
    });
    assert.equal(warn.level, 'warn');
    assert.equal(warn.banner, '');
    assert.match(warn.splitText, /использовано 80%/);
    assert.match(warn.splitText, /осталось 20%/);
    assert.match(warn.timesText, /МСК/);
    assert.equal(view.formatMsk('2026-11-18T00:00:00.000Z'), '18.11 03:00 МСК');

    const hot = view.present({
      latest: {
        plan: 'Super',
        usedPct: 95,
        resetsAt: '2026-11-18T21:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
        source: 'grok',
      },
    });
    assert.equal(hot.level, 'critical');
    assert.match(hot.banner, /95%/);
    assert.match(hot.banner, /МСК/);

    const listed = await json('/api/usage');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.latest, null);
    assert.deepEqual(listed.body.history, []);
    const stateRes = await json('/api/state');
    assert.equal(stateRes.body.grokUsage.latest, null);
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-usage';
  env.AGENT_TOKEN = 'tok-usage';
  env.AGENT_STATUS_TOKEN = 'status-usage';
  env.GROK_WEBHOOK_URL = '';
  env.PUBLIC_URL = 'https://example.test';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-usage-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const officeBase = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let up = false;
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) {
      throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    }
    try {
      const res = await fetch(`${officeBase}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') {
        up = true;
        break;
      }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  return { base: officeBase, child, logs };
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      office.child.kill('SIGKILL');
      resolve();
    }, 3000);
    office.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function officeJson(officeBase, urlPath, opts = {}) {
  const res = await fetch(officeBase + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = text; }
  }
  return { status: res.status, body };
}

async function dropSchema(schema) {
  if (!process.env.DATABASE_URL) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch (_) { /* схема могла не создаться */ } finally {
    await pool.end();
  }
}

describe('лимит Grok в Postgres', { concurrency: 1 }, () => {
  test('снимок переживает новый процесс', { skip: process.env.DATABASE_URL ? false : 'DATABASE_URL не задан' }, async () => {
    const schema = `u_${crypto.randomBytes(4).toString('hex')}`;
    const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
    const payload = sample({ plan: 'Saved', usedPct: 64 });
    const first = await startOffice(env);
    try {
      const created = await officeJson(first.base, '/api/usage', {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-usage' },
        body: JSON.stringify(payload),
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.latest.plan, 'Saved');
      assert.equal(first.logs.out.includes('postgres://') || first.logs.err.includes('postgres://'), false);
    } finally {
      await stopOffice(first);
    }

    const second = await startOffice(env);
    try {
      const listed = await officeJson(second.base, '/api/usage');
      assert.equal(listed.status, 200);
      assert.equal(listed.body.latest.plan, 'Saved');
      assert.equal(listed.body.latest.usedPct, 64);
      assert.equal(listed.body.latest.level, 'ok');
      assert.equal(listed.body.history.length, 1);
      assert.equal(listed.body.history[0].source, 'grok');
      const stateRes = await officeJson(second.base, '/api/state');
      assert.equal(stateRes.body.grokUsage.latest.plan, 'Saved');

      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      try {
        const row = await pool.query(`SELECT value FROM ${schema}.app_state WHERE key = 'grokUsage'`);
        assert.equal(row.rows.length, 1);
        assert.equal(row.rows[0].value.latest.plan, 'Saved');
        assert.equal(JSON.stringify(row.rows[0].value).includes('tok-usage'), false);
      } finally {
        await pool.end();
      }
    } finally {
      await stopOffice(second);
      await dropSchema(schema);
    }
  });
});
