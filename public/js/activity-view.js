/* Пульс «работает» и сон «отдыхает» на фигурке и в полосе. Слушает опрос /api/state. */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  let agents = [];
  let lastEvent = 0;

  function trunc(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    return `${t.slice(0, n - 1).trimEnd()}…`;
  }

  function camera() {
    const world = document.getElementById('world');
    const tr = (world && world.getAttribute('transform')) || '';
    const m = /translate\(\s*([-\d.]+)[ ,]([-\d.]+)\s*\)\s*scale\(\s*([-\d.]+)\s*\)/.exec(tr);
    if (!m) return { tx: 0, ty: 0, k: 1 };
    return { tx: +m[1], ty: +m[2], k: +m[3] || 1 };
  }

  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  function ensureRing(g) {
    let ring = g.querySelector(':scope > .pulse-ring');
    if (ring) return;
    ring = document.createElementNS(SVGNS, 'ellipse');
    ring.setAttribute('class', 'pulse-ring');
    ring.setAttribute('cx', '0');
    ring.setAttribute('cy', '-6');
    ring.setAttribute('rx', '58');
    ring.setAttribute('ry', '74');
    g.insertBefore(ring, g.firstChild);
  }

  function ensureChipBits(chip) {
    if (!chip.querySelector('.chip-zzz')) {
      const z = document.createElement('span');
      z.className = 'chip-zzz';
      z.setAttribute('aria-hidden', 'true');
      z.textContent = '💤';
      chip.appendChild(z);
    }
    if (!chip.querySelector('.chip-task')) {
      const cap = document.createElement('span');
      cap.className = 'chip-task';
      chip.appendChild(cap);
    }
  }

  function markerFor(id) {
    const overlay = document.getElementById('overlay');
    if (!overlay) return null;
    let el = overlay.querySelector(`.act-marker[data-id="${CSS.escape(id)}"]`);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'act-marker';
    el.dataset.id = id;
    el.innerHTML = '<span class="act-zzz" aria-hidden="true">💤</span><span class="act-caption"></span>';
    overlay.insertBefore(el, overlay.firstChild);
    return el;
  }

  function paint() {
    const byId = new Map(agents.map((a) => [a.id, a]));
    document.querySelectorAll('#agents .agent').forEach((g) => {
      const a = byId.get(g.dataset.id);
      if (!a) return;
      const working = a.activity === 'working';
      g.classList.toggle('pulse', working);
      g.classList.toggle('sleep', !working);
      ensureRing(g);
    });
    document.querySelectorAll('#roster .chip').forEach((chip) => {
      const a = byId.get(chip.dataset.id);
      if (!a) return;
      const working = a.activity === 'working';
      chip.classList.toggle('pulse', working);
      chip.classList.toggle('sleep', !working);
      ensureChipBits(chip);
      const cap = chip.querySelector('.chip-task');
      const text = working && a.currentTask ? trunc(a.currentTask, 18) : '';
      setText(cap, text);
      if (a.currentTask) cap.title = a.currentTask;
      else cap.removeAttribute('title');
      const z = chip.querySelector('.chip-zzz');
      if (z) z.title = working ? '' : 'Отдыхает';
    });
    const seen = new Set();
    for (const a of agents) {
      const el = markerFor(a.id);
      if (!el) continue;
      seen.add(a.id);
      const working = a.activity === 'working';
      el.classList.toggle('pulse', working);
      el.classList.toggle('sleep', !working);
      const cap = el.querySelector('.act-caption');
      const text = working && a.currentTask ? trunc(a.currentTask, 32) : '';
      setText(cap, text);
      if (a.currentTask) cap.title = a.currentTask;
      else cap.removeAttribute('title');
      const name = a.id === 'grok' ? 'Главный агент' : (a.name || a.id);
      el.setAttribute('aria-label', working
        ? `${name} работает${a.currentTask ? `: ${a.currentTask}` : ''}`
        : `${name} отдыхает`);
      el.dataset.x = String(a.x);
      el.dataset.y = String(a.y);
    }
    document.querySelectorAll('#overlay .act-marker').forEach((el) => {
      if (!seen.has(el.dataset.id)) el.remove();
    });
    place();
  }

  function place() {
    const { tx, ty, k } = camera();
    const hud = document.querySelector('.hud');
    const hudBottom = hud ? hud.getBoundingClientRect().bottom : 0;
    document.querySelectorAll('#overlay .act-marker').forEach((el) => {
      const x = Number(el.dataset.x);
      const y = Number(el.dataset.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const sx = x * k + tx;
      const sy = (y - 78) * k + ty;
      const off = sx < -40 || sx > innerWidth + 40 || sy < -30 || sy > innerHeight + 30;
      const underHud = sy < hudBottom + 18;
      el.classList.toggle('hide', off || underHud);
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
    });
  }

  function take(data) {
    agents = ((data && data.agents) || []).filter((a) => a && !a.archived);
    paint();
  }

  document.addEventListener('officestate', (e) => {
    lastEvent = Date.now();
    take(e.detail);
  });

  const agentsRoot = document.getElementById('agents');
  if (agentsRoot) {
    new MutationObserver(() => paint()).observe(agentsRoot, { childList: true });
  }
  const roster = document.getElementById('roster');
  if (roster) {
    new MutationObserver(() => paint()).observe(roster, { childList: true });
  }

  async function fallback() {
    if (Date.now() - lastEvent < 6000) return;
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return;
    lastEvent = Date.now();
    take(await res.json());
  }
  setInterval(() => { fallback().catch(() => {}); }, 4000);

  window.ActivityView = { paint, place, take };
})();
