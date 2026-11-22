'use strict';

// Четыре голых пятна восточнее Кремля: в прямоугольниках холста должна быть
// застройка теми же кварталами, что и на остальной карте. Координаты агентов
// берём из витрины MAP_POS, чтобы проверка шла по тем же местам, что на экране.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');

function loadMap() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/figures.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/map.js'), 'utf8'), sandbox);
  return sandbox.window.MoscowMap;
}

function mapAgents(M) {
  const src = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const body = src.match(/const MAP_POS = \{([\s\S]*?)\};/);
  assert.ok(body, 'MAP_POS не найден');
  const kind = {
    grok: 'putin', blog: 'blog', dev: 'dev', social: 'social', poker: 'poker',
    finance: 'finance', routines: 'routines', army: 'army', temshik: 'temshik',
    devops: 'devops', qa: 'qa', health: 'health',
  };
  const agents = [];
  for (const item of body[1].matchAll(/(\w+):\s*\[(\d+),\s*(\d+)\]/g)) {
    const id = item[1];
    agents.push({
      id,
      x: +item[2],
      y: +item[3],
      tall: Math.min(M.TALL[kind[id]] || M.TALL.generic, 200) + 20,
    });
  }
  return agents;
}

function blockCenters(html) {
  const re = /<rect class="bf" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"\/><rect class="bt" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const x = +m[1];
    const w = +m[3];
    const h = +m[4];
    const d = +m[8];
    out.push({ cx: x + w / 2, cy: +m[2] + h - d / 2, x, y: +m[2] + h - d, w, d, h });
  }
  return out;
}

// Прямоугольники голой земли внутри четырёх рамок владельца.
const ZONES = [
  { id: 'sadovoe-ne', x0: 1056, y0: 308, x1: 1094, y1: 348, min: 3 },
  { id: 'yauza-bank', x0: 1094, y0: 438, x1: 1150, y1: 484, min: 3 },
  { id: 'east-ring', x0: 1136, y0: 606, x1: 1198, y1: 632, min: 2 },
  { id: 'south-east-lot', x0: 1172, y0: 698, x1: 1268, y1: 746, min: 5 },
];

test('в четырёх пустых кварталах у Садового есть городская застройка', () => {
  const M = loadMap();
  const agents = mapAgents(M);
  const finance = agents.find((a) => a.id === 'finance');
  const qa = agents.find((a) => a.id === 'qa');
  assert.deepEqual([finance.x, finance.y], [1300, 490]);
  assert.deepEqual([qa.x, qa.y], [1500, 740]);

  const centers = blockCenters(M.buildBlocks(agents));
  for (const z of ZONES) {
    const n = centers.filter((b) => b.cx >= z.x0 && b.cx <= z.x1 && b.cy >= z.y0 && b.cy <= z.y1).length;
    assert.ok(n >= z.min, `${z.id}: кварталов ${n}, нужно не меньше ${z.min}`);
  }
});

test('заливка не сажает квартал на точку агента', () => {
  const M = loadMap();
  const agents = mapAgents(M);
  const centers = blockCenters(M.buildBlocks(agents));
  for (const a of agents) {
    const hit = centers.find((b) => b.x < a.x && b.x + b.w > a.x && b.y - b.h < a.y && b.y + b.d > a.y);
    assert.equal(hit, undefined, `${a.id} перекрыт кварталом`);
  }
});

// Три бежевых квартала у Яузы и отложенный клин Садового. Числа — минимумы
// центров кварталов внутри рамки, а не «сколько ещё дорисовать».
const FINANCE_QUARTERS = [
  { id: 'north-stalin', x0: 1036, y0: 286, x1: 1196, y1: 452, min: 12 },
  { id: 'finance-left', x0: 1152, y0: 360, x1: 1296, y1: 570, min: 8 },
  { id: 'south-river', x0: 1124, y0: 648, x1: 1440, y1: 820, min: 24 },
  { id: 'yauza-wedge', x0: 956, y0: 490, x1: 1136, y1: 534, min: 3 },
];

test('у Финансов застроены три квартала вдоль Яузы и клин Садового', () => {
  const M = loadMap();
  const centers = blockCenters(M.buildBlocks(mapAgents(M)));
  for (const z of FINANCE_QUARTERS) {
    const n = centers.filter((b) => b.cx >= z.x0 && b.cx <= z.x1 && b.cy >= z.y0 && b.cy <= z.y1).length;
    assert.ok(n >= z.min, `${z.id}: кварталов ${n}, нужно не меньше ${z.min}`);
  }
});

test('добор в четырёх рамках Садового просит не меньше 3, 3, 2 и 5 домов', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/map.js'), 'utf8');
  const got = {};
  for (const item of src.matchAll(/id: '(sadovoe-ne|yauza-bank|east-ring|south-east-lot)', x0: [\d.]+, y0: [\d.]+, x1: [\d.]+, y1: [\d.]+, need: (\d+)/g)) {
    got[item[1]] = +item[2];
  }
  assert.deepEqual(got, {
    'sadovoe-ne': 3,
    'yauza-bank': 3,
    'east-ring': 2,
    'south-east-lot': 5,
  });
});

