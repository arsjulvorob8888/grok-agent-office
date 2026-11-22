'use strict';

// Волна 3: вид маршрута без адреса, grokbot не ссылка, шапка без энергии.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const delivery = require('../lib/delivery');
const { seal } = require('../lib/webhook-crypto');
const { renderSafeMarkdown } = require('../public/js/markdown.js');
const feed = require('../public/js/feed.js');

const ENV_URL = 'https://fixture.invalid/wave3-env-path';
const ARMY_URL = 'https://fixture.invalid/wave3-army-path';
const PUTIN_URL = 'https://fixture.invalid/wave3-putin-path';
const ARMY_KEY = 'wave3-army-key-AAAA';
const PUTIN_KEY = 'wave3-putin-key-PPPP';

function keyEnv(extra) {
  return {
    WEBHOOK_SECRETS_KEY: crypto.randomBytes(32).toString('base64'),
    KREMLIN_WEBHOOK_URL: '',
    KREMLIN_WEBHOOK_KEY: '',
    ...extra,
  };
}

function box(id, url, key, env) {
  return { id, ...seal(id, { url, key }, env) };
}

test('publicRoute повторяет resolveDestination и не отдаёт адрес', () => {
  assert.equal(typeof delivery.publicRoute, 'function');
  const env = keyEnv();
  const state = { webhookTargets: {} };
  assert.equal(delivery.publicRoute('army', state, env), 'none');
  assert.equal(delivery.resolveDestination('army', state, env), null);

  env.KREMLIN_WEBHOOK_URL = ENV_URL;
  env.KREMLIN_WEBHOOK_KEY = 'wave3-env-key-EEEE';
  assert.equal(delivery.publicRoute('army', state, env), 'env');
  assert.equal(delivery.resolveDestination('army', state, env).via, 'env');

  state.webhookTargets.putin = box('putin', PUTIN_URL, PUTIN_KEY, env);
  assert.equal(delivery.publicRoute('finance', state, env), 'putin');
  assert.equal(delivery.publicRoute('grok', state, env), 'putin');

  state.webhookTargets.army = box('army', ARMY_URL, ARMY_KEY, env);
  assert.equal(delivery.publicRoute('army', state, env), 'agent');
  assert.equal(delivery.publicRoute('finance', state, env), 'putin');

  const bad = { ...env, WEBHOOK_SECRETS_KEY: crypto.randomBytes(32).toString('base64') };
  assert.equal(delivery.publicRoute('army', state, bad), 'none');

  const dumped = JSON.stringify({
    army: delivery.publicRoute('army', state, env),
    finance: delivery.publicRoute('finance', state, env),
    grok: delivery.publicRoute('grok', state, env),
  });
  assert.equal(dumped.includes('fixture.invalid'), false);
  assert.equal(dumped.includes(ARMY_KEY), false);
  assert.equal(dumped.includes(PUTIN_KEY), false);
});

test('подпись маршрута — четыре русских вида, без адреса', () => {
  assert.equal(feed.routeLabel('agent'), 'Свой вебхук агента');
  assert.equal(feed.routeLabel('putin'), 'Через Путина');
  assert.equal(feed.routeLabel('env'), 'Адрес из окружения');
  assert.equal(feed.routeLabel('none'), 'Нет маршрута');
  assert.equal(feed.routeLabel('other'), 'Нет маршрута');
  assert.equal(feed.routePhrase('putin'), 'Куда уйдёт приказ: Через Путина');
  assert.equal(feed.routeSummary(['agent', 'agent']), 'Куда уйдёт приказ: Свой вебхук агента');
  assert.equal(
    feed.routeSummary(['none', 'agent', 'putin']),
    'Куда уйдёт приказ: Свой вебхук агента — 1. Через Путина — 1. Нет маршрута — 1',
  );
  assert.equal(JSON.stringify(feed.routeSummary(['env'])).includes('http'), false);
});

