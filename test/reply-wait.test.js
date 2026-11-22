'use strict';

// Подпись в окне агента и на дашборде, пока агент не ответил.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const HELD = 'Агенту ещё не доставлено';
const WAIT = 'Доставлено агенту, ответа пока нет';

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

async function startOffice(hookUrl) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-wait-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.DATABASE_URL;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-wait';
  env.AGENT_TOKEN = 'tok-wait';
  env.PUBLIC_URL = 'https://example.test';
  env.KREMLIN_WEBHOOK_URL = hookUrl || '';
  env.KREMLIN_WEBHOOK_KEY = hookUrl ? 'wait-key' : '';
  env.WEBHOOK_SECRETS_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  env.PORT = String(port);
  env.UPLOAD_DIR = uploadDir;
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200) return { base, child };
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('healthz не ответил');
}

async function stopOffice(office) {
  if (!office || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function json(base, urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

test('окно и дашборд честно ждут ответ и не рисуют «Думает»', async () => {
  const hook = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  const office = await startOffice('');
  const puppeteer = require('puppeteer-core');
  const chrome = ['/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .find((candidate) => fs.existsSync(candidate));
  assert.ok(chrome, 'Chrome не найден');
  let browser;
  try {
    const created = await json(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-wait' },
      body: JSON.stringify({ agent: 'social', text: 'Напиши пост без выдумки' }),
    });
    assert.equal(created.status, 201);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${office.base}/?agent=social`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((text) => {
      const chat = document.querySelector('#panel.open .reply-wait');
      return chat && chat.textContent === text;
    }, { timeout: 8000 }, HELD);
    const heldView = await page.evaluate(() => ({
      wait: document.querySelector('#panel.open .reply-wait').textContent,
      fake: [...document.querySelectorAll('#panel.open .msg-row.agent')].map((el) => el.textContent).join('\n'),
      thinks: document.body.textContent.includes('Думает'),
      typing: document.querySelectorAll('.typing').length,
    }));
    assert.equal(heldView.wait, HELD);
    assert.equal(heldView.fake, '');
    assert.equal(heldView.thinks, false);
    assert.equal(heldView.typing, 0);

    await page.goto(`${office.base}/#agent=social&view=dashboard&tab=chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((text) => {
      const note = document.querySelector('#agentDash .reply-wait');
      return note && note.textContent === text;
    }, { timeout: 8000 }, HELD);

    const saved = await json(office.base, '/api/delivery/putin', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-wait' },
      body: JSON.stringify({ url: hookUrl, key: 'wait-key' }),
    });
    assert.equal(saved.status, 200);
    await page.goto(`${office.base}/?agent=social`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((text) => {
      const chat = document.querySelector('#panel.open .reply-wait');
      return chat && chat.textContent === text;
    }, { timeout: 8000 }, WAIT);
    const waiting = await page.evaluate(() => ({
      typing: document.querySelectorAll('.typing').length,
      thinks: document.body.textContent.includes('Думает'),
      agentRows: document.querySelectorAll('#panel.open .msg-row.agent').length,
    }));
    assert.equal(waiting.typing, 0);
    assert.equal(waiting.thinks, false);
    assert.equal(waiting.agentRows, 0);

    const reply = await json(office.base, '/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-wait' },
      body: JSON.stringify({ agentId: 'social', role: 'agent', taskId: created.body.id, text: 'Пост вышел' }),
    });
    assert.equal(reply.status, 201);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const chat = document.querySelector('#panel.open [data-anchor="chat"]');
      return chat && chat.textContent.includes('Пост вышел') && !chat.querySelector('.reply-wait');
    }, { timeout: 8000 });
  } finally {
    if (browser) await browser.close();
    await stopOffice(office);
    await new Promise((resolve) => hook.close(resolve));
  }
});
