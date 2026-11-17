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
    devops: 'devops', qa: 'qa',
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