test('кварталы не перехватывают клики', () => {
  const html = loadMap().buildBlocks(mapAgents(loadMap()));
  const groups = html.match(/<g class="blk /g) || [];
  const muted = html.match(/<g class="blk [^"]*" pointer-events="none">/g) || [];
  assert.ok(groups.length > 0);
  assert.equal(muted.length, groups.length);
});

test('посев Финансов и тестировщика совпадает с витриной карты', () => {
  const agents = mapAgents(loadMap());
  const seed = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const id of ['finance', 'qa']) {
    const block = seed.match(new RegExp(`id: '${id}'[\\s\\S]*?\\bx:\\s*(\\d+),\\s*y:\\s*(\\d+)`));
    assert.ok(block, id);
    const agent = agents.find((a) => a.id === id);
    assert.deepEqual([+block[1], +block[2]], [agent.x, agent.y], id);
  }
});

function fillBlocks(html) {
  const re = /<g class="blk b\d fill" pointer-events="none"><rect class="bf" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"\/><rect class="bt" x="[\d.-]+" y="[\d.-]+" width="[\d.-]+" height="([\d.-]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const x = +m[1];
    const w = +m[3];
    const h = +m[4];
    const d = +m[5];
    out.push({ x, y: +m[2] + h - d, w, d, h, cx: x + w / 2, cy: +m[2] + h - d / 2 });
  }
  return out;
}

function distRectPoint(b, px, py) {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.d));
  return Math.hypot(dx, dy);
}

function minDistLine(b, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const c = line[i];
    for (let t = 0; t <= 1; t += 0.08) {
      best = Math.min(best, distRectPoint(b, a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t));
    }
  }
  return best;
}

function ellipseSamples(ring) {
  const out = [];
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    out.push([ring.cx + ring.rx * Math.cos(a), ring.cy + ring.ry * Math.sin(a)]);
  }
  return out;
}

function quadSamples(x0, y0, x1, y1, bend, drop) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(1, Math.hypot(dx, dy));
  const cx = (x0 + x1) / 2 - (dy / len) * bend;
  const cy = (y0 + y1) / 2 + (dx / len) * bend - drop;
  const out = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const u = 1 - t;
    out.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
  }
  return out;
}

test('новый добор не наезжает на дорогу, реку, метку и стрелку задачи', () => {
  const M = loadMap();
  const agents = mapAgents(M);
  const fills = fillBlocks(M.buildBlocks(agents));
  assert.ok(fills.length >= 16, `доборных кварталов ${fills.length}`);
  const yauza = M.sampleSmooth(M.YAUZA, 10);
  const garden = ellipseSamples(M.RINGS.garden);
  const ttk = ellipseSamples(M.RINGS.ttk);
  const grok = agents.find((a) => a.id === 'grok');
  const arrows = [];
  for (const a of agents) {
    if (a.id === 'grok') continue;
    arrows.push(quadSamples(grok.x, grok.y + 22, a.x, a.y + 14, Math.hypot(a.x - grok.x, a.y - grok.y) * 0.16, 0));
    const len = Math.max(1, Math.hypot(a.x - grok.x, (a.y - 86) - (grok.y - 78)));
    const mag = Math.min(120, len * 0.22);
    arrows.push(quadSamples(grok.x, grok.y - 78, a.x, a.y - 86, mag, 28));
    arrows.push(quadSamples(grok.x, grok.y - 78, a.x, a.y - 86, -mag, 28));
  }
  for (const b of fills) {
    let radial = Infinity;
    for (const [a, c] of M.RADIALS) radial = Math.min(radial, minDistLine(b, [a, c]));
    assert.ok(radial >= 6, `радиальная ${radial.toFixed(1)} у ${b.cx.toFixed(0)},${b.cy.toFixed(0)}`);
    const onGarden = Math.min(...garden.map((p) => distRectPoint(b, p[0], p[1])));
    const onTtk = Math.min(...ttk.map((p) => distRectPoint(b, p[0], p[1])));
    assert.ok(onGarden >= 8, `Садовое ${onGarden.toFixed(1)}`);
    assert.ok(onTtk >= 8, `ТТК ${onTtk.toFixed(1)}`);
    assert.ok(minDistLine(b, M.RIVER_LINE) >= 18, 'Москва-река');
    assert.ok(minDistLine(b, yauza) >= 6, 'Яуза');
    for (const a of agents) {
      assert.ok(!(b.x < a.x && b.x + b.w > a.x && b.y < a.y + 52 && b.y + b.d > a.y + 40), `${a.id} метка`);
    }
    for (const line of arrows) {
      const gap = Math.min(...line.map((p) => distRectPoint(b, p[0], p[1])));
      assert.ok(gap >= 4, `стрелка ${gap.toFixed(1)} у ${b.cx.toFixed(0)},${b.cy.toFixed(0)}`);
    }
  }
});
