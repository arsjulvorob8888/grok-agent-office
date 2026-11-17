/* Агенты · Москва — игровая карта штаба GROK. Чистый JS, без сборки. */
(function () {
  'use strict';

  // ── Настройки клиента ────────────────────────────────────────────────────
  // Сам ростер (имена, цвета, обязанности, место на карте) приходит с сервера:
  // см. SEED_AGENTS в server.js. 8-е направление — агент slot8 («Свободное направление»).
  const CONFIG = {
    pollMs: 4000,
    mainId: 'grok',
    xpPerTask: 100, // опыт за выполненную задачу
    xpPerSent: 10, // опыт за полученную задачу
    figScale: { main: 1.15, dept: 0.92, extra: 0.8 },
  };

  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const M = window.MoscowMap;

  const svg = $('#map'), world = $('#world'), overlay = $('#overlay');
  const S = {
    agents: [], tasks: [], byId: new Map(), selected: null, loaded: false, sig: '',
    taskStatus: new Map(), cam: { k: 1, tx: 0, ty: 0 }, userMoved: false,
    els: new Map(), // id -> {g, tag, bubble, link, packets}
    sound: localStorage.getItem('soundOn') === '1',
  };
  const params = new URLSearchParams(location.search);

  // ── Тема ─────────────────────────────────────────────────────────────────
  function initTheme() {
    let t = params.get('theme') || localStorage.getItem('theme');
    if (!t) { const h = new Date().getHours(); t = h >= 19 || h < 7 ? 'night' : 'day'; }
    setTheme(t, false);
    $('#btnTheme').onclick = () => { setTheme(document.body.classList.contains('night') ? 'day' : 'night', true); blip(660); };
  }
  function setTheme(t, save) {
    document.body.classList.toggle('night', t === 'night');
    document.body.classList.toggle('day', t !== 'night');
    if (save) localStorage.setItem('theme', t);
  }

  // ── Звук (выключен по умолчанию) ─────────────────────────────────────────
  let actx = null;
  function tone(freq, dur = 0.12, type = 'sine', vol = 0.06, delay = 0) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (_) { /* без звука */ }
  }
  const blip = (f = 880) => tone(f, 0.08, 'triangle', 0.04);
  const chime = () => { tone(784, 0.18, 'sine', 0.07); tone(988, 0.18, 'sine', 0.07, 0.1); tone(1319, 0.35, 'sine', 0.06, 0.2); };
  const whoosh = () => { tone(440, 0.1, 'triangle', 0.04); tone(660, 0.14, 'triangle', 0.04, 0.07); };
  function initSound() {
    const b = $('#btnSound');
    const upd = () => { b.classList.toggle('on', S.sound); b.title = S.sound ? 'Звук включён' : 'Звук выключен'; };
    upd();
    b.onclick = () => { S.sound = !S.sound; localStorage.setItem('soundOn', S.sound ? '1' : '0'); upd(); blip(990); };
  }

  // ── Статические слои карты ───────────────────────────────────────────────
  function buildStatic() {
    $('#mapBase').innerHTML = M.buildBase();
    $('#mapLabels').innerHTML = M.buildLabels();
    $('#landmarks').innerHTML = M.buildLandmarks();
    buildCars();
  }
  function buildCars() {
    const g = $('#cars');
    let s = '';
    M.RADIALS.forEach(([a, b], i) => { s += `<path id="rad-${i}" d="M${a}L${b}" fill="none"/>`; });
    const day = ['#e63946', '#1d3557', '#f4a261', '#2a9d8f', '#ffffff', '#264653', '#e9c46a', '#8d99ae'];
    const car = (path, dur, begin, i, rev) =>
      `<g class="car"><rect class="car-body" x="-3.6" y="-1.9" width="7.2" height="3.8" rx="1.4" style="fill:${day[i % day.length]}"/>` +
      `<animateMotion dur="${dur}s" begin="-${begin.toFixed(1)}s" repeatCount="indefinite" rotate="auto"${rev ? ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"' : ''}><mpath href="#${path}"/></animateMotion></g>`;
    for (let i = 0; i < 14; i++) s += car('ring-garden', 70, (70 / 14) * i, i, i % 2);
    for (let i = 0; i < 18; i++) s += car('ring-ttk', 110, (110 / 18) * i + 2, i + 3, i % 3 === 0);
    M.RADIALS.forEach((_, r) => { for (let i = 0; i < 3; i++) s += car(`rad-${r}`, 26 + r * 2, i * 9 + r, i + r, i === 1); });
    g.innerHTML = s;
  }

  // ── Агенты на карте ──────────────────────────────────────────────────────
  const tierOf = (a) => (a.id === CONFIG.mainId ? 'main' : a.tier === 'extra' ? 'extra' : 'dept');
  const tallOf = (a) => M.TALL[a.kind] || M.TALL.generic;
  const figScaleOf = (a) => CONFIG.figScale[tierOf(a)];
  const figFeet = (a) => (tierOf(a) === 'main' ? 38 : 32);
  const figTop = (a) => figFeet(a) - 100 * figScaleOf(a);
  const kremlin = () => { const g = S.byId.get(CONFIG.mainId); return g ? [g.x, g.y + 22] : [800, 562]; };

  function levelInfo(a) {
    const sent = S.tasks.filter((t) => t.agent === a.id).length;
    const xp = (a.completed || 0) * CONFIG.xpPerTask + sent * CONFIG.xpPerSent;
    let lvl = 1, need = 150, base = 0;
    while (xp >= base + need) { base += need; lvl++; need = 150 + (lvl - 1) * 75; }
    return { xp, lvl, into: xp - base, need, sent };
  }

  function agentSig(list) {
    return list.map((a) => [a.id, a.kind, a.color, a.name, a.vacant, a.x, a.y, a.tier].join('|')).join(';');
  }

  function buildAgents() {
    const gA = $('#agents'), gL = $('#links');
    gA.innerHTML = ''; gL.innerHTML = ''; overlay.innerHTML = '';
    S.els.clear();
    const [kx, ky] = kremlin();
    const sorted = [...S.agents].sort((a, b) => a.y - b.y);
    for (const a of sorted) {
      const tier = tierOf(a);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `agent tier-${tier} st-${a.status}`);
      g.setAttribute('transform', `translate(${a.x},${a.y})`);
      g.dataset.id = a.id;
      g.style.setProperty('--agent-glow', Figures.shade(a.color, 0.55));
      const plot = tier === 'main'
        ? `<ellipse class="plot-ring" cx="0" cy="${figFeet(a)}" rx="46" ry="14" stroke="#f5c451"/>`
        : `<ellipse class="plot" cx="0" cy="14" rx="${tier === 'extra' ? 70 : 82}" ry="${tier === 'extra' ? 30 : 34}" fill="${a.color}" fill-opacity=".17" stroke="${a.color}" stroke-opacity=".6" stroke-width="2.4" stroke-dasharray="${a.vacant ? '7 5' : 'none'}"/>
           <ellipse class="plot-ring" cx="0" cy="14" rx="${tier === 'extra' ? 78 : 92}" ry="${tier === 'extra' ? 35 : 40}" stroke="#f5c451"/>`;
      const bld = tier === 'main' ? M.building('putin', a.color) : M.building(a.kind || 'generic', a.color);
      const beaconY = tier === 'main' ? figTop(a) - 30 : -Math.min(tallOf(a), 150) - 12;
      g.innerHTML = `${plot}<g class="bld">${bld}</g>
        <g class="beacon" transform="translate(0,${beaconY})"><circle r="9" fill="${a.color}" opacity=".7"/></g>
        <g class="fig-wrap" transform="translate(${tier === 'main' ? 0 : 0},${figFeet(a)}) scale(${figScaleOf(a)})">${Figures.render(a.kind, a.color)}</g>`;
      gA.appendChild(g);

      let link = null, packets = null;
      if (tier !== 'main') {
        const x1 = a.x, y1 = a.y + 14, dx = x1 - kx, dy = y1 - ky, len = Math.hypot(dx, dy);
        const cx = (kx + x1) / 2 - (dy / len) * len * 0.16, cy = (ky + y1) / 2 + (dx / len) * len * 0.16;
        link = document.createElementNS(NS, 'path');
        link.setAttribute('id', `link-${a.id}`);
        link.setAttribute('class', 'link');
        link.setAttribute('d', `M${kx},${ky}Q${cx.toFixed(1)},${cy.toFixed(1)} ${x1},${y1}`);
        link.setAttribute('stroke', a.color);
        gL.appendChild(link);
        packets = document.createElementNS(NS, 'g');
        packets.setAttribute('class', 'packet');
        const dur = Math.max(2.2, len / 140).toFixed(1);
        packets.innerHTML = [0, 1, 2].map((i) => `<g><circle r="7" fill="${a.color}" opacity=".6"/><circle r="3.6" fill="#fff"/><animateMotion dur="${dur}s" begin="-${(i * dur / 3).toFixed(2)}s" repeatCount="indefinite"><mpath href="#link-${a.id}"/></animateMotion></g>`).join('');
        gL.appendChild(packets);
      }

      const tag = document.createElement('div');
      tag.className = `tag ${tier}`;
      tag.style.setProperty('--c', a.color);
      tag.dataset.id = a.id;
      tag.onclick = (e) => { e.stopPropagation(); select(a.id); };
      overlay.appendChild(tag);
      const bubble = document.createElement('div');
      bubble.className = 'bubble hide';
      bubble.onclick = (e) => { e.stopPropagation(); select(a.id); };
      overlay.appendChild(bubble);
      S.els.set(a.id, { g, tag, bubble, link, packets, w: 0 });
    }
    buildRoster();
    buildMiniDots();
  }

  function updateAgents() {
    for (const a of S.agents) {
      const e = S.els.get(a.id);
      if (!e) continue;
      const tier = tierOf(a), L = levelInfo(a);
      e.g.setAttribute('class', `agent tier-${tier} st-${a.status}${S.selected === a.id ? ' sel' : ''}`);
      e.tag.className = `tag ${tier}${S.selected === a.id ? ' sel' : ''}`;
      const short = tier === 'main' ? 'GROK · Главный агент' : a.name;
      e.tag.innerHTML = `<span class="lvl">${a.vacant ? '?' : L.lvl}</span><span class="nm">${esc(short)}</span><span class="dot ${a.status}"></span>`;
      e.w = 0;
      const show = !a.vacant && (a.status === 'working' || a.status === 'waiting') && a.now;
      e.bubble.className = `bubble ${a.status}${show ? '' : ' hide'}`;
      e.bubbleOn = !!show;
      e.bubble.innerHTML = (a.status === 'working' ? '<span class="typing"><i></i><i></i><i></i></span>' : '') + esc(a.now || '');
      if (e.link) {
        const hot = a.status === 'working';
        e.link.setAttribute('class', `link${hot ? ' hot' : ''}${S.selected === a.id ? ' sel' : ''}`);
        e.packets.setAttribute('class', `packet${hot ? ' on' : ''}`);
      }
    }
    updateRoster();
    doPlaceOverlay();
  }

  // ── Камера ───────────────────────────────────────────────────────────────
  function viewRect() {
    const w = innerWidth, h = innerHeight, mob = w <= 700;
    const hud = $('.hud').getBoundingClientRect();
    const ros = $('#roster').getBoundingClientRect();
    let left = 0, right = w, top = hud.bottom + 8, bottom = (ros.height ? ros.top : h) - 8;
    const j = $('#journal');
    if (!mob && w > 900 && !j.classList.contains('collapsed') && getComputedStyle(j).display !== 'none') left = j.getBoundingClientRect().right + 8;
    if (S.selected && $('#panel').classList.contains('open')) {
      // Берём итоговые размеры панели, а не текущие (панель может ещё выезжать).
      const p = $('#panel');
      if (mob) bottom = Math.min(bottom, h - p.offsetHeight); else right = Math.min(right, w - 12 - p.offsetWidth - 8);
    }
    return { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2, w: right - left, h: bottom - top };
  }
  function applyCam() {
    const { k, tx, ty } = S.cam;
    world.setAttribute('transform', `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${k.toFixed(4)})`);
    document.body.classList.toggle('zoom-far', k < 0.55);
    placeOverlay();
    updateMiniView();
  }
  function clampCam() {
    const c = S.cam, w = innerWidth, h = innerHeight;
    c.k = Math.max(0.22, Math.min(2.6, c.k));
    const wx = (w / 2 - c.tx) / c.k, wy = (h / 2 - c.ty) / c.k;
    const cx = Math.max(0, Math.min(M.W, wx)), cy = Math.max(0, Math.min(M.H, wy));
    c.tx = w / 2 - cx * c.k; c.ty = h / 2 - cy * c.k;
  }
  function homeView() {
    const core = S.agents.filter((a) => tierOf(a) !== 'extra');
    const list = core.length ? core : [{ x: 800, y: 540, kind: 'putin' }];
    const minx = Math.min(...list.map((a) => a.x)) - 105, maxx = Math.max(...list.map((a) => a.x)) + 105;
    const miny = Math.min(...list.map((a) => a.y - Math.min(tallOf(a), 150))) - 10, maxy = Math.max(...list.map((a) => a.y)) + 105;
    const v = viewRect();
    let k = Math.min(v.w / (maxx - minx), v.h / (maxy - miny));
    // На телефоне карта узкая: крупнее масштаб, остальное — свайпом.
    if (innerWidth <= 700) k = Math.max(k, Math.min(0.5, v.h / (maxy - miny)));
    return { x: (minx + maxx) / 2, y: (miny + maxy) / 2 + (innerWidth <= 700 ? 20 : 0), k };
  }
  function setView(x, y, k) {
    const v = viewRect();
    S.cam.k = k; S.cam.tx = v.cx - x * k; S.cam.ty = v.cy - y * k;
    clampCam(); applyCam();
  }
  let flyRaf = 0;
  function flyTo(x, y, k, dur = 900) {
    cancelAnimationFrame(flyRaf);
    const v = viewRect(), c = S.cam;
    const fx = v.cx, fy = v.cy;
    const sx = (fx - c.tx) / c.k, sy = (fy - c.ty) / c.k, sk = c.k;
    k = Math.max(0.22, Math.min(2.6, k));
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = ease(t);
      const kk = Math.exp(Math.log(sk) + (Math.log(k) - Math.log(sk)) * e);
      // лёгкий «подъём камеры» посередине пути
      const lift = 1 - 0.18 * Math.sin(Math.PI * e) * Math.min(1, Math.hypot(x - sx, y - sy) / 600);
      const kz = kk * lift;
      const wx = sx + (x - sx) * e, wy = sy + (y - sy) * e;
      c.k = kz; c.tx = fx - wx * kz; c.ty = fy - wy * kz;
      applyCam();
      if (t < 1) flyRaf = requestAnimationFrame(step);
    };
    flyRaf = requestAnimationFrame(step);
  }
  function goHome(animate = true) {
    const h = homeView();
    if (animate) flyTo(h.x, h.y, h.k); else setView(h.x, h.y, h.k);
  }

  // Пан / зум / пинч
  function initInput() {
    const pts = new Map();
    let moved = 0, start = null, pinch = null;
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cancelAnimationFrame(flyRaf);
      if (pts.size === 1) { moved = 0; start = { x: e.clientX, y: e.clientY, target: e.target }; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.cam.k };
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) { hoverAt(e); return; }
      const p = pts.get(e.pointerId), dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 5) { svg.classList.add('dragging'); S.cam.tx += dx; S.cam.ty += dy; S.userMoved = true; clampCam(); applyCam(); hideTip(); }
      } else if (pts.size === 2 && pinch) {
        moved = 99;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        zoomAt(mx, my, (pinch.k * d) / pinch.d / S.cam.k);
        S.cam.tx += dx / 2; S.cam.ty += dy / 2; clampCam(); applyCam();
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        svg.classList.remove('dragging');
        if (moved <= 5 && start) clickAt(start.target);
      }
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('pointerleave', hideTip);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelAnimationFrame(flyRaf);
      S.userMoved = true;
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (e.target.closest('input,textarea,select')) return;
      if (e.key === 'Escape') { if ($('#modal').classList.contains('show')) closeModal(); else select(null); }
      if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.2);
      if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2);
    });
  }
  function zoomAt(sx, sy, f) {
    const c = S.cam, k2 = Math.max(0.22, Math.min(2.6, c.k * f));
    const wx = (sx - c.tx) / c.k, wy = (sy - c.ty) / c.k;
    c.k = k2; c.tx = sx - wx * k2; c.ty = sy - wy * k2;
    clampCam(); applyCam();
  }
  function clickAt(target) {
    const ag = target.closest && target.closest('.agent');
    if (ag) { select(ag.dataset.id); return; }
    const lm = target.closest && target.closest('.landmark');
    if (lm) {
      blip(740);
      const x = +lm.dataset.x, y = +lm.dataset.y;
      if (lm.dataset.lm === 'kremlin') { select(CONFIG.mainId); return; }
      flyTo(x, y, Math.max(S.cam.k, 1.5));
      toast(lm.dataset.name, landmarkNote(lm.dataset.lm), 'pin');
      return;
    }
    if (S.selected) select(null);
  }
  function landmarkNote(id) {
    return {
      basil: 'Покровский собор на Красной площади, 1561 год.',
      hhs: 'Главный кафедральный собор, у Москвы-реки.',
      kotel: 'Одна из семи сталинских высоток.',
      lenin: 'Самая маленькая из сталинских высоток, у трёх вокзалов.',
      luzh: 'Главный стадион страны.',
      gorky: 'Центральный парк на берегу Москвы-реки.',
    }[id] || '';
  }
  const tip = $('#tooltip');
  function hoverAt(e) {
    const ag = e.target.closest && e.target.closest('.agent');
    const lm = !ag && e.target.closest && e.target.closest('.landmark');
    if (ag) {
      const a = S.byId.get(ag.dataset.id);
      showTip(e, `${a.name} · ${a.district || ''}`);
    } else if (lm) showTip(e, lm.dataset.name);
    else hideTip();
  }
  function showTip(e, text) { tip.textContent = text; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; tip.classList.add('show'); }
  function hideTip() { tip.classList.remove('show'); }

  // ── Таблички и облачка (HTML поверх карты) ───────────────────────────────
  let overlayRaf = 0;
  function placeOverlay() {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; doPlaceOverlay(); });
  }
  function doPlaceOverlay() {
    const { k, tx, ty } = S.cam;
    const compact = k < 0.6;
    const order = [...S.agents].sort((a, b) => prio(b) - prio(a));
    // Панели интерфейса — препятствия для табличек.
    const placed = ['.hud', '#roster', '#minimap', '#journal', '#panel.open'].map((q) => document.querySelector(q)).filter((el) => el && el.offsetParent !== null).map((el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }).filter((r) => r.w > 0);
    const hit = (r) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    for (const a of order) {
      const e = S.els.get(a.id);
      if (!e) continue;
      e.tag.classList.toggle('compact', compact);
      e.w = e.tag.offsetWidth; e.h = e.tag.offsetHeight;
      const sx = a.x * k + tx, sy = (a.y + (tierOf(a) === 'main' ? 84 : 50)) * k + ty;
      const r = { x: sx - e.w / 2, y: sy, w: e.w, h: e.h };
      const off = sx < -150 || sx > innerWidth + 150 || sy < -60 || sy > innerHeight + 60;
      const hidden = off || hit(r);
      e.tag.classList.toggle('hide', hidden);
      e.tag.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,0)`;
      if (!hidden) placed.push(r);
    }
    for (const a of order) {
      const e = S.els.get(a.id);
      if (!e) continue;
      const sx = a.x * k + tx, sy = (a.y + figTop(a) - 8) * k + ty;
      if (!e.bubbleOn || k < 0.42) { e.bubble.classList.add('hide'); continue; }
      const bw = e.bubble.offsetWidth || 150, bh = e.bubble.offsetHeight || 30;
      const r = { x: sx - bw / 2, y: sy - bh, w: bw, h: bh };
      const hidden = hit(r) && S.selected !== a.id;
      e.bubble.classList.toggle('hide', hidden);
      e.bubble.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%)`;
      if (!hidden) placed.push(r);
    }
  }
  function prio(a) {
    return (S.selected === a.id ? 100 : 0) + (tierOf(a) === 'main' ? 50 : 0) + (a.status === 'working' ? 20 : a.status === 'waiting' ? 15 : 0) + (tierOf(a) === 'dept' ? 10 : 0) - (a.vacant ? 5 : 0);
  }

  // ── Ростер и мини-карта ─────────────────────────────────────────────────
  function portrait(a, vb) {
    return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice">${Figures.render(a.kind, a.color)}</svg>`;
  }
  function buildRoster() {
    const r = $('#roster');
    const list = [...S.agents].sort((a, b) => ({ main: 0, dept: 1, extra: 2 }[tierOf(a)] - { main: 0, dept: 1, extra: 2 }[tierOf(b)]) || (a.vacant ? 1 : 0) - (b.vacant ? 1 : 0));
    let html = '', lastTier = null;
    for (const a of list) {
      const t = tierOf(a);
      if (lastTier && t !== lastTier) html += '<span class="roster-sep"></span>';
      lastTier = t;
      html += `<button class="chip ${t}${a.vacant ? ' vacant' : ''}" data-id="${esc(a.id)}" style="--c:${esc(a.color)}" title="${esc(a.name)}">
        <span class="av">${portrait(a, '-27 -100 54 56')}</span><span class="st"></span><span class="lv"></span><span class="cn">${esc(t === 'main' ? 'GROK' : a.name)}</span></button>`;
    }
    r.innerHTML = html;
    r.querySelectorAll('.chip').forEach((c) => (c.onclick = () => select(c.dataset.id)));
  }
  function updateRoster() {
    document.querySelectorAll('#roster .chip').forEach((c) => {
      const a = S.byId.get(c.dataset.id);
      if (!a) return;
      c.classList.toggle('sel', S.selected === a.id);
      c.querySelector('.st').className = `st ${a.status}`;
      c.querySelector('.lv').textContent = a.vacant ? '—' : `${levelInfo(a).lvl}`;
    });
  }
  function buildMiniDots() {
    $('#miniDots').innerHTML = S.agents.map((a) => `<circle class="mini-dot" cx="${a.x}" cy="${a.y}" r="${tierOf(a) === 'main' ? 30 : 22}" fill="${a.color}"/>`).join('');
  }
  function updateMiniView() {
    const { k, tx, ty } = S.cam, r = $('#miniView');
    r.setAttribute('x', (-tx / k).toFixed(0)); r.setAttribute('y', (-ty / k).toFixed(0));
    r.setAttribute('width', (innerWidth / k).toFixed(0)); r.setAttribute('height', (innerHeight / k).toFixed(0));
  }
  function initMinimap() {
    const m = $('#minimap svg');
    m.addEventListener('click', (e) => {
      const pt = m.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(m.getScreenCTM().inverse());
      S.userMoved = true; blip(600);
      flyTo(p.x, p.y, Math.max(S.cam.k, 0.8), 700);
    });
  }

  // ── Выбор агента и панель ────────────────────────────────────────────────
  function select(id) {
    const prev = S.selected;
    S.selected = id && S.byId.has(id) ? id : null;
    const panel = $('#panel');
    if (!S.selected) {
      panel.classList.remove('open');
      updateAgents();
      if (prev) setTimeout(() => { if (!S.selected) goHome(); }, 50);
      return;
    }
    if (prev !== S.selected) blip(prev ? 820 : 700);
    renderPanel();
    panel.classList.add('open');
    updateAgents();
    const a = S.byId.get(S.selected);
    const k = Math.max(innerWidth <= 700 ? 0.95 : 1.15, Math.min(S.cam.k, 1.6));
    setTimeout(() => flyTo(a.x, a.y + figTop(a) / 2 + 10, k), 30);
  }

  const STATUS_TEXT = { working: 'Работает', idle: 'Свободен', waiting: 'Ждёт тебя' };
  function taskBadge(t) {
    if (t.status === 'выполнена') return ['done', 'Выполнена'];
    if (String(t.status).startsWith('не отправлена')) return ['fail', 'Не отправлена'];
    if (t.forwardStatus === 0 || (t.forwardStatus && (t.forwardStatus < 200 || t.forwardStatus >= 300))) return ['fail', 'Ошибка связи'];
    const a = S.byId.get(t.agent);
    const latest = S.tasks.find((x) => x.agent === t.agent);
    if (a && a.status === 'working' && latest && latest.id === t.id) return ['work', 'В работе'];
    return ['sent', 'Отправлена'];
  }
  const ICONS = {
    send: '<path d="M4 12l16-8-6 16-3-6z M11 14l9-10"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    task: '<path d="M8 6h11M8 12h11M8 18h11M4 6h.5M4 12h.5M4 18h.5"/>',
  };
  const ico = (n) => `<svg viewBox="0 0 24 24">${ICONS[n]}</svg>`;
  const fmtTime = (iso) => { try { const d = new Date(iso); return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + (Date.now() - d > 864e5 ? ' · ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : ''); } catch (_) { return ''; } };

  function questHTML(t, showAgent) {
    const a = S.byId.get(t.agent) || { name: t.agent, color: '#64748b' };
    const [cls, label] = taskBadge(t);
    return `<div class="quest" data-agent="${esc(t.agent)}" style="--c:${esc(a.color)}">
      <span class="qi">${ico(cls === 'done' ? 'check' : cls === 'fail' ? 'x' : 'send')}</span>
      <span class="qt">${esc(t.text)}</span>
      <span class="qm"><span class="badge ${cls}">${label}</span>${showAgent ? `<span>${esc(tierOf(a) === 'main' ? 'GROK' : a.name)}</span>·` : ''}<span>${fmtTime(t.createdAt)}</span></span>
      ${t.result ? `<div class="qr">${esc(t.result)}</div>` : ''}
    </div>`;
  }

  function renderPanel() {
    const a = S.byId.get(S.selected);
    if (!a) return;
    const tier = tierOf(a), L = levelInfo(a);
    const tasks = S.tasks.filter((t) => t.agent === a.id);
    const depts = S.agents.filter((x) => tierOf(x) !== 'main' && !x.vacant);
    const panel = $('#panel');
    const keep = panel.dataset.agent === a.id ? { text: ($('#taskText') || {}).value || '', target: ($('#taskTarget') || {}).value } : null;
    panel.dataset.agent = a.id;
    panel.style.setProperty('--c', a.color);
    let form;
    if (a.vacant) {
      form = `<div class="vacant-note"><b>Это свободный участок.</b> Придумай восьмое направление и скажи Grok в чате, например: «назови восьмое направление „Здоровье“, отвечает за спорт и питание». Агент займёт участок, как только пришлёт статус с именем (<code>agent: "slot8"</code>). Можно и вручную: объект <code>slot8</code> в <code>SEED_AGENTS</code> в server.js.</div>`;
    } else {
      form = `<form class="task-form" id="taskForm">
        ${tier === 'main' ? `<label for="taskTarget">Кому поручить</label><select id="taskTarget">
            <option value="${esc(a.id)}">GROK лично</option>
            ${depts.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
            <option value="__all">Всем направлениям (${depts.filter((d) => tierOf(d) === 'dept').length})</option></select>` : ''}
        <label for="taskText">${tier === 'main' ? 'Приказ' : 'Задача для агента'}</label>
        <textarea id="taskText" maxlength="4000" placeholder="${tier === 'main' ? 'Например: собери итоги недели по всем направлениям' : 'Опиши, что нужно сделать…'}" required></textarea>
        <div class="row"><span class="hint">Ctrl+Enter — отправить</span><button class="btn gold" type="submit">${ico('send')}Дать задачу</button></div>
        <div class="msg" id="formMsg"></div>
      </form>`;
    }
    panel.innerHTML = `
      <button class="icon-btn sm p-close" id="pClose" aria-label="Закрыть">${ico('x')}</button>
      <div class="p-hero">
        <div class="p-portrait">${portrait(a, '-34 -104 68 76')}</div>
        <div class="p-title"><div class="kicker">${esc(tier === 'main' ? 'Кремль · главный агент' : (a.district || '') + (tier === 'extra' ? ' · союзник' : ''))}</div>
          <h2>${esc(tier === 'main' ? 'Главный агент · GROK' : a.name)}</h2><div class="role">${esc(a.role || '')}</div></div>
      </div>
      <div class="p-body">
        ${a.vacant ? '' : `<div class="p-row"><div class="lvl-badge"><div><b>${L.lvl}</b><span>УРОВЕНЬ</span></div></div>
          <div class="xp"><div class="xp-top"><span>Опыт <b>${L.into}</b> / ${L.need}</span><span>Выполнено: <b>${a.completed || 0}</b></span></div><div class="bar"><i style="width:${Math.round((L.into / L.need) * 100)}%"></i></div></div></div>
        <div class="status-line"><span class="status-pill ${a.status}">${STATUS_TEXT[a.status] || a.status}</span><span class="now">${esc(a.now || '')}</span></div>`}
        <div class="sec"><h4>${tier === 'main' ? 'Полномочия' : 'Обязанности'}</h4><ul class="duties">${(a.responsibilities || []).map((r) => `<li>${esc(r)}</li>`).join('') || '<li>Пока не заданы</li>'}</ul></div>
        <div class="sec"><h4>${tier === 'main' ? 'Отдать приказ' : 'Дать задачу'}</h4>${form}</div>
        ${tier === 'main' ? `<div class="sec"><h4>Последние задачи штаба</h4><div class="quest-list" style="padding:0">${S.tasks.slice(0, 8).map((t) => questHTML(t, true)).join('') || emptyQuests()}</div></div>`
          : `<div class="sec"><h4>Журнал заданий</h4><div class="quest-list" style="padding:0">${tasks.slice(0, 12).map((t) => questHTML(t, false)).join('') || emptyQuests()}</div></div>`}
        ${a.done && a.done.length ? `<div class="sec"><h4>Сделано недавно</h4><ul class="history">${a.done.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
      </div>`;
    $('#pClose').onclick = () => select(null);
    const f = $('#taskForm');
    if (f) {
      if (keep) { $('#taskText').value = keep.text; if (keep.target && $('#taskTarget')) $('#taskTarget').value = keep.target; }
      f.onsubmit = (e) => { e.preventDefault(); submitTask(); };
      $('#taskText').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitTask(); } };
    }
    panel.querySelectorAll('.quest').forEach((q) => (q.onclick = () => { if (q.dataset.agent !== S.selected) select(q.dataset.agent); }));
  }
  const emptyQuests = () => '<div class="empty"><b>Заданий пока нет</b>Дай первую задачу — и агент возьмётся за работу.</div>';

  // ── Отправка задач ───────────────────────────────────────────────────────
  const getPassword = () => localStorage.getItem('appPassword') || '';
  let pending = null;
  async function submitTask() {
    const a = S.byId.get(S.selected);
    const txt = ($('#taskText').value || '').trim();
    const msg = $('#formMsg');
    if (!txt) { msg.className = 'msg err'; msg.textContent = 'Напиши, что нужно сделать.'; return; }
    if (!getPassword()) { pending = submitTask; openModal(); return; }
    let targets = [a.id];
    const sel = $('#taskTarget');
    if (sel) targets = sel.value === '__all' ? S.agents.filter((x) => tierOf(x) === 'dept' && !x.vacant).map((x) => x.id) : [sel.value];
    const btn = $('#taskForm button[type=submit]');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Отправляю…';
    let ok = 0, lastErr = '';
    for (const id of targets) {
      try {
        const res = await fetch('/api/task', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-password': getPassword() }, body: JSON.stringify({ agent: id, text: txt }) });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) { localStorage.removeItem('appPassword'); pending = submitTask; openModal('Пароль не подошёл. Попробуй ещё раз.'); lastErr = 'auth'; break; }
        if (!res.ok) { lastErr = data.error || `Ошибка ${res.status}`; continue; }
        ok++;
        launchPacket(id);
        if (data.status && String(data.status).startsWith('не отправлена')) lastErr = 'Задача записана, но вебхук Grok не настроен (GROK_WEBHOOK_URL).';
      } catch (_) { lastErr = 'Нет связи с сервером'; }
    }
    btn.disabled = false;
    if (lastErr === 'auth') { msg.textContent = ''; return; }
    if (ok) {
      whoosh();
      const names = targets.length > 1 ? `${ok} направлениям` : (tierOf(S.byId.get(targets[0])) === 'main' ? 'GROK' : S.byId.get(targets[0]).name);
      toast('Задача отправлена', `${names}: «${txt.slice(0, 80)}»`, 'send');
      $('#taskText').value = '';
      msg.className = lastErr ? 'msg err' : 'msg ok';
      msg.textContent = lastErr || 'Готово! Агент взялся за работу.';
      await loadState();
    } else {
      msg.className = 'msg err'; msg.textContent = lastErr || 'Не удалось отправить';
    }
  }
  function launchPacket(id) {
    const a = S.byId.get(id), fx = $('#fx');
    if (!a) return;
    const e = S.els.get(id);
    const [kx, ky] = kremlin();
    const path = e && e.link;
    const c = document.createElementNS(NS, 'g');
    c.innerHTML = `<circle r="16" fill="${a.color}" opacity=".35" filter="url(#soft)"/><circle r="8" fill="${a.color}" stroke="#fff" stroke-width="3"/>`;
    fx.appendChild(c);
    const len = path ? path.getTotalLength() : 0, t0 = performance.now(), dur = 1100;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e2 = 1 - Math.pow(1 - t, 3);
      const p = path ? path.getPointAtLength(len * e2) : { x: kx, y: ky - 40 * e2 };
      c.setAttribute('transform', `translate(${p.x},${p.y})`);
      if (t < 1) requestAnimationFrame(step);
      else {
        c.remove();
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', a.x); ring.setAttribute('cy', a.y + 14); ring.setAttribute('r', 10);
        ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', a.color); ring.setAttribute('stroke-width', 4);
        fx.appendChild(ring);
        const r0 = performance.now();
        const grow = (n) => { const q = Math.min(1, (n - r0) / 600); ring.setAttribute('r', 10 + q * 80); ring.setAttribute('opacity', 1 - q); if (q < 1) requestAnimationFrame(grow); else ring.remove(); };
        requestAnimationFrame(grow);
        blip(1046);
      }
    };
    requestAnimationFrame(step);
  }

  // ── Модалка пароля ───────────────────────────────────────────────────────
  function openModal(err) {
    $('#modal').classList.add('show');
    $('#modal p').innerHTML = err ? `<span style="color:#fca5a5">${esc(err)}</span>` : 'Введи пароль доступа (<code>APP_PASSWORD</code> из Render). Он хранится только в этом браузере.';
    $('#pwInput').value = '';
    setTimeout(() => $('#pwInput').focus(), 60);
  }
  function closeModal() { $('#modal').classList.remove('show'); pending = null; }
  function initModal() {
    $('#pwForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#pwInput').value.trim();
      if (!v) return;
      localStorage.setItem('appPassword', v);
      $('#modal').classList.remove('show');
      blip(990);
      const p = pending; pending = null;
      if (p) p(); else toast('Пароль сохранён', 'Теперь можно давать задачи агентам.', 'check');
    };
    $('#pwCancel').onclick = closeModal;
    $('#pwForget').onclick = () => { localStorage.removeItem('appPassword'); closeModal(); toast('Пароль удалён', 'В этом браузере он больше не хранится.', 'x'); };
    $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
    $('#btnKey').onclick = () => openModal();
  }

  // ── Тосты ────────────────────────────────────────────────────────────────
  function toast(title, text, icon = 'check', err = false) {
    const t = document.createElement('div');
    t.className = `toast${err ? ' err' : ''}`;
    t.innerHTML = `<span class="ti">${ico(icon)}</span><div><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
    $('#toasts').prepend(t);
    while ($('#toasts').children.length > 3) $('#toasts').lastChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 4800);
  }
  function xpPop(a, amount) {
    const { k, tx, ty } = S.cam;
    const el = document.createElement('div');
    el.className = 'xp-pop';
    el.textContent = `+${amount} XP`;
    el.style.left = a.x * k + tx + 'px'; el.style.top = (a.y + figTop(a)) * k + ty + 'px';
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 1900);
  }

  // ── Журнал и HUD ─────────────────────────────────────────────────────────
  function renderJournal() {
    $('#jCount').textContent = S.tasks.length;
    $('#jList').innerHTML = S.tasks.slice(0, 60).map((t) => questHTML(t, true)).join('') || '<div class="empty"><b>Журнал пуст</b>Выбери агента на карте и нажми «Дать задачу».</div>';
    $('#jList').querySelectorAll('.quest').forEach((q) => (q.onclick = () => select(q.dataset.agent)));
  }
  function renderHUD() {
    const staff = S.agents.filter((a) => !a.vacant);
    const active = staff.filter((a) => a.status === 'working').length;
    const done = S.agents.reduce((s, a) => s + (a.completed || 0), 0);
    const energy = Math.min(100, Math.round(20 + (active / Math.max(1, staff.length)) * 50 + Math.min(30, done * 3)));
    $('#stTasks').textContent = S.tasks.length;
    $('#stActive').textContent = `${active}/${staff.length}`;
    $('#stEnergy').textContent = `${energy}%`;
    $('#stEnergyBar').style.width = `${energy}%`;
  }
  function initJournal() {
    const j = $('#journal');
    if (innerWidth > 900 && localStorage.getItem('journal') === 'collapsed') j.classList.add('collapsed');
    $('#jClose').onclick = () => {
      if (innerWidth <= 900) { j.classList.remove('mobile-open'); return; }
      j.classList.toggle('collapsed'); localStorage.setItem('journal', j.classList.contains('collapsed') ? 'collapsed' : 'open');
    };
    $('#btnJournal').onclick = () => {
      blip(600);
      if (innerWidth <= 900) { j.classList.toggle('mobile-open'); j.classList.remove('collapsed'); }
      else { j.classList.toggle('collapsed'); localStorage.setItem('journal', j.classList.contains('collapsed') ? 'collapsed' : 'open'); }
      $('#btnJournal').classList.toggle('on', innerWidth <= 900 ? j.classList.contains('mobile-open') : !j.classList.contains('collapsed'));
    };
    $('#btnHome').onclick = () => { blip(520); select(null); goHome(); };
  }

  // ── Загрузка состояния ───────────────────────────────────────────────────
  async function loadState() {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('state ' + res.status);
    const data = await res.json();
    const agents = (data.agents || []).filter((a) => a && a.id);
    for (const a of agents) {
      a.x = Number.isFinite(a.x) ? a.x : 800; a.y = Number.isFinite(a.y) ? a.y : 540;
      a.kind = a.kind || (a.id === CONFIG.mainId ? 'putin' : 'generic');
      a.status = ['working', 'idle', 'waiting'].includes(a.status) ? a.status : 'idle';
    }
    const prevStatus = S.taskStatus;
    S.agents = agents; S.tasks = data.tasks || [];
    S.byId = new Map(agents.map((a) => [a.id, a]));
    const sig = agentSig(agents);
    if (sig !== S.sig) { S.sig = sig; buildAgents(); }
    // Завершённые задачи → тост, опыт, звук
    const next = new Map();
    for (const t of S.tasks) {
      next.set(t.id, t.status);
      if (S.loaded && t.status === 'выполнена' && prevStatus.get(t.id) && prevStatus.get(t.id) !== 'выполнена') {
        const a = S.byId.get(t.agent);
        if (a) {
          toast(`${tierOf(a) === 'main' ? 'GROK' : a.name}: задача выполнена`, `+${CONFIG.xpPerTask} XP · ${t.result ? t.result.slice(0, 90) : t.text.slice(0, 90)}`, 'check');
          xpPop(a, CONFIG.xpPerTask); chime();
        }
      }
    }
    S.taskStatus = next;
    updateAgents(); renderJournal(); renderHUD();
    if (S.selected && !$('#panel').contains(document.activeElement)) renderPanel();
    if (!S.loaded) {
      S.loaded = true;
      goHome(false);
      const pre = params.get('agent');
      if (pre && S.byId.has(pre)) setTimeout(() => select(pre), 300);
    }
  }
  function poll() {
    loadState().catch(() => {}).finally(() => setTimeout(poll, document.hidden ? CONFIG.pollMs * 3 : CONFIG.pollMs));
  }

  // ── Старт ────────────────────────────────────────────────────────────────
  initTheme(); initSound(); buildStatic(); initInput(); initMinimap(); initModal(); initJournal();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeOverlay());
  addEventListener('resize', () => { if (!S.userMoved && !S.selected) goHome(false); else { clampCam(); applyCam(); } });
  // Кварталы строятся после первой загрузки, чтобы не застраивать участки агентов.
  loadState().then(() => {
    $('#blocks').innerHTML = M.buildBlocks(S.agents.map((a) => ({ x: a.x, y: a.y, tall: Math.min(tallOf(a), 200) + 20 })));
  }).catch(() => {
    $('#blocks').innerHTML = M.buildBlocks([]);
    toast('Нет связи с сервером', 'Проверь, что приложение запущено. Повторю попытку.', 'x', true);
  }).finally(() => setTimeout(poll, CONFIG.pollMs));
})();
