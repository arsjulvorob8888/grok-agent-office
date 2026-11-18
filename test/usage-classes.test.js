'use strict';

// План и процент лимита должны нести классы, на которые уже смотрит CSS.
// Иначе warn/critical не красят подписи, а на 390px длинный план раздувает шапку.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

function openTagById(source, id) {
  const re = /<([a-zA-Z][\w:-]*)(\s[^<>]*?)>/g;
  let match;
  while ((match = re.exec(source))) {
    const idAttr = /\bid\s*=\s*["']([^"']+)["']/i.exec(match[2]);
    if (!idAttr || idAttr[1] !== id) continue;
    const classAttr = /\bclass\s*=\s*["']([^"']*)["']/i.exec(match[2]);
    return {
      tag: match[1],
      classes: classAttr ? classAttr[1].trim().split(/\s+/).filter(Boolean) : [],
    };
  }
  return null;
}

function cssRules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const selector = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (selector.startsWith('@')) rules.push(...cssRules(body));
    else if (selector) rules.push({ selector, body });
    i = j;
  }
  return rules;
}

function splitSelectors(selector) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const ch of selector) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (rgb) return `${rgb[1]},${rgb[2]},${rgb[3]}`;
  return raw;
}

function levelColorRules(source) {
  const found = [];
  for (const rule of cssRules(source)) {
    const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(rule.body);
    if (!color) continue;
    for (const selector of splitSelectors(rule.selector)) {
      const level = /\[data-level\s*=\s*["']warn["']\]/i.test(selector) ? 'warn'
        : /\[data-level\s*=\s*["']critical["']\]/i.test(selector) ? 'critical'
          : '';
      const target = /\.usage-pct\s*$/.test(selector) ? 'pct'
        : /\.usage-plan\s*$/.test(selector) ? 'plan'
          : '';
      if (!level || !target) continue;
      found.push({
        level,
        target,
        selector,
        color: parseColor(color[1]),
      });
    }
  }
  return found;
}

const LEVEL_RULES = levelColorRules(css);

test('в CSS есть селекторы warn и critical для .usage-plan и .usage-pct', () => {
  for (const level of ['warn', 'critical']) {
    for (const target of ['plan', 'pct']) {
      const rule = LEVEL_RULES.find((item) => item.level === level && item.target === target);
      assert.ok(rule, `нет селектора ${level} для .usage-${target}`);
      assert.match(rule.color, /^\d+,\d+,\d+$/);
    }
  }
});

test('в разметке у #usagePlan и #usagePct есть классы usage-plan и usage-pct', () => {
  const plan = openTagById(html, 'usagePlan');
  const pct = openTagById(html, 'usagePct');
  assert.ok(plan, 'в public/index.html нет #usagePlan');
  assert.ok(pct, 'в public/index.html нет #usagePct');
  assert.ok(
    plan.classes.includes('usage-plan'),
    `#usagePlan без класса usage-plan, сейчас: ${plan.classes.join(' ') || '(класса нет)'}`,
  );
  assert.ok(
    pct.classes.includes('usage-pct'),
    `#usagePct без класса usage-pct, сейчас: ${pct.classes.join(' ') || '(класса нет)'}`,
  );
});

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((item) => item && fs.existsSync(item));

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) { /* зависимости нет */ }

if (!CHROME || !puppeteer) {
  test('селекторы warn и critical срабатывают на плане и проценте', { skip: CHROME ? 'нет puppeteer-core' : 'Chrome не найден' }, () => {});
} else {
  let browser;
  let server;
  let base;

  before(async () => {
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kremlin-usage-classes-'));
    process.env.APP_PASSWORD = 'pw-usage-classes';
    process.env.AGENT_TOKEN = 'tok-usage-classes';
    process.env.AGENT_STATUS_TOKEN = 'status-usage-classes';
    process.env.PUBLIC_URL = 'http://127.0.0.1';
    delete process.env.KREMLIN_WEBHOOK_URL;
    delete process.env.GROK_WEBHOOK_URL;
    delete process.env.PORYADOK_INGEST_TOKEN;
    const { app } = require('../server.js');
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function postUsage(body) {
    const res = await fetch(`${base}/api/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-usage-classes' },
      body: JSON.stringify({
        plan: 'Super',
        used: body.usedPct,
        limit: 100,
        resetsAt: '2026-11-18T21:00:00.000Z',
        source: 'grok',
        ...body,
      }),
    });
    assert.equal(res.status, 200, `POST /api/usage вернул ${res.status}`);
  }

  async function openAt(width, height) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(`${base}/?theme=day`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#usagePlan');
    await page.waitForSelector('#usagePct');
    await page.evaluate(() => (document.fonts && document.fonts.ready) || null);
    return { page, errors };
  }

  async function showLevel(page, level) {
    await page.waitForFunction((name) => document.querySelector('#grokUsage').dataset.level === name, {}, level);
  }

  function rulesFor(level) {
    return LEVEL_RULES.filter((rule) => rule.level === level).map((rule) => ({
      target: rule.target,
      selector: rule.selector,
      color: rule.color,
    }));
  }

  test('селекторы warn и critical красят план и процент, на 390px шапка не разъезжается', { timeout: 90000 }, async () => {
    const { page, errors } = await openAt(390, 844);
    try {
      const empty = await page.evaluate(() => ({
        planClass: document.querySelector('#usagePlan').className,
        pctClass: document.querySelector('#usagePct').className,
      }));
      assert.equal(empty.planClass, 'usage-plan', `после загрузки у #usagePlan класс «${empty.planClass}», нужен usage-plan`);
      assert.equal(empty.pctClass, 'usage-pct', `после загрузки у #usagePct класс «${empty.pctClass}», нужен usage-pct`);

      async function expectLevel(level) {
        await showLevel(page, level);
        const hit = await page.evaluate((rules) => {
          const plan = document.querySelector('#usagePlan');
          const pct = document.querySelector('#usagePct');
          const top = document.querySelector('.usage-top').getBoundingClientRect();
          const planBox = plan.getBoundingClientRect();
          const pctBox = pct.getBoundingClientRect();
          const planStyle = getComputedStyle(plan);
          const pctStyle = getComputedStyle(pct);
          const paint = (value) => {
            const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value || '');
            return match ? `${match[1]},${match[2]},${match[3]}` : value;
          };
          return {
            planClass: plan.className,
            pctClass: pct.className,
            planSize: planStyle.fontSize,
            pctSize: pctStyle.fontSize,
            planWeight: planStyle.fontWeight,
            pctWeight: pctStyle.fontWeight,
            flushRight: Math.abs(top.right - pctBox.right) <= 1,
            matches: rules.map((rule) => {
              const el = rule.target === 'pct' ? pct : plan;
              return {
                selector: rule.selector,
                selected: [...document.querySelectorAll(rule.selector)].includes(el),
                color: paint(getComputedStyle(el).color),
                expected: rule.color,
              };
            }),
          };
        }, rulesFor(level));
        assert.equal(hit.planClass, 'usage-plan', `на уровне ${level} у #usagePlan класс ${hit.planClass || '(пусто)'}`);
        assert.equal(hit.pctClass, 'usage-pct', `на уровне ${level} у #usagePct класс ${hit.pctClass || '(пусто)'}`);
        assert.equal(hit.planSize, '12px', `на уровне ${level} у плана шрифт ${hit.planWeight} ${hit.planSize}`);
        assert.equal(hit.pctSize, '12px', `на уровне ${level} у процента шрифт ${hit.pctWeight} ${hit.pctSize}`);
        assert.equal(hit.planWeight, '700');
        assert.equal(hit.pctWeight, '700');
        assert.equal(hit.flushRight, true, `на уровне ${level} процент не прижат вправо (margin-left:auto)`);
        for (const row of hit.matches) {
          assert.equal(row.selected, true, `${row.selector} не срабатывает на элементе`);
          assert.equal(row.color, row.expected, `${row.selector} не красит элемент: ${row.color} вместо ${row.expected}`);
        }
      }

      await postUsage({ usedPct: 80, plan: 'Super' });
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await expectLevel('warn');
      await assertHeaderFits(page, 'warn');

      await postUsage({ usedPct: 80, plan: 'Ж'.repeat(40) });
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await showLevel(page, 'warn');
      await assertHeaderFits(page, 'длинный план');

      await postUsage({ usedPct: 95, plan: 'Super' });
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await expectLevel('critical');
      await assertHeaderFits(page, 'critical');
      const banner = await page.evaluate(() => {
        const usage = document.querySelector('#grokUsage').getBoundingClientRect();
        const box = document.querySelector('#usageBanner').getBoundingClientRect();
        return {
          hidden: document.querySelector('#usageBanner').hidden,
          overlapsUsage: box.top < usage.bottom - 1 && box.bottom > usage.top + 1 && box.left < usage.right - 1 && box.right > usage.left + 1,
        };
      });
      assert.equal(banner.hidden, false);
      assert.equal(banner.overlapsUsage, false, 'баннер пересекает виджет лимита');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

async function assertHeaderFits(page, label) {
  const layout = await page.evaluate(() => {
    const vw = window.innerWidth;
    function classText(el) {
      if (typeof el.className === 'string') return el.className;
      return el.getAttribute('class') || '';
    }
    function nameOf(el) {
      if (el.id) return `#${el.id}`;
      const cls = classText(el).trim().split(/\s+/).filter(Boolean)[0];
      return cls ? `.${cls}` : el.tagName.toLowerCase();
    }
    function shown(el) {
      if (!el || el.hidden) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0.5 && box.height > 0.5;
    }
    function overlaps(a, b) {
      return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
    }
    const hits = [];
    const outside = [];
    function walk(parent) {
      if (parent.tagName === 'svg') return;
      const kids = [...parent.children].filter((el) => {
        const style = getComputedStyle(el);
        if (style.position === 'absolute' || style.position === 'fixed') return false;
        return shown(el);
      });
      for (let i = 0; i < kids.length; i += 1) {
        const box = kids[i].getBoundingClientRect();
        if (box.left < -1 || box.right > vw + 1) outside.push(nameOf(kids[i]));
        for (let j = i + 1; j < kids.length; j += 1) {
          if (overlaps(box, kids[j].getBoundingClientRect())) hits.push(`${nameOf(kids[i])} × ${nameOf(kids[j])}`);
        }
        walk(kids[i]);
      }
    }
    const hud = document.querySelector('.hud');
    walk(hud);
    const hudBox = hud.getBoundingClientRect();
    return {
      docOverflow: document.documentElement.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1,
      hudOutside: hudBox.left < -1 || hudBox.right > vw + 1,
      scrollWidth: document.documentElement.scrollWidth,
      vw,
      hits,
      outside,
    };
  });
  assert.equal(layout.docOverflow, false, `${label}: горизонтальный скролл ${layout.scrollWidth}px при ширине ${layout.vw}px`);
  assert.equal(layout.hudOutside, false, `${label}: шапка вылезает за экран`);
  assert.deepEqual(layout.outside, [], `${label}: за экран вылезает ${layout.outside.join(', ')}`);
  assert.deepEqual(layout.hits, [], `${label}: в шапке пересекаются ${layout.hits.join(', ')}`);
}