test('grokbot:// остаётся текстом без ссылки и без адреса', () => {
  const html = renderSafeMarkdown('Смотри https://example.com/q и grokbot://app/v1/agent?id=1\n\n<script>alert(1)</script>');
  assert.match(html, /<a href="https:\/\/example.com\/q"/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="grokbot:/);
  assert.doesNotMatch(html, /grokbot:/);
  assert.doesNotMatch(html, /Grok/);
  assert.match(html, /чат агента/);
  const labeled = renderSafeMarkdown('[Чат Путина](grokbot://app/v1/agent?id=1)');
  assert.doesNotMatch(labeled, /<a /);
  assert.doesNotMatch(labeled, /grokbot:/);
  assert.match(labeled, /Чат Путина/);
  const httpLink = renderSafeMarkdown('Черновик http://example.com/plain');
  assert.doesNotMatch(httpLink, /<a /);
  assert.match(httpLink, /http:\/\/example.com\/plain/);
});

test('шапка и окно карты не обещают энергию и Grok', () => {
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const dash = fs.readFileSync(path.join(root, 'public/js/agent-dashboard.js'), 'utf8');
  assert.equal(html.includes('id="stEnergy"'), false);
  assert.equal(html.includes('Энергия'), false);
  assert.equal(html.includes('id="stTasks"'), false);
  assert.equal(html.includes('>Лимит Grok<'), false);
  assert.equal(app.includes('скажи Grok'), false);
  assert.equal(app.includes('Лимит Grok'), false);
  assert.equal(app.includes('stEnergy'), false);
  assert.equal(app.includes('Агент взялся за работу'), false);
  assert.equal(dash.includes('data-status='), false);
  assert.equal(dash.includes('>В работу<'), false);
  assert.match(app, /скажи Путину/);
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
  delete env.DATABASE_URL;
  delete env.STORE_SCHEMA;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-wave3';
  env.AGENT_TOKEN = 'tok-wave3';
  env.PUBLIC_URL = 'https://example.test';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-wave3-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let up = false;
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.status === 200) { up = true; break; }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  return { base: origin, child, logs };
}

async function stopOffice(officeProc) {
  if (!officeProc || !officeProc.child || officeProc.child.exitCode != null) return;
  officeProc.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { officeProc.child.kill('SIGKILL'); resolve(); }, 3000);
    officeProc.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function call(base, urlPath, opts = {}) {
  const res = await fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { status: res.status, body, text };
}

test('ответ приказа и /api/state отдают вид маршрута без URL и ключа', async () => {
  const http = require('node:http');
  const hits = [];
  const hook = http.createServer((req, res) => {
    hits.push(req.url || '');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const envUrl = `http://127.0.0.1:${hook.address().port}/wave3-env`;
  const armyUrl = `http://127.0.0.1:${hook.address().port}/wave3-army`;
  const secrets = crypto.randomBytes(32).toString('base64');
  const office = await startOffice({
    WEBHOOK_SECRETS_KEY: secrets,
    KREMLIN_WEBHOOK_URL: envUrl,
    KREMLIN_WEBHOOK_KEY: 'wave3-env-key-EEEE',
  });
  try {
    const state = await call(office.base, '/api/state');
    assert.equal(state.status, 200);
    const army = state.body.agents.find((agent) => agent.id === 'army');
    const putin = state.body.agents.find((agent) => agent.id === 'grok');
    assert.equal(army.deliveryRoute, 'env');
    assert.equal(putin.deliveryRoute, 'env');
    assert.equal(state.text.includes(envUrl), false);
    assert.equal(state.text.includes('wave3-env-key'), false);

    const sent = await call(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-wave3' },
      body: JSON.stringify({ agent: 'army', text: 'Проверка маршрута волны 3', fromAgentId: 'owner' }),
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.deliveryRoute, 'env');
    assert.equal(sent.text.includes(envUrl), false);
    assert.equal(sent.text.includes('wave3-env-key'), false);
    assert.equal(sent.body.routeLabel.includes('Путин'), true);

    const saved = await call(office.base, '/api/agents/army/delivery', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-wave3' },
      body: JSON.stringify({ url: armyUrl, key: ARMY_KEY }),
    });
    assert.equal(saved.status, 200);
    const again = await call(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-wave3' },
      body: JSON.stringify({ agent: 'army', text: 'Уже своим вебхуком', fromAgentId: 'owner' }),
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.deliveryRoute, 'agent');
    assert.equal(again.text.includes(armyUrl), false);
    assert.equal(again.text.includes(ARMY_KEY), false);

    const dash = await call(office.base, '/api/agents/army/dashboard');
    assert.equal(dash.status, 200);
    assert.equal(dash.body.deliveryRoute, 'agent');
    assert.equal(dash.text.includes(armyUrl), false);
    assert.equal(dash.text.includes(ARMY_KEY), false);
    assert.ok(hits.some((url) => url === '/wave3-army'));
  } finally {
    await stopOffice(office);
    hook.close();
  }
});
