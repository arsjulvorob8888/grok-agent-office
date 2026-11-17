/* Агенты · Москва — игровая карта штаба GROK. Чистый JS, без сборки. */
(function () {
  'use strict';

  // ── Настройки клиента ────────────────────────────────────────────────────
  // Сам ростер (имена, цвета, обязанности, место на карте) приходит с сервера:
  // см. SEED_AGENTS в server.js. 7-е направление — Финансы, помощники 7.1 и 7.2.
  // Архивные агенты приходят в /api/state с archived, но на карту не рисуются.
  const CONFIG = {
    pollMs: 4000,
    mainId: 'grok',
    xpPerTask: 100, // опыт за выполненную задачу
    xpPerSent: 10, // опыт за полученную задачу
    figScale: { main: 1.15, dept: 0.92, extra: 0.8, sub: 0.68 },
  };

  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const M = window.MoscowMap;
  const Feed = window.OfficeFeed;

  const svg = $('#map'), world = $('#world'), overlay = $('#overlay');
  const S = {
    agents: [], tasks: [], messages: [], byId: new Map(), selected: null, loaded: false, sig: '',
    panelSig: '', taskStatus: new Map(), cam: { k: 1, tx: 0, ty: 0 }, userMoved: false,
    els: new Map(), // id -> {g, tag, bubble, link, packets}
    sound: localStorage.getItem('soundOn') === '1',
    hierFold: new Set(),
    seenOrders: new Set(),
    needs: [],
    seenNeeds: new Set(),
    needsReady: false,
    panelScrollTo: '',
    archivedIds: new Set(),
  };
  const drafts = new Map();
  const MAX_FILES = 5;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  let rejectedOversize = false;
  const params = new URLSearchParams(location.search);
  const NEED_ID = (() => {
    const match = location.pathname.match(/^\/needs\/([^/]+)\/?$/);
    if (!match) return '';
    try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
  })();
  if (NEED_ID) document.documentElement.classList.add('need-route');

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
  const tierOf = (a) => (a.id === CONFIG.mainId ? 'main' : (a.parentId || a.tier === 'sub') ? 'sub' : a.tier === 'extra' ? 'extra' : 'dept');
  const plainName = (a) => (a && a.id === CONFIG.mainId ? 'Главный агент' : (a && a.name) || '');
  const numLabel = (a) => {
    if (!a || !a.number) return '';
    return String(a.number).includes('.') ? String(a.number) : `${a.number}.`;
  };
  const titled = (a) => (a && a.number ? `${numLabel(a)} ${plainName(a)}` : plainName(a));
  const cmpNum = (a, b) => {
    const pa = String(a.number || '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b.number || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
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
    return list.map((a) => [a.id, a.kind, a.color, a.name, a.number, a.parentId, a.vacant, a.x, a.y, a.tier].join('|')).join(';');
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
        : tier === 'sub'
          ? `<ellipse class="plot" cx="0" cy="12" rx="48" ry="18" fill="${a.color}" fill-opacity=".2" stroke="${a.color}" stroke-opacity=".75" stroke-width="2"/>
             <ellipse class="plot-ring" cx="0" cy="12" rx="56" ry="22" stroke="#f5c451"/>`
          : `<ellipse class="plot" cx="0" cy="14" rx="${tier === 'extra' ? 70 : 82}" ry="${tier === 'extra' ? 30 : 34}" fill="${a.color}" fill-opacity=".17" stroke="${a.color}" stroke-opacity=".6" stroke-width="2.4" stroke-dasharray="${a.vacant ? '7 5' : 'none'}"/>
           <ellipse class="plot-ring" cx="0" cy="14" rx="${tier === 'extra' ? 78 : 92}" ry="${tier === 'extra' ? 35 : 40}" stroke="#f5c451"/>`;
      const bld = tier === 'main' ? M.building('putin', a.color) : M.building(a.kind || 'generic', a.color);
      const beaconY = tier === 'main' ? figTop(a) - 30 : -Math.min(tallOf(a), 150) - 12;
      g.innerHTML = `${plot}<g class="bld">${bld}</g>
        <g class="beacon" transform="translate(0,${beaconY})"><circle r="9" fill="${a.color}" opacity=".7"/></g>
        <g class="fig-wrap" transform="translate(${tier === 'main' ? 0 : 0},${figFeet(a)}) scale(${figScaleOf(a)})">${Figures.render(a.kind, a.color)}</g>`;
      gA.appendChild(g);

      let link = null, packets = null;
      const parent = tier === 'sub' ? S.byId.get(a.parentId) : null;
      if (tier !== 'main' && (tier !== 'sub' || parent)) {
        const x0 = parent ? parent.x : kx, y0 = parent ? parent.y + 10 : ky;
        const x1 = a.x, y1 = a.y + (tier === 'sub' ? 10 : 14), dx = x1 - x0, dy = y1 - y0, len = Math.max(1, Math.hypot(dx, dy));
        const bend = tier === 'sub' ? 0.08 : 0.16;
        const cx = (x0 + x1) / 2 - (dy / len) * len * bend, cy = (y0 + y1) / 2 + (dx / len) * len * bend;
        link = document.createElementNS(NS, 'path');
        link.setAttribute('id', `link-${a.id}`);
        link.setAttribute('class', tier === 'sub' ? 'link sub' : 'link');
        link.setAttribute('d', `M${x0},${y0}Q${cx.toFixed(1)},${cy.toFixed(1)} ${x1},${y1}`);
        link.setAttribute('stroke', parent ? parent.color : a.color);
        gL.appendChild(link);
        packets = document.createElementNS(NS, 'g');
        packets.setAttribute('class', 'packet');
        const dur = Math.max(1.6, len / 140).toFixed(1);
        const dots = tier === 'sub' ? [0] : [0, 1, 2];
        packets.innerHTML = dots.map((i) => `<g><circle r="${tier === 'sub' ? 5 : 7}" fill="${a.color}" opacity=".7"/><circle r="3" fill="#fff"/><animateMotion dur="${dur}s" begin="-${(i * dur / dots.length).toFixed(2)}s" repeatCount="indefinite"><mpath href="#link-${a.id}"/></animateMotion></g>`).join('');
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
      const badge = document.createElement('div');
      badge.className = 'order-badge hide';
      badge.dataset.id = a.id;
      badge.onclick = (e) => { e.stopPropagation(); select(a.id); };
      overlay.appendChild(badge);
      const awaitBadge = document.createElement('button');
      awaitBadge.type = 'button';
      awaitBadge.className = 'await-you is-off';
      awaitBadge.hidden = true;
      awaitBadge.dataset.id = a.id;
      awaitBadge.onclick = (e) => { e.stopPropagation(); e.preventDefault(); select(a.id, { scrollTo: 'awaits' }); };
      overlay.appendChild(awaitBadge);
      S.els.set(a.id, { g, tag, bubble, badge, awaitBadge, link, packets, w: 0 });
    }
    buildRoster();
    buildMiniDots();
  }

  function updateAgents() {
    for (const a of S.agents) {
      const e = S.els.get(a.id);
      if (!e) continue;
      const tier = tierOf(a), L = levelInfo(a);
      const act = activityClass(a);
      e.g.setAttribute('class', `agent tier-${tier} st-${a.status}${act}${S.selected === a.id ? ' sel' : ''}`);
      e.tag.className = `tag ${tier}${S.selected === a.id ? ' sel' : ''}`;
      e.tag.innerHTML = `<span class="lvl">${a.vacant ? '?' : L.lvl}</span><span class="nm">${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</span><span class="dot ${a.status}"></span>`;
      e.w = 0;
      const show = !a.vacant && (a.status === 'working' || a.status === 'waiting') && a.now;
      e.bubble.className = `bubble ${a.status}${show ? '' : ' hide'}`;
      e.bubbleOn = !!show;
      e.bubble.innerHTML = (a.status === 'working' ? '<span class="typing"><i></i><i></i><i></i></span>' : '') + esc(a.now || '');
      if (e.link) {
        const hot = a.status === 'working';
        e.link.setAttribute('class', `link${tier === 'sub' ? ' sub' : ''}${hot ? ' hot' : ''}${S.selected === a.id ? ' sel' : ''}`);
        e.packets.setAttribute('class', `packet${hot ? ' on' : ''}`);
      }
      paintOrderBadge(e, a);
      paintAwaitBadge(e.awaitBadge, a.id);
    }
    updateRoster();
    if (window.ActivityView) ActivityView.paint();
    doPlaceOverlay();
  }

  function latestOrder(agentId) {
    const list = S.tasks.filter((t) => (t.agentId || t.agent) === agentId);
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)));
    const newest = list[0];
    if (!newest) return null;
    if (['accepted', 'in_progress', 'done', 'failed'].includes(newest.orderStatus)) return newest;
    return list.find((t) => t.orderStatus === 'in_progress' || t.orderStatus === 'accepted') || null;
  }
  function paintOrderBadge(e, a) {
    if (!e.badge) return;
    const t = latestOrder(a.id);
    if (!t) {
      e.badgeOn = false;
      e.badge.className = 'order-badge hide';
      e.badge.innerHTML = '';
      e.badge.dataset.sig = '';
      return;
    }
    const kind = t.orderStatus === 'in_progress' ? 'progress' : t.orderStatus;
    const label = t.orderStatus === 'in_progress' ? 'в работе' : t.orderStatus === 'done' ? 'выполнено' : t.orderStatus === 'failed' ? 'не вышло' : 'принял';
    const pct = Math.max(0, Math.min(100, Number.isFinite(Number(t.progress)) ? Number(t.progress) : 0));
    const bar = t.orderStatus === 'in_progress' ? `<span class="ob-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>` : '';
    const html = `<span class="ob-label">${label}</span>${bar}`;
    const sig = `${kind}:${html}`;
    if (e.badge.dataset.sig !== sig) {
      e.badge.dataset.sig = sig;
      e.badge.innerHTML = html;
    }
    e.badge.className = `order-badge ${kind === 'in_progress' ? 'progress' : kind}`;
    e.badgeOn = true;
    const aria = t.orderStatus === 'in_progress' ? `${label} ${pct}%` : label;
    e.badge.setAttribute('aria-label', aria);
    e.badge.title = aria;
  }
  function paintAwaitBadge(el, agentId) {
    if (!el) return;
    const open = Feed.openNeedsForAgent(S.needs, agentId);
    const count = open.length;
    const allStale = count > 0 && open.every((n) => n.stale);
    if (!count) {
      el.hidden = true;
      el.classList.add('is-off');
      el.setAttribute('aria-hidden', 'true');
      el.dataset.sig = '0';
      return;
    }
    el.hidden = false;
    el.classList.remove('is-off');
    el.classList.toggle('is-stale', allStale);
    el.setAttribute('aria-hidden', 'false');
    const label = `ждёт вас: ${count}`;
    el.setAttribute('aria-label', label);
    el.title = label;
    const sig = `${count}:${allStale ? 1 : 0}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = `<span class="await-you-label">ждёт вас</span><b class="await-you-count">${count}</b>`;
    }
  }

  // ── Камера ───────────────────────────────────────────────────────────────
  function viewRect() {
    const w = innerWidth, h = innerHeight, mob = w <= 700;
    const hud = $('.hud').getBoundingClientRect();
    const ros = $('#roster').getBoundingClientRect();
    let left = 0, right = w, top = hud.bottom + 8, bottom = (ros.height ? ros.top : h) - 8;
    const j = $('#journal');
    const hier = $('#hier');
    const proc = $('#processes');
    if (!mob && w > 900 && proc && proc.classList.contains('open')) left = proc.getBoundingClientRect().right + 8;
    else if (!mob && w > 900 && hier && hier.classList.contains('open')) left = hier.getBoundingClientRect().right + 8;
    else if (!mob && w > 900 && !j.classList.contains('collapsed') && getComputedStyle(j).display !== 'none') left = j.getBoundingClientRect().right + 8;
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
    if (window.ActivityView) ActivityView.place();
    if (window.Delegation) Delegation.rescale();
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
      const top = document.elementFromPoint(e.clientX, e.clientY);
      // Жест по панели, полосе или кнопке не захватываем: у карты touch-action:none,
      // и палец иначе уходит в пан вместо клика.
      if (top && !svg.contains(top)) return;
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
      if (e.key === 'Escape') {
        const lb = $('#lightbox');
        if (lb && lb.classList.contains('show')) { lb.classList.remove('show'); return; }
        if ($('#modal').classList.contains('show')) { e.preventDefault(); closeModal(); return; }
      }
      if (e.target.closest('input,textarea,select')) return;
      if (e.key === 'Escape') select(null);
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
    if (window.Delegation && Delegation.click(target)) return;
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
      showTip(e, `${titled(a)} · ${a.district || ''}`);
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
    const placed = ['.hud', '#roster', '#minimap', '#journal', '#hier.open', '#panel.open', '#needsPop.open', '#processes.open'].map((q) => document.querySelector(q)).filter((el) => el && el.offsetParent !== null).map((el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }).filter((r) => r.w > 0);
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
    for (const a of order) {
      const e = S.els.get(a.id);
      if (!e || !e.badge) continue;
      if (!e.badgeOn || k < 0.42) { e.badge.classList.add('hide'); continue; }
      let sx = a.x * k + tx;
      let sy = (a.y + figTop(a) - 10) * k + ty;
      const bw = e.badge.offsetWidth || 84;
      const bh = e.badge.offsetHeight || 22;
      const hud = document.querySelector('.hud').getBoundingClientRect();
      const panel = document.querySelector('#panel');
      const panelBox = panel && panel.classList.contains('open') ? panel.getBoundingClientRect() : null;
      let top = sy - bh;
      const minTop = hud.bottom + 4;
      if (e.bubbleOn && !e.bubble.classList.contains('hide')) {
        const br = e.bubble.getBoundingClientRect();
        top = Math.min(top, br.top - bh - 4);
      }
      if (top < minTop) top = minTop;
      if (panelBox && top + bh > panelBox.top - 4 && top < panelBox.bottom) {
        const above = panelBox.top - bh - 4;
        if (above >= minTop) top = above;
      }
      if (e.bubbleOn && !e.bubble.classList.contains('hide')) {
        const br = e.bubble.getBoundingClientRect();
        const overlaps = sx - bw / 2 < br.right && sx + bw / 2 > br.left && top < br.bottom && top + bh > br.top;
        if (overlaps) {
          const right = br.right + 8 + bw / 2;
          const left = br.left - 8 - bw / 2;
          if (right + bw / 2 < innerWidth - 6) sx = right;
          else if (left - bw / 2 > 6) sx = left;
        }
      }
      sy = top + bh;
      const r = { x: sx - bw / 2, y: top, w: bw, h: bh };
      const off = r.x < -80 || r.x > innerWidth + 80 || r.y < -40 || r.y > innerHeight + 40;
      const underHud = r.y < hud.bottom - 1 && r.y + bh > hud.top;
      const hidden = off || underHud || (hit(r) && S.selected !== a.id);
      e.badge.classList.toggle('hide', hidden);
      e.badge.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%)`;
      if (!hidden) placed.push(r);
    }
    for (const a of order) {
      const e = S.els.get(a.id);
      const el = e && e.awaitBadge;
      if (!el) continue;
      if (el.hidden || k < 0.28) { el.classList.add('hide'); continue; }
      let sx = a.x * k + tx + Math.max(18, 34 * k);
      let sy = (a.y + figTop(a) + 28) * k + ty;
      const bw = el.offsetWidth || 72;
      const bh = el.offsetHeight || 40;
      const hud = document.querySelector('.hud').getBoundingClientRect();
      let top = sy - bh;
      if (top < hud.bottom + 4) top = hud.bottom + 4;
      sy = top + bh;
      const r = { x: sx - bw / 2, y: top, w: bw, h: bh };
      const off = r.x < -80 || r.x > innerWidth + 80 || r.y < -40 || r.y > innerHeight + 40;
      const underHud = r.y < hud.bottom - 1 && r.y + bh > hud.top;
      const hidden = off || underHud || (hit(r) && S.selected !== a.id);
      el.classList.toggle('hide', hidden);
      el.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%)`;
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
    const list = [...S.agents].sort(cmpNum);
    let html = '', lastGroup = null;
    for (const a of list) {
      const t = tierOf(a);
      const group = t === 'main' ? 'main' : t === 'extra' ? 'extra' : 'staff';
      if (lastGroup && group !== lastGroup) html += '<span class="roster-sep"></span>';
      lastGroup = group;
      html += `<button class="chip ${t}${a.vacant ? ' vacant' : ''}" data-id="${esc(a.id)}" style="--c:${esc(a.color)}" title="${esc(titled(a))}">
        <span class="await-you is-off" data-id="${esc(a.id)}" hidden aria-hidden="true"></span>
        <span class="av">${portrait(a, '-27 -100 54 56')}</span><span class="st"></span><span class="lv"></span><span class="cn">${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</span></button>`;
    }
    r.innerHTML = html;
    r.querySelectorAll('.chip').forEach((c) => (c.onclick = (e) => {
      if (e.target.closest('.await-you')) return;
      select(c.dataset.id);
    }));
    r.querySelectorAll('.await-you').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        select(el.dataset.id, { scrollTo: 'awaits' });
      };
    });
  }
  // Вертикальное колесо над полосой листает её вбок, когда агенты не влезают.
  // Иначе на узкой ширине мышью до крайних чипов не добраться: скроллбар был скрыт.
  function initRoster() {
    const r = $('#roster');
    r.addEventListener('wheel', (e) => {
      if (r.scrollWidth <= r.clientWidth + 1) return;
      let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= r.clientWidth;
      if (!delta) return;
      const prev = r.scrollLeft;
      r.scrollLeft += delta;
      if (r.scrollLeft !== prev) e.preventDefault();
    }, { passive: false });
  }
  function updateRoster() {
    document.querySelectorAll('#roster .chip').forEach((c) => {
      const a = S.byId.get(c.dataset.id);
      if (!a) return;
      c.classList.toggle('sel', S.selected === a.id);
      c.classList.toggle('pulse', activityMode(a) === 'working');
      c.classList.toggle('wait', activityMode(a) === 'waiting');
      c.classList.toggle('sleep', activityMode(a) === 'resting');
      c.querySelector('.st').className = `st ${a.status}`;
      c.querySelector('.lv').textContent = a.vacant ? '—' : `${levelInfo(a).lvl}`;
      paintAwaitBadge(c.querySelector('.await-you'), a.id);
    });
  }
  function buildMiniDots() {
    $('#miniDots').innerHTML = S.agents.map((a) => `<circle class="mini-dot" cx="${a.x}" cy="${a.y}" r="${tierOf(a) === 'main' ? 30 : tierOf(a) === 'sub' ? 14 : 22}" fill="${a.color}"/>`).join('');
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

  // ── Вложения, переписка, сохранение прокрутки ───────────────────────────
  // Опрос /api/state каждые 4 с перерисовывал панель через innerHTML и сбрасывал
  // scrollTop и у .p-body, и у внутренних .qr. Пока данные те же — панель не трогаем.
  // Когда данные меняются, возвращаем якорь и scrollTop каждого вложенного блока.
  function linkify(text) {
    const s = String(text ?? '');
    const re = /(https?:\/\/[^\s<]+)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      let u = m[1], trail = '';
      while (/[),.;!?]$/.test(u)) { trail = u.slice(-1) + trail; u = u.slice(0, -1); }
      out += `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>${esc(trail)}`;
      last = m.index + m[1].length;
    }
    return out + esc(s.slice(last));
  }
  function safeUrl(u) {
    const s = String(u || '').trim();
    if (/^\/api\/files\/[a-f0-9]{32}$/.test(s)) return s;
    try {
      const url = new URL(s, location.origin);
      if (url.origin === location.origin && /^\/api\/files\/[a-f0-9]{32}$/.test(url.pathname)) return url.pathname + url.search;
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) { /* не ссылка */ }
    return '';
  }
  function isImageAtt(a) {
    const mime = String(a.mime || '').toLowerCase();
    if (/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(mime)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(`${a.name || ''} ${a.url || ''}`);
  }
  function attachmentsHTML(list) {
    const items = (list || []).map((a) => ({ ...a, href: safeUrl(a.url) })).filter((a) => a.href);
    if (!items.length) return '';
    const thumbs = items.filter(isImageAtt).map((a) =>
      `<button type="button" class="thumb" data-full="${esc(a.href)}" data-name="${esc(a.name || '')}"><img src="${esc(a.href)}" alt="${esc(a.name || '')}"></button>`).join('');
    const links = items.map((a) => {
      const external = /^https?:/i.test(a.href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : ` download="${esc(a.name || 'file')}"`;
      return `<a class="file-link" href="${esc(a.href)}"${attrs}>${ico('clip')}<span>${esc(a.name || 'файл')}</span></a>`;
    }).join('');
    return `<div class="atts">${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}<div class="file-links">${links}</div></div>`;
  }
  function draftList(agentId) {
    if (!drafts.has(agentId)) drafts.set(agentId, []);
    return drafts.get(agentId);
  }
  function renderDrafts() {
    const box = $('#attachPreview');
    if (!box || !S.selected) return;
    const list = draftList(S.selected);
    box.innerHTML = list.map((d) => `<div class="file-chip">
      ${d.isImage ? `<img src="${esc(d.url)}" alt="">` : `<span class="file-ico">${ico('clip')}</span>`}
      <span class="file-nm" title="${esc(d.file.name)}">${esc(d.file.name)}</span>
      <button type="button" class="file-rm" data-rm="${esc(d.key)}" aria-label="Убрать файл">${ico('x')}</button>
    </div>`).join('');
    box.querySelectorAll('[data-rm]').forEach((btn) => { btn.onclick = () => removeDraft(S.selected, btn.dataset.rm); });
  }
  function addDraftFiles(agentId, fileList) {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return;
    const list = draftList(agentId);
    const msg = $('#formMsg');
    let err = '';
    let sawOversize = false;
    for (const file of files) {
      if (list.length >= MAX_FILES) { err = 'Можно прикрепить не больше 5 файлов'; break; }
      if (file.size > MAX_FILE_BYTES) { err = 'Файл слишком большой (макс. 10 МБ)'; sawOversize = true; continue; }
      const isImage = /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(file.type);
      list.push({ key: Math.random().toString(36).slice(2, 10), file, url: URL.createObjectURL(file), isImage, uploadedId: null });
    }
    rejectedOversize = sawOversize;
    renderDrafts();
    if (msg && err) { msg.className = 'msg err'; msg.textContent = err; }
  }
  function removeDraft(agentId, key) {
    const list = draftList(agentId);
    const i = list.findIndex((d) => d.key === key);
    if (i < 0) return;
    URL.revokeObjectURL(list[i].url);
    list.splice(i, 1);
    renderDrafts();
  }
  function clearDrafts(agentId) {
    for (const d of draftList(agentId)) URL.revokeObjectURL(d.url);
    drafts.set(agentId, []);
    renderDrafts();
  }
  async function uploadDrafts(list) {
    const pending = list.filter((d) => !d.uploadedId);
    if (pending.length) {
      const fd = new FormData();
      for (const d of pending) fd.append('files', d.file, d.file.name || 'file');
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-app-password': getPassword() }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(messageForStatus(res.status, data && data.error));
        err.status = res.status;
        err.auth = res.status === 401 || res.status === 403;
        logClientError('загрузка файла', `HTTP ${res.status}: ${err.message}`);
        throw err;
      }
      const atts = data.attachments || [];
      if (atts.length !== pending.length) throw new Error('Сервер принял не все файлы');
      pending.forEach((d, i) => { d.uploadedId = atts[i].id; });
    }
    return list.map((d) => d.uploadedId);
  }
  function captureAnchor(scroller) {
    const box = scroller.getBoundingClientRect();
    const line = box.top + 12;
    const nodes = [...scroller.querySelectorAll('[data-anchor]')];
    let best = null;
    for (const el of nodes) {
      if (el.closest('[data-scroll-key]')) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= line && r.bottom > line) best = { id: el.dataset.anchor, delta: r.top - box.top };
    }
    if (best) return best;
    for (const el of nodes) {
      if (el.closest('[data-scroll-key]')) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top + 4) return { id: el.dataset.anchor, delta: r.top - box.top };
    }
    return null;
  }
  function capturePanelScroll(panel) {
    const body = panel.querySelector('.p-body');
    const keys = {};
    panel.querySelectorAll('[data-scroll-key]').forEach((el) => { keys[el.dataset.scrollKey] = el.scrollTop; });
    const chat = panel.querySelector('[data-scroll-key="chat"]');
    const ta = panel.querySelector('#taskText');
    return {
      anchor: body ? captureAnchor(body) : null,
      bodyTop: body ? body.scrollTop : 0,
      keys,
      chatStick: chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight < 64 : false,
      ta: ta ? ta.scrollTop : 0,
    };
  }
  function restorePanelScroll(panel, snap) {
    if (!snap) return;
    const apply = () => {
      panel.querySelectorAll('[data-scroll-key]').forEach((el) => {
        const v = snap.keys[el.dataset.scrollKey];
        if (typeof v === 'number') el.scrollTop = v;
      });
      const chat = panel.querySelector('[data-scroll-key="chat"]');
      if (chat && snap.chatStick) chat.scrollTop = chat.scrollHeight;
      const body = panel.querySelector('.p-body');
      if (body) {
        const anchor = snap.anchor && body.querySelector(`[data-anchor="${snap.anchor.id}"]`);
        if (anchor) {
          const box = body.getBoundingClientRect();
          const r = anchor.getBoundingClientRect();
          body.scrollTop += r.top - (box.top + snap.anchor.delta);
        } else body.scrollTop = snap.bodyTop;
      }
      const ta = panel.querySelector('#taskText');
      if (ta && typeof snap.ta === 'number') ta.scrollTop = snap.ta;
    };
    apply();
    requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
  }
  function initLightbox() {
    const box = document.createElement('div');
    box.id = 'lightbox';
    box.innerHTML = `<button type="button" class="icon-btn lb-close" aria-label="Закрыть">${ico('x')}</button><img alt=""><a class="btn ghost" download>Скачать</a>`;
    box.onclick = (e) => { if (e.target === box || e.target.closest('.lb-close')) box.classList.remove('show'); };
    $('#app').appendChild(box);
  }
  function openLightbox(url, name) {
    const box = $('#lightbox');
    if (!box) return;
    const img = box.querySelector('img');
    const link = box.querySelector('a');
    img.src = url;
    img.alt = name || 'Вложение';
    link.href = url;
    if (/^https?:/i.test(url)) link.removeAttribute('download'); else link.setAttribute('download', name || 'file');
    box.classList.add('show');
  }

  // ── Выбор агента и панель ────────────────────────────────────────────────
  function select(id, opts) {
    const prev = S.selected;
    const scrollTo = opts && opts.scrollTo;
    S.selected = id && S.byId.has(id) ? id : null;
    const panel = $('#panel');
    if (!S.selected) {
      panel.classList.remove('open');
      updateAgents();
      if ($('#hier').classList.contains('open')) renderHierarchy(true);
      if (prev) setTimeout(() => { if (!S.selected) goHome(); }, 50);
      return;
    }
    if (prev !== S.selected) blip(prev ? 820 : 700);
    if (innerWidth <= 900 && $('#hier').classList.contains('open')) setHierarchy(false);
    S.panelScrollTo = scrollTo || '';
    renderPanel({ preserveScroll: prev === S.selected && !scrollTo });
    S.panelSig = panelContentSig(S.selected);
    panel.classList.add('open');
    updateAgents();
    if ($('#hier').classList.contains('open')) renderHierarchy(true);
    const a = S.byId.get(S.selected);
    const k = Math.max(innerWidth <= 700 ? 0.95 : 1.15, Math.min(S.cam.k, 1.6));
    setTimeout(() => flyTo(a.x, a.y + figTop(a) / 2 + 10, k), 30);
  }

  const STATUS_TEXT = { working: 'Работает', idle: 'Свободен', waiting: 'Ждёт тебя' };
  const ACTIVITY_TEXT = { working: 'Работает', waiting: 'Ждёт', resting: 'Спит' };
  function activityMode(a) {
    if (a && a.activity === 'working') return 'working';
    if (a && a.activity === 'waiting') return 'waiting';
    return 'resting';
  }
  function activityClass(a) {
    const mode = activityMode(a);
    if (mode === 'working') return ' pulse';
    if (mode === 'waiting') return ' wait';
    return ' sleep';
  }
  function activityLabel(a) {
    return ACTIVITY_TEXT[activityMode(a)] || STATUS_TEXT[a && a.status] || '';
  }
  function activityDot(a) {
    const mode = activityMode(a);
    if (mode === 'working') return 'working';
    if (mode === 'waiting') return 'waiting';
    return 'idle';
  }
  function taskBadge(t) {
    if (t.orderStatus === 'failed') return ['fail', 'Не выполнен'];
    if (t.orderStatus === 'done' || t.status === 'выполнена') return ['done', 'Выполнена'];
    if (t.orderStatus === 'in_progress') return ['work', 'В работе'];
    if (t.orderStatus === 'accepted') return ['work', 'Принял'];
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
    clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L13 5.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 8"/>',
  };
  const ico = (n) => `<svg viewBox="0 0 24 24">${ICONS[n]}</svg>`;
  const fmtTime = (iso) => { try { const d = new Date(iso); return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + (Date.now() - d > 864e5 ? ' · ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : ''); } catch (_) { return ''; } };

  function questHTML(t, showAgent, viewerId) {
    const a = S.byId.get(t.agent) || { name: t.agent, color: '#64748b' };
    const [cls, label] = taskBadge(t);
    const title = t.text || ((t.attachments || []).map((x) => x.name).filter(Boolean).join(', ') || 'Вложение');
    const dir = viewerId ? Feed.orderDirection(t, viewerId, S.tasks) : '';
    const mark = dir === 'out' ? '→' : dir === 'in' ? '←' : dir === 'both' ? '↔' : '';
    const dirLabel = dir === 'out' ? 'отдал' : dir === 'in' ? 'получил' : dir === 'both' ? 'себе' : '';
    return `<div class="quest" data-anchor="q:${esc(t.id)}" data-agent="${esc(t.agent)}"${dir ? ` data-dir="${dir}"` : ''} style="--c:${esc(a.color)}">
      <span class="qi">${ico(cls === 'done' ? 'check' : cls === 'fail' ? 'x' : 'send')}</span>
      <span class="qt">${esc(title)}</span>
      <span class="qm">${mark ? `<span class="qdir" aria-label="${dirLabel}">${mark}</span>` : ''}<span class="badge ${cls}">${label}</span>${showAgent ? `<span>${esc(titled(a))}</span>·` : ''}<span>${fmtTime(t.createdAt)}</span></span>
      ${chainHTML(t)}
      ${historyHTML(t)}
      ${attachmentsHTML(t.attachments)}
      ${t.result ? `<div class="qr" data-scroll-key="result:${esc(t.id)}">${linkify(t.result)}</div>` : ''}
    </div>`;
  }

  function whoName(id) {
    if (!id || id === 'owner') return 'Владелец';
    const a = S.byId.get(id);
    return a ? titled(a) : id;
  }
  function orderChain(task) {
    const byId = new Map(S.tasks.map((t) => [t.id, t]));
    const path = [];
    const seen = new Set();
    let cur = task;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentOrderId ? byId.get(cur.parentOrderId) : null;
    }
    path.reverse();
    const names = [];
    for (const step of path) {
      const from = whoName(step.fromAgentId || 'grok');
      const to = whoName(step.agentId || step.agent);
      if (!names.length || names[names.length - 1] !== from) names.push(from);
      if (names[names.length - 1] !== to) names.push(to);
    }
    return names;
  }
  function currentOrderHTML(agent) {
    const t = latestOrder(agent.id);
    if (!t) return '';
    return `<div class="sec order-now" data-anchor="order"><h4>Текущий приказ</h4>${chainHTML(t)}${historyHTML(t)}</div>`;
  }
  function chainHTML(t) {
    const names = orderChain(t);
    if (names.length < 2) return '';
    return `<div class="order-chain">${names.map((n) => esc(n)).join(' <span class="arr">→</span> ')}</div>`;
  }
  const ORDER_WORD = { sent: 'отправлен', accepted: 'принял', in_progress: 'в работе', done: 'выполнено', failed: 'не выполнен' };
  function historyHTML(t) {
    const list = Array.isArray(t.history) ? t.history : [];
    if (!list.length) return '';
    return `<ol class="order-hist">${list.map((h) => {
      const bits = [];
      if (h.status === 'in_progress' && h.progress != null) bits.push(`${h.progress}%`);
      if (h.note) bits.push(h.note);
      if (h.status === 'done' && h.result) bits.push(h.result.length > 140 ? `${h.result.slice(0, 140)}…` : h.result);
      return `<li><time datetime="${esc(h.at || '')}">${fmtTime(h.at)}</time><b>${esc(ORDER_WORD[h.status] || h.status || '')}</b>${bits.length ? `<span>${esc(bits.join(' · '))}</span>` : ''}</li>`;
    }).join('')}</ol>`;
  }

  function chatHTML(agent) {
    const msgs = Feed.messagesForAgent(S.messages, S.tasks, agent.id).slice().sort((a, b) =>
      String(a.timestamp || a.createdAt).localeCompare(String(b.timestamp || b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    if (!msgs.length) return '<div class="empty"><b>Сообщений пока нет</b>Дай задачу — она появится здесь и в чате агента.</div>';
    return msgs.map((m) => {
      if (m.role === 'system') {
        return `<div class="msg-row system"><div class="msg-sys">${linkify(m.text)}</div></div>`;
      }
      const speaker = S.byId.get(m.agentId) || agent;
      const who = m.role === 'owner' ? 'Вы' : titled(speaker);
      return `<div class="msg-row ${m.role === 'owner' ? 'owner' : 'agent'}">
        <div class="msg-bubble">
          <div class="msg-meta"><b>${esc(who)}</b><span>${fmtTime(m.timestamp || m.createdAt)}</span></div>
          ${m.text ? `<div class="msg-text">${linkify(m.text)}</div>` : ''}
          ${attachmentsHTML(m.attachments)}
        </div>
      </div>`;
    }).join('');
  }

  function panelContentSig(id) {
    const a = S.byId.get(id);
    if (!a) return '';
    const L = levelInfo(a);
    const tasks = Feed.ordersForAgent(S.tasks, a.id).slice(0, 20);
    const taskKey = tasks.map((t) => [t.id, t.status, t.orderStatus, t.progress, t.note, t.fromAgentId, t.parentOrderId, t.text, t.result, t.forwardStatus, Feed.orderDirection(t, a.id, S.tasks), JSON.stringify(t.history || []), JSON.stringify(t.attachments || [])].join('\u0001')).join('\u0002');
    const msgKey = Feed.messagesForAgent(S.messages, S.tasks, a.id).map((m) => [m.id, m.role, m.agentId, m.text, m.timestamp || m.createdAt, JSON.stringify(m.attachments || [])].join('\u0001')).join('\u0002');
    const needKey = Feed.needsForAgent(S.needs, a.id).map((n) => [n.id, n.what, n.where, n.closedAt, n.stale, n.urgency, n.kind, n.checkedAt, n.actionUrl, n.docUrl, n.actionLabel, n.actionHint, n.answerStatus, (n.participants || []).join(',')].join('\u0001')).join('\u0002');
    const depts = S.agents.filter((x) => tierOf(x) !== 'main' && !x.vacant).sort(cmpNum).map((d) => `${d.id}:${d.number}:${d.name}`).join(',');
    return [a.id, a.name, a.role, a.status, a.activity, a.currentTask, a.now, a.completed, a.vacant, (a.done || []).join('\u0001'), (a.responsibilities || []).join('\u0001'), a.district, L.lvl, L.into, L.need, depts, taskKey, msgKey, needKey].join('\u0003');
  }

  function renderPanel(opts = {}) {
    const a = S.byId.get(S.selected);
    if (!a) return;
    const tier = tierOf(a), L = levelInfo(a);
    const tasks = Feed.ordersForAgent(S.tasks, a.id);
    const pin = S.pinnedOrder && tasks.find((t) => t.id === S.pinnedOrder);
    const depts = S.agents.filter((x) => tierOf(x) !== 'main' && !x.vacant).sort(cmpNum);
    const parent = a.parentId ? S.byId.get(a.parentId) : null;
    const panel = $('#panel');
    const snap = opts.preserveScroll ? capturePanelScroll(panel) : null;
    const textEl = $('#taskText');
    const keep = opts.preserveScroll && panel.dataset.agent === a.id ? {
      text: textEl ? textEl.value : '',
      selStart: textEl ? textEl.selectionStart : null,
      selEnd: textEl ? textEl.selectionEnd : null,
      target: ($('#taskTarget') || {}).value,
      focused: document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : '',
      msg: ($('#formMsg') || {}).textContent || '',
      msgClass: ($('#formMsg') || {}).className || 'msg',
    } : null;
    panel.dataset.agent = a.id;
    panel.style.setProperty('--c', a.color);
    let form;
    if (a.vacant) {
      form = `<div class="vacant-note"><b>Это свободный участок.</b> Придумай восьмое направление и скажи Grok в чате, например: «назови восьмое направление „Здоровье“, отвечает за спорт и питание». Агент займёт участок, как только пришлёт статус с именем (<code>agent: "slot8"</code>). Можно и вручную: объект <code>slot8</code> в <code>SEED_AGENTS</code> в server.js.</div>`;
    } else {
      form = `<form class="task-form" id="taskForm">
        ${tier === 'main' ? `<label for="taskTarget">Кому поручить</label><select id="taskTarget">
            <option value="${esc(a.id)}">1. Путину лично</option>
            ${depts.map((d) => `<option value="${esc(d.id)}">${esc(titled(d))}</option>`).join('')}
            <option value="__all">Всем направлениям (${depts.filter((d) => tierOf(d) === 'dept').length})</option></select>` : ''}
        <label for="taskText">${tier === 'main' ? 'Приказ' : 'Задача для агента'}</label>
        <textarea id="taskText" maxlength="4000" placeholder="${tier === 'main' ? 'Например: собери итоги недели по всем направлениям' : 'Опиши, что нужно сделать…'}"></textarea>
        <div class="attach-row">
          <button type="button" class="btn ghost" id="attachBtn">${ico('clip')}Прикрепить</button>
          <input type="file" id="fileInput" multiple hidden>
          <span class="hint">до 5 файлов, 10 МБ · перетащи или вставь скриншот</span>
        </div>
        <div class="attach-preview" id="attachPreview"></div>
      </form>`;
    }
    const shown = tasks.slice(0, 20);
    if (pin && !shown.some((t) => t.id === pin.id)) shown.unshift(pin);
    const focusCls = (t) => (S.pinnedOrder === t.id ? ' order-focus' : '');
    const taskBlock = `<div class="sec" data-anchor="tasks"><h4>Журнал заданий</h4><div class="quest-list" style="padding:0">${shown.map((t) => questHTML(t, (t.agentId || t.agent) !== a.id, a.id).replace('class="quest"', `class="quest${focusCls(t)}"`)).join('') || emptyQuests()}</div></div>`;
    panel.innerHTML = `
      <button class="icon-btn sm p-close" id="pClose" aria-label="Закрыть">${ico('x')}</button>
      <div class="p-hero">
        <div class="p-portrait">${portrait(a, '-34 -104 68 76')}</div>
        <div class="p-title"><div class="kicker">${esc(tier === 'main' ? 'Кремль · главный агент' : (a.district || '') + (tier === 'extra' ? ' · союзник' : ''))}</div>
          <h2>${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</h2><div class="role">${esc(a.role || '')}</div>${parent ? `<button type="button" class="parent-link" data-parent="${esc(parent.id)}">Помощник · ${esc(titled(parent))}</button>` : ''}</div>
      </div>
      <div class="p-body">
        ${panelNeedsHTML(a)}
        ${a.vacant ? '' : `<div class="p-row" data-anchor="level"><div class="lvl-badge"><div><b>${L.lvl}</b><span>УРОВЕНЬ</span></div></div>
          <div class="xp"><div class="xp-top"><span>Опыт <b>${L.into}</b> / ${L.need}</span><span>Выполнено: <b>${a.completed || 0}</b></span></div><div class="bar"><i style="width:${Math.round((L.into / L.need) * 100)}%"></i></div></div></div>
        <div class="status-line" data-anchor="status"><span class="status-pill ${activityDot(a)}">${esc(activityLabel(a))}</span><span class="now">${esc(a.now || '')}</span></div>
        ${currentOrderHTML(a)}`}
        <div class="sec" data-anchor="duties"><h4>${tier === 'main' ? 'Полномочия' : 'Обязанности'}</h4><ul class="duties">${(a.responsibilities || []).map((r) => `<li>${esc(r)}</li>`).join('') || '<li>Пока не заданы</li>'}</ul></div>
        <div class="sec" data-anchor="form"><h4>${tier === 'main' ? 'Отдать приказ' : 'Дать задачу'}</h4>${form}</div>
        ${a.vacant ? '' : `<div class="sec" data-anchor="chat"><h4>Переписка</h4><div class="chat-log" data-scroll-key="chat">${chatHTML(a)}</div></div>`}
        ${a.vacant ? '' : taskBlock}
        ${a.done && a.done.length ? `<div class="sec" data-anchor="done"><h4>Сделано недавно</h4><ul class="history">${a.done.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
      </div>
      ${a.vacant ? '' : `<div class="task-dock"><span class="hint">Ctrl+Enter — отправить</span><button class="btn gold" type="submit" form="taskForm" id="taskSubmit">${ico('send')}Дать задачу</button><div class="msg" id="formMsg"></div></div>`}`;
    $('#pClose').onclick = () => select(null);
    const parentBtn = panel.querySelector('.parent-link');
    if (parentBtn) parentBtn.onclick = () => select(parentBtn.dataset.parent);
    const f = $('#taskForm');
    if (f) {
      if (keep) {
        const ta = $('#taskText');
        ta.value = keep.text;
        if (keep.selStart != null) { try { ta.setSelectionRange(keep.selStart, keep.selEnd); } catch (_) { /* поле ещё не в фокусе */ } }
        if (keep.target && $('#taskTarget')) $('#taskTarget').value = keep.target;
        const formMsg = $('#formMsg');
        if (formMsg && keep.msg) { formMsg.className = keep.msgClass || 'msg'; formMsg.textContent = keep.msg; }
        if (keep.focused) { const el = document.getElementById(keep.focused); if (el) el.focus({ preventScroll: true }); }
      }
      renderDrafts();
      f.onsubmit = (e) => { e.preventDefault(); submitTask(); };
      const ta = $('#taskText');
      ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitTask(); } };
      ta.addEventListener('paste', (e) => {
        const items = [...(e.clipboardData && e.clipboardData.items ? e.clipboardData.items : [])];
        const images = items.filter((i) => i.kind === 'file' && String(i.type || '').startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
        if (!images.length) return;
        const pastedText = e.clipboardData.getData('text/plain');
        if (!pastedText) e.preventDefault();
        addDraftFiles(a.id, images);
      });
      const input = $('#fileInput');
      $('#attachBtn').onclick = () => input.click();
      input.onchange = () => { addDraftFiles(a.id, input.files); input.value = ''; };
      f.addEventListener('dragover', (e) => { e.preventDefault(); f.classList.add('drag'); });
      f.addEventListener('dragleave', (e) => { if (!f.contains(e.relatedTarget)) f.classList.remove('drag'); });
      f.addEventListener('drop', (e) => {
        e.preventDefault();
        f.classList.remove('drag');
        if (e.dataTransfer && e.dataTransfer.files) addDraftFiles(a.id, e.dataTransfer.files);
      });
    }
    panel.querySelectorAll('.quest').forEach((q) => (q.onclick = (e) => {
      if (e.target.closest('a,button,.qr')) return;
      if (q.dataset.agent !== S.selected) select(q.dataset.agent);
    }));
    panel.querySelectorAll('.thumb').forEach((btn) => {
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openLightbox(btn.dataset.full, btn.dataset.name); };
    });
    panel.querySelectorAll('.need-close').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < blockAuthClicksUntil) return;
        closeNeed(btn.dataset.need);
      };
    });
    if (snap) restorePanelScroll(panel, snap);
    else {
      const chat = panel.querySelector('[data-scroll-key="chat"]');
      if (chat) { chat.scrollTop = chat.scrollHeight; requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); }
    }
    if (S.panelScrollTo) {
      const anchor = S.panelScrollTo;
      S.panelScrollTo = '';
      scrollPanelAnchor(anchor);
    }
  }
  function scrollPanelAnchor(anchorId) {
    const body = document.querySelector('#panel .p-body');
    const el = body && body.querySelector(`[data-anchor="${anchorId}"]`);
    if (!body || !el) return;
    const apply = () => {
      const box = body.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(body).paddingTop) || 0;
      body.scrollTop += r.top - (box.top + pad);
    };
    apply();
    requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
  }
  const emptyQuests = () => '<div class="empty"><b>Заданий пока нет</b>Дай первую задачу — и агент возьмётся за работу.</div>';

  // ── Отправка задач ───────────────────────────────────────────────────────
  const getPassword = () => localStorage.getItem('appPassword') || '';
  // Очередь действия, которое ждёт пароль: закрытие пункта, отправка задачи.
  // Отмена пропуска увеличивает authToken и глушит клик, который после скрытия
  // диалога попал бы в «Закрыть» под ним и повторил бы действие уже сохранённым паролем.
  let pending = null;
  let authToken = 1;
  let blockAuthClicksUntil = 0;
  const FILE_TOO_BIG = 'Файл слишком большой (макс. 10 МБ)';
  const BAD_PASSWORD = 'Неверный пароль';
  const SERVER_RESTART = 'Сервер перезапускается, попробуйте через минуту';
  const OFFLINE = 'Нет связи с сервером';
  function logClientError(where, detail) {
    const text = detail instanceof Error ? (detail.stack || detail.message) : String(detail ?? '');
    console.error(`[задача] ${where}: ${text}`);
  }
  function isFetchNetworkError(err) {
    if (!err || err.name !== 'TypeError') return false;
    const msg = String(err.message || '').trim();
    if (/^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/i.test(msg)) return true;
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }
  function messageForStatus(status, serverError) {
    const code = Number(status);
    if (code === 413) return FILE_TOO_BIG;
    if (code === 401 || code === 403) return BAD_PASSWORD;
    if (code === 502 || code === 503 || code === 504) return SERVER_RESTART;
    if (code >= 400) {
      const text = typeof serverError === 'string' ? serverError.trim() : '';
      return text || `Ошибка ${code}`;
    }
    return '';
  }
  function messageForClientException(err) {
    logClientError('исключение в браузере', err);
    if (isFetchNetworkError(err)) return OFFLINE;
    const text = err && err.message ? String(err.message).trim() : '';
    return text || 'Не удалось отправить';
  }
  function noteBadPassword() {
    localStorage.removeItem('appPassword');
    queueAuth(submitTask, 'Пароль не подошёл. Попробуй ещё раз.');
  }
  async function submitTask() {
    const a = S.byId.get(S.selected);
    if (!a) return;
    const tier = tierOf(a);
    const txt = ($('#taskText').value || '').trim();
    const draft = draftList(a.id);
    const msg = $('#formMsg');
    if (!txt && !draft.length) {
      msg.className = 'msg err';
      msg.textContent = rejectedOversize ? FILE_TOO_BIG : 'Напиши, что нужно сделать, или прикрепи файл.';
      return;
    }
    if (!getPassword()) { queueAuth(submitTask); return; }
    const token = authToken;
    let targets = [a.id];
    const sel = $('#taskTarget');
    if (sel) targets = sel.value === '__all' ? S.agents.filter((x) => tierOf(x) === 'dept' && !x.vacant).map((x) => x.id) : [sel.value];
    const btn = $('#taskSubmit');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = draft.length ? 'Загружаю файлы…' : 'Отправляю…';
    let attachmentIds = [];
    if (draft.length) {
      try {
        attachmentIds = await uploadDrafts(draft);
      } catch (err) {
        btn.disabled = false;
        if (err.auth) noteBadPassword();
        msg.className = 'msg err';
        msg.textContent = err.auth ? BAD_PASSWORD : messageForClientException(err);
        return;
      }
      msg.textContent = 'Отправляю…';
    }
    let ok = 0, lastErr = '';
    for (const id of targets) {
      try {
        const fromAgentId = tier === 'main' && id !== a.id ? a.id : 'owner';
        if (token !== authToken) { btn.disabled = false; return; }
        const res = await fetch('/api/task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-app-password': getPassword() },
          body: JSON.stringify({ agent: id, text: txt, attachmentIds, fromAgentId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = messageForStatus(res.status, data && data.error);
          logClientError('отправка задачи', `HTTP ${res.status}: ${lastErr}`);
          if (res.status === 401 || res.status === 403) { noteBadPassword(); break; }
          continue;
        }
        ok++;
        try {
          if (data && data.id && !S.seenOrders.has(data.id)) {
            S.seenOrders.add(data.id);
            flyOrder(data);
          }
        } catch (err) {
          logClientError('анимация приказа', err);
        }
        if (data.status && String(data.status).startsWith('не отправлена')) lastErr = 'Задача записана, но вебхук Grok не настроен (GROK_WEBHOOK_URL).';
      } catch (err) {
        lastErr = messageForClientException(err);
      }
    }
    btn.disabled = false;
    if (ok) {
      whoosh();
      const names = targets.length > 1 ? `${ok} направлениям` : titled(S.byId.get(targets[0]));
      const preview = txt || (draft.length ? draft.map((d) => d.file.name).join(', ') : 'вложение');
      toast('Задача отправлена', `${names}: «${preview.slice(0, 80)}»`, 'send');
      $('#taskText').value = '';
      clearDrafts(a.id);
      msg.className = lastErr ? 'msg err' : 'msg ok';
      msg.textContent = lastErr || 'Готово! Агент взялся за работу.';
      await loadState();
    } else {
      msg.className = 'msg err'; msg.textContent = lastErr || 'Не удалось отправить';
    }
  }
  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function roofOf(agent) {
    if (!agent) return kremlin();
    const lift = agent.id === CONFIG.mainId ? 70 : Math.min(tallOf(agent), 150) * 0.62;
    return [agent.x, agent.y - lift];
  }
  function flyOrder(task) {
    if (!task) return;
    const to = S.byId.get(task.agentId || task.agent);
    if (!to) return;
    const fromId = task.fromAgentId && task.fromAgentId !== 'owner' ? task.fromAgentId : CONFIG.mainId;
    const from = S.byId.get(fromId) || S.byId.get(CONFIG.mainId);
    const fx = $('#fx');
    if (!fx) return;
    if (prefersReducedMotion()) {
      fx.dataset.flight = 'reduced';
      return;
    }
    fx.dataset.flight = 'play';
    let [x0, y0] = roofOf(from);
    const [x1, y1] = roofOf(to);
    if (from && to && from.id === to.id) y0 -= 80;
    const dx = x1 - x0, dy = y1 - y0, len = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(90, len * 0.18);
    const cx = (x0 + x1) / 2 - (dy / len) * bend;
    const cy = (y0 + y1) / 2 + (dx / len) * bend - 36;
    const node = document.createElementNS(NS, 'g');
    node.setAttribute('class', 'order-flight');
    node.innerHTML = `<g><rect x="-16" y="-11" width="32" height="20" rx="3" fill="#fff8ea" stroke="#c8102e" stroke-width="1.6"/><path d="M-16,-11 L0,1 L16,-11" fill="none" stroke="#c8102e" stroke-width="1.4"/><path d="M-16,9 L0,-1 L16,9" fill="none" stroke="#e7c98a" stroke-width="1"/></g>`;
    fx.appendChild(node);
    const dur = 1200, t0 = performance.now();
    const bez = (t, a, b, c) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      node.setAttribute('transform', `translate(${bez(e, x0, cx, x1)},${bez(e, y0, cy, y1)})`);
      if (t < 1) requestAnimationFrame(step);
      else { node.remove(); blip(1046); }
    };
    requestAnimationFrame(step);
  }

  // ── Модалка пароля ───────────────────────────────────────────────────────
  function queueAuth(run, err) {
    const token = authToken;
    pending = () => {
      if (token !== authToken) return;
      return run();
    };
    openModal(err);
  }
  function dropPendingAuth() {
    authToken += 1;
    pending = null;
    blockAuthClicksUntil = Date.now() + 900;
  }
  function openModal(err) {
    const modal = $('#modal');
    modal.classList.add('show');
    modal.dataset.openedAt = String(Date.now());
    $('#modal p').innerHTML = err ? `<span style="color:#fca5a5">${esc(err)}</span>` : 'Введи пароль доступа (<code>APP_PASSWORD</code> из Render). Он хранится только в этом браузере.';
    $('#pwInput').value = '';
    setTimeout(() => $('#pwInput').focus(), 60);
  }
  function closeModal() {
    dropPendingAuth();
    const modal = $('#modal');
    if (modal) modal.classList.remove('show');
    const input = $('#pwInput');
    if (input) input.value = '';
  }
  function initModal() {
    document.addEventListener('click', (e) => {
      if (Date.now() >= blockAuthClicksUntil) return;
      const t = e.target && e.target.closest ? e.target.closest('.need-close, #taskSubmit') : null;
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    $('#pwForm').onsubmit = (e) => {
      e.preventDefault();
      const token = authToken;
      const v = $('#pwInput').value.trim();
      if (!v) return;
      if (token !== authToken) return;
      const p = pending;
      pending = null;
      localStorage.setItem('appPassword', v);
      $('#modal').classList.remove('show');
      blip(990);
      if (token !== authToken) return;
      if (p) p(); else toast('Пароль сохранён', 'Теперь можно давать задачи агентам.', 'check');
    };
    const cancel = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      closeModal();
    };
    $('#pwCancel').addEventListener('pointerdown', cancel);
    $('#pwCancel').onclick = cancel;
    $('#pwForget').onclick = () => { localStorage.removeItem('appPassword'); closeModal(); toast('Пароль удалён', 'В этом браузере он больше не хранится.', 'x'); };
    // Тот же тап, который открыл пропуск, в мобильной эмуляции приходит кликом уже по фону
    // и сразу закрывал окно. Короткое окно после открытия этот клик не считает отменой.
    $('#modal').onclick = (e) => {
      if (e.target.id !== 'modal') return;
      if (Date.now() - Number($('#modal').dataset.openedAt || 0) < 500) return;
      closeModal();
    };
    $('#btnKey').onclick = () => { dropPendingAuth(); blockAuthClicksUntil = 0; openModal(); };
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
    const list = $('#jList');
    const top = list.scrollTop;
    const saved = {};
    list.querySelectorAll('[data-scroll-key]').forEach((el) => { saved[el.dataset.scrollKey] = el.scrollTop; });
    const sig = S.tasks.map((t) => [t.id, t.status, t.orderStatus, t.progress, t.note, t.fromAgentId, t.parentOrderId, (t.history || []).length, t.result, (t.attachments || []).length].join(':')).join('|');
    $('#jCount').textContent = S.tasks.length;
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = Feed.ordersForGeneral(S.tasks).slice(0, 60).map((t) => questHTML(t, true)).join('') || '<div class="empty"><b>Журнал пуст</b>Выбери агента на карте и нажми «Дать задачу».</div>';
    list.scrollTop = top;
    list.querySelectorAll('[data-scroll-key]').forEach((el) => {
      if (typeof saved[el.dataset.scrollKey] === 'number') el.scrollTop = saved[el.dataset.scrollKey];
    });
    list.querySelectorAll('.quest').forEach((q) => (q.onclick = (e) => {
      if (e.target.closest('a,button,.qr')) return;
      select(q.dataset.agent);
    }));
    list.querySelectorAll('.thumb').forEach((btn) => {
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openLightbox(btn.dataset.full, btn.dataset.name); };
    });
  }
  function taskWord(n) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return 'задача';
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'задачи';
    return 'задач';
  }
  function openTaskCount(id) {
    return S.tasks.filter((t) => t.agent === id && t.status !== 'выполнена').length;
  }
  function treeChildren(a) {
    const explicit = S.agents.filter((x) => x.parentId === a.id);
    if (a.id !== CONFIG.mainId) return explicit.sort(cmpNum);
    const seen = new Set(explicit.map((x) => x.id));
    const implicit = S.agents.filter((x) => x.id !== a.id && !x.parentId && !seen.has(x.id));
    return [...explicit, ...implicit].sort(cmpNum);
  }
  function orgNode(a) {
    const kids = treeChildren(a);
    const shut = S.hierFold.has(a.id);
    const n = openTaskCount(a.id);
    const st = activityLabel(a);
    return `<div class="org-item">
      <div class="org-row">
        <button type="button" class="org-twist${kids.length ? '' : ' leaf'}${shut ? ' shut' : ''}" data-fold="${esc(a.id)}" aria-label="${shut ? 'Развернуть' : 'Свернуть'}">${kids.length ? '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>' : ''}</button>
        <button type="button" class="org-card${S.selected === a.id ? ' sel' : ''}" data-id="${esc(a.id)}">
          <span class="top"><span class="dot ${esc(activityDot(a))}"></span><span class="nm">${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</span>${n ? `<span class="pill">${n}</span>` : ''}</span>
          <span class="meta">${esc(st)}${n ? ` · ${n} ${taskWord(n)}` : ''}</span>
        </button>
      </div>
      ${kids.length && !shut ? `<div class="org-kids">${kids.map(orgNode).join('')}</div>` : ''}
    </div>`;
  }
  function hierSig() {
    const fold = [...S.hierFold].sort().join(',');
    return S.agents.map((a) => [a.id, a.number, a.parentId, a.status, a.activity, a.name, openTaskCount(a.id)].join(':')).join('|') + '#' + fold + '#' + (S.selected || '');
  }
  function renderHierarchy(force) {
    const tree = $('#hTree');
    if (!tree || !$('#hier').classList.contains('open')) return;
    const sig = hierSig();
    if (!force && tree.dataset.sig === sig) return;
    const top = tree.scrollTop;
    tree.dataset.sig = sig;
    const root = S.byId.get(CONFIG.mainId) || S.agents.find((a) => !a.parentId);
    tree.innerHTML = root ? orgNode(root) : '<div class="empty"><b>Агентов нет</b></div>';
    tree.scrollTop = top;
    const count = S.agents.filter((a) => !a.vacant).length;
    const pill = $('#hCount');
    if (pill) pill.textContent = String(count);
    tree.querySelectorAll('.org-twist:not(.leaf)').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (S.hierFold.has(btn.dataset.fold)) S.hierFold.delete(btn.dataset.fold);
        else S.hierFold.add(btn.dataset.fold);
        renderHierarchy(true);
      };
    });
    tree.querySelectorAll('.org-card').forEach((btn) => {
      btn.onclick = () => {
        select(btn.dataset.id);
        if (innerWidth <= 900) setHierarchy(false);
      };
    });
  }
  function setHierarchy(open) {
    if (open && window.Processes) Processes.setOpen(false);
    const h = $('#hier');
    if (open && innerWidth <= 900) $('#panel').classList.remove('open');
    h.classList.toggle('open', open);
    document.body.classList.toggle('hier-on', open);
    const b = $('#btnHier');
    b.classList.toggle('on', open);
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open) {
      $('#journal').classList.remove('mobile-open');
      renderHierarchy(true);
    }
    placeOverlay();
  }
  function renderHUD() {
    const staff = S.agents.filter((a) => !a.vacant);
    const active = staff.filter((a) => activityMode(a) === 'working').length;
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
      if (window.Processes) Processes.setOpen(false);
      blip(600);
      const fromHier = $('#hier').classList.contains('open');
      if (fromHier) setHierarchy(false);
      if (innerWidth <= 900) {
        if (fromHier) j.classList.add('mobile-open');
        else j.classList.toggle('mobile-open');
        j.classList.remove('collapsed');
      } else if (fromHier) {
        j.classList.remove('collapsed');
        localStorage.setItem('journal', 'open');
      } else {
        j.classList.toggle('collapsed');
        localStorage.setItem('journal', j.classList.contains('collapsed') ? 'collapsed' : 'open');
      }
      $('#btnJournal').classList.toggle('on', innerWidth <= 900 ? j.classList.contains('mobile-open') : !j.classList.contains('collapsed'));
    };
    $('#btnHome').onclick = () => { blip(520); select(null); goHome(); };
    $('#btnHier').onclick = () => { blip(640); setHierarchy(!$('#hier').classList.contains('open')); };
    $('#hClose').onclick = () => setHierarchy(false);
  }

  // ── Нужно от вас ─────────────────────────────────────────────────────────
  // Всплывающее окно само открывается при загрузке и при новом id.
  // «Напомнить позже» прячет автопоказ на час. Браузерное уведомление —
  // только после явной кнопки «Включить уведомления», не при загрузке.
  function needsSnoozed() {
    const until = Number(localStorage.getItem('needsSnoozeUntil') || 0);
    return Number.isFinite(until) && until > Date.now();
  }
  function needsNotifyOn() {
    return localStorage.getItem('needsNotify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  }
  function paintNotifyButton() {
    const b = $('#needsNotify');
    if (!b) return;
    const on = needsNotifyOn();
    b.textContent = on ? 'Уведомления включены' : 'Включить уведомления';
    b.disabled = on;
  }
  function needFromLabel(id) {
    const a = S.byId.get(id);
    return a ? titled(a) : (id || 'агент');
  }
  function setNeedsOpen(open) {
    const pop = $('#needsPop');
    if (!pop) return;
    pop.classList.toggle('open', !!open);
    pop.setAttribute('aria-hidden', open ? 'false' : 'true');
    const btn = $('#btnNeeds');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    placeOverlay();
  }
  function panelNeedsHTML(agent) {
    const list = Feed.needsForAgent(S.needs, agent.id);
    if (!list.length) return '';
    return `<div class="sec awaits" data-anchor="awaits"><h4>Ждёт от вас</h4><div class="awaits-list">${list.map((n) => needCardHTML(n, true)).join('')}</div></div>`;
  }
  const NEED_LABEL = { low: 'несрочно', normal: 'обычно', high: 'срочно', stale: 'требует проверки', closed: 'закрыто' };
  function needSolveHref(n) {
    return `/needs/${encodeURIComponent(String(n && n.id || ''))}`;
  }
  function needDocHTML(n) {
    const url = String(n && n.docUrl || '').trim();
    if (!url || url.length > 500) return '';
    if (/^https:\/\/\S+$/i.test(url)) {
      return `<a class="need-doc" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Прочитать</a>`;
    }
    if (/^grokbot:\/\/\S+$/i.test(url)) {
      return `<p class="need-doc-hint">Прочитать: ${esc(url)} <span class="md-grok-hint">Откройте в Grok — браузер эту ссылку не откроет</span></p>`;
    }
    return '';
  }
  function needActionHTML(n) {
    if (!n || !n.id) return '';
    const label = String(n.actionLabel ?? '').trim() || 'Решить';
    const href = String(n.actionUrl || '').startsWith('/needs/') ? n.actionUrl : needSolveHref(n);
    return `<div class="need-action-wrap"><a class="need-action" href="${esc(href)}">${esc(label)}</a>${needDocHTML(n)}</div>`;
  }
  function needCardHTML(n, withClose) {
    const view = Feed.needUrgencyView(n);
    const test = Feed.isTestNeed(n);
    const close = withClose && !n.closedAt && !test
      ? `<div class="need-top"><button type="button" class="need-close" data-need="${esc(n.id)}">Закрыть</button></div>`
      : '';
    return `<article class="need-item urg-${view}${n.closedAt ? ' is-closed' : ''}${view === 'stale' ? ' is-stale' : ''}${test ? ' is-test' : ''}" data-id="${esc(n.id)}">
      ${close}
      <div class="need-what">${test ? '<span class="test-mark">тест</span>' : ''}${esc(n.what)}</div>
      <div class="need-meta"><span>от <b class="need-from">${esc(needFromLabel(n.fromAgentId))}</b></span><span class="need-where">где: <b>${esc(n.where || '')}</b></span><span class="need-urg">${NEED_LABEL[view] || NEED_LABEL.normal}</span>${n.answerStatus === 'answered' ? '<span class="need-answered">ответ получен</span>' : ''}</div>
      ${needActionHTML(n)}
    </article>`;
  }
  function closeNeed(id) {
    if (!id || Date.now() < blockAuthClicksUntil) return;
    return closeNeedAuthed(id);
  }
  async function closeNeedAuthed(id) {
    const token = authToken;
    if (!id || token !== authToken) return;
    const password = getPassword();
    if (!password) {
      if (token !== authToken) return;
      queueAuth(() => closeNeedAuthed(id));
      return;
    }
    if (token !== authToken) return;
    const res = await fetch(`/api/needs/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': password },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (token !== authToken) return;
    if (res.status === 401) {
      localStorage.removeItem('appPassword');
      if (token !== authToken) return;
      queueAuth(() => closeNeedAuthed(id), 'Пароль не подошёл. Попробуй ещё раз.');
      return;
    }
    if (!res.ok) { toast('Не закрылось', data.error || `Ошибка ${res.status}`, 'x', true); return; }
    blip(720);
    toast('Пункт закрыт', data.what || '', 'check');
    await loadState();
  }
  function renderNeeds() {
    const list = Feed.needsForGeneral(S.needs || []);
    const badge = $('#needsBadge');
    const pill = $('#needsCount');
    if (badge) {
      badge.textContent = String(list.length);
      badge.classList.toggle('zero', list.length === 0);
    }
    if (pill) pill.textContent = String(list.length);
    const btn = $('#btnNeeds');
    if (btn) btn.setAttribute('aria-label', `Нужно от вас: ${list.length}`);
    const box = $('#needsList');
    if (!box) return;
    const tests = Feed.testNeeds(S.needs || []);
    const sig = list.map((n) => [n.id, n.what, n.where, n.fromAgentId, n.urgency, n.kind, n.stale, n.checkedAt, n.actionUrl, n.docUrl, n.actionLabel, n.actionHint, n.answerStatus].join('\u0001')).join('\n')
      + '\n#test\n' + tests.map((n) => [n.id, n.what, n.closedAt].join('\u0001')).join('\n');
    if (box.dataset.sig === sig) return;
    const top = box.scrollTop;
    const main = list.length
      ? list.map((n) => needCardHTML(n, false)).join('')
      : '<div class="empty"><b>Пусто</b>Сейчас от вас ничего не ждут.</div>';
    const testBlock = tests.length
      ? `<details class="needs-test"><summary>Тестовые</summary>${tests.map((n) => needCardHTML(n, false)).join('')}</details>`
      : '';
    box.innerHTML = main + testBlock;
    box.dataset.sig = sig;
    box.scrollTop = top;
  }
  function notifyNeed(item) {
    if (needsSnoozed() || !needsNotifyOn()) return;
    try {
      new Notification('Нужно от вас', { body: `${item.what} · ${needFromLabel(item.fromAgentId)}`, tag: String(item.id) });
    } catch (_) { /* без уведомления */ }
  }
  function authorVisible(id) {
    return !(S.archivedIds && id && S.archivedIds.has(id));
  }
  function syncNeeds(raw) {
    const list = (Array.isArray(raw) ? raw : []).filter((n) => n && n.id && authorVisible(n.fromAgentId));
    S.needs = list;
    const open = Feed.needsForGeneral(list);
    const first = !S.needsReady;
    const fresh = open.filter((n) => !n.stale && !S.seenNeeds.has(n.id));
    renderNeeds();
    if (fresh.length && !needsSnoozed()) setNeedsOpen(true);
    if (!first) fresh.forEach(notifyNeed);
    for (const n of open) S.seenNeeds.add(n.id);
    S.needsReady = true;
  }
  function initNeeds() {
    paintNotifyButton();
    $('#btnNeeds').onclick = () => { blip(700); setNeedsOpen(!$('#needsPop').classList.contains('open')); };
    $('#needsClose').onclick = () => setNeedsOpen(false);
    $('#needsLater').onclick = () => {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      setNeedsOpen(false);
    };
    $('#needsNotify').onclick = () => {
      if (typeof Notification === 'undefined') {
        toast('Уведомления недоступны', 'Этот браузер их не показывает', 'x', true);
        return;
      }
      Promise.resolve(Notification.requestPermission()).then((perm) => {
        if (perm === 'granted') localStorage.setItem('needsNotify', '1');
        else localStorage.removeItem('needsNotify');
        paintNotifyButton();
      }).catch(() => {});
    };
  }

  function openOrder(id) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    const agentId = t.agentId || t.agent;
    S.pinnedOrder = id;
    document.body.dataset.openOrder = id;
    if (S.selected !== agentId) select(agentId);
    else {
      renderPanel({ preserveScroll: false });
      S.panelSig = panelContentSig(S.selected);
      updateAgents();
    }
    const mark = () => {
      const panel = $('#panel');
      const q = panel && panel.querySelector(`.quest.order-focus, .quest[data-anchor="q:${CSS.escape(id)}"]`);
      if (!q) return;
      q.classList.add('order-focus');
      const body = panel.querySelector('.p-body');
      if (body) body.scrollTop = Math.max(0, q.offsetTop - 12);
    };
    requestAnimationFrame(mark);
  }
  window.Office = { openOrder };

  // ── Загрузка состояния ───────────────────────────────────────────────────
  async function loadState() {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('state ' + res.status);
    const data = await res.json();
    const incoming = (data.agents || []).filter((a) => a && a.id);
    S.archivedIds = new Set(incoming.filter((a) => a.archived).map((a) => a.id));
    const agents = incoming.filter((a) => !a.archived);
    for (const a of agents) {
      a.x = Number.isFinite(a.x) ? a.x : 800; a.y = Number.isFinite(a.y) ? a.y : 540;
      a.kind = a.kind || (a.id === CONFIG.mainId ? 'putin' : 'generic');
      a.status = ['working', 'idle', 'waiting'].includes(a.status) ? a.status : 'idle';
    }
    const prevStatus = S.taskStatus;
    S.agents = agents; S.tasks = data.tasks || []; S.messages = data.messages || [];
    S.byId = new Map(agents.map((a) => [a.id, a]));
    syncNeeds(data.needs);
    const sig = agentSig(agents);
    if (sig !== S.sig) { S.sig = sig; buildAgents(); }
    noteFreshOrders();
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
    updateAgents(); renderJournal(); renderHierarchy(); renderHUD();
    if (S.selected) {
      const sig = panelContentSig(S.selected);
      if (sig !== S.panelSig) {
        S.panelSig = sig;
        renderPanel({ preserveScroll: true });
      }
    }
    document.dispatchEvent(new CustomEvent('officestate', { detail: data }));
    if (!S.loaded) {
      S.loaded = true;
      goHome(false);
      const pre = params.get('agent');
      if (pre && S.byId.has(pre)) setTimeout(() => select(pre), 300);
    }
  }
  function noteFreshOrders() {
    for (const t of S.tasks) {
      if (S.seenOrders.has(t.id)) continue;
      S.seenOrders.add(t.id);
      if (S.loaded) flyOrder(t);
    }
  }
  function poll() {
    loadState().catch(() => {}).finally(() => setTimeout(poll, document.hidden ? CONFIG.pollMs * 3 : CONFIG.pollMs));
  }

  function initNeedPage() {
    if (!NEED_ID) return;
    const title = $('#needTitle');
    const who = $('#needWho');
    const where = $('#needWhere');
    const details = $('#needDetails');
    const external = $('#needExternal');
    const form = $('#needAnswerForm');
    const area = $('#needAnswer');
    const msg = $('#needAnswerMsg');
    const badge = $('#needAnswerBadge');
    let need = null;

    function paintWho() {
      if (!need || !who) return;
      const agent = S.byId.get(need.fromAgentId);
      who.textContent = agent ? `Ждёт: ${titled(agent)}` : `Ждёт: ${need.fromAgentId || 'агент'}`;
    }
    document.addEventListener('officestate', paintWho);

    function paintExternal() {
      if (!external) return;
      external.innerHTML = needDocHTML(need);
    }
    function showAnswerForm(data) {
      if (!form) return;
      const yesNo = !!(data && (data.yesNo || data.kind === 'approval' || data.kind === 'test' || data.answerable));
      const textBox = $('#needTextAnswer');
      const choice = $('#needYesNo');
      form.hidden = !yesNo;
      if (choice) choice.hidden = !yesNo;
      if (textBox) textBox.hidden = true;
      form.classList.toggle('is-test', !!(data && data.kind === 'test'));
    }
    function paintPublic() {
      if (title) title.textContent = need.what || 'Вопрос';
      if (where) where.textContent = need.where ? `Где: ${need.where}` : '';
      if (badge) badge.hidden = need.answerStatus !== 'answered';
      paintWho();
      paintExternal();
    }
    function paintPrivate(data) {
      need = data;
      paintPublic();
      const markdown = typeof data.details === 'string' ? data.details : '';
      if (details) details.innerHTML = markdown && window.renderSafeMarkdown ? window.renderSafeMarkdown(markdown) : '';
      showAnswerForm(data);
    }
    async function loadPrivate() {
      const token = authToken;
      const res = await fetch(`/api/needs/${encodeURIComponent(NEED_ID)}`, {
        headers: { 'x-app-password': getPassword() },
        cache: 'no-store',
      });
      if (token !== authToken) return;
      if (res.status === 401) {
        localStorage.removeItem('appPassword');
        if (token !== authToken) return;
        queueAuth(loadPrivate, 'Пароль не подошёл. Попробуй ещё раз.');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (title) title.textContent = data.error || 'Пункт не найден';
        return;
      }
      paintPrivate(data);
    }
    async function loadPublic() {
      const res = await fetch(`/api/needs/${encodeURIComponent(NEED_ID)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (title) title.textContent = data.error || 'Пункт не найден';
        return;
      }
      need = data;
      paintPublic();
      if (data.kind === 'test') {
        showAnswerForm(data);
        if (details) details.innerHTML = '';
        return;
      }
      if (details) details.innerHTML = '';
      if (form) form.hidden = true;
      if (!getPassword()) {
        queueAuth(loadPrivate);
        return;
      }
      await loadPrivate();
    }
    async function sendAnswer(body) {
      const token = authToken;
      const test = need && need.kind === 'test';
      if (!test && !getPassword()) {
        queueAuth(() => sendAnswer(body));
        return;
      }
      if (token !== authToken) return;
      if (msg) msg.textContent = 'Отправляю…';
      let res;
      let data = {};
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (!test && getPassword()) headers['x-app-password'] = getPassword();
        res = await fetch(`/api/needs/${encodeURIComponent(NEED_ID)}/answer`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        if (msg) msg.textContent = messageForClientException(err);
        return;
      }
      if (token !== authToken) return;
      if (res.status === 401) {
        localStorage.removeItem('appPassword');
        if (token !== authToken) return;
        queueAuth(() => sendAnswer(body), 'Пароль не подошёл. Попробуй ещё раз.');
        return;
      }
      if (!res.ok) {
        if (msg) msg.textContent = data.error || 'Не удалось отправить';
        return;
      }
      if (area) area.value = '';
      if (msg) msg.textContent = data.closedAt ? 'Ответ записан, пункт закрыт' : 'Ответ отправлен';
      paintPrivate(data);
    }
    if (form) {
      const yes = $('#needYes');
      const no = $('#needNo');
      if (yes) yes.onclick = () => sendAnswer({ answer: 'yes' });
      if (no) no.onclick = () => sendAnswer({ answer: 'no' });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const text = (area && area.value || '').trim();
        if (!text) {
          if (msg) msg.textContent = 'Напишите ответ';
          return;
        }
        await sendAnswer({ text });
      };
    }
    loadPublic().catch(() => {
      if (title) title.textContent = 'Не удалось открыть вопрос';
    });
  }

  // ── Старт ────────────────────────────────────────────────────────────────
  initTheme(); initSound(); buildStatic(); initLightbox(); initInput(); initMinimap(); initModal(); initJournal(); initNeeds(); initRoster(); initNeedPage();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeOverlay());
  addEventListener('resize', () => {
    if (innerWidth <= 900 && $('#hier').classList.contains('open') && $('#panel').classList.contains('open')) {
      $('#panel').classList.remove('open');
    }
    if (!S.userMoved && !S.selected) goHome(false); else { clampCam(); applyCam(); }
  });
  // Кварталы строятся после первой загрузки, чтобы не застраивать участки агентов.
  loadState().then(() => {
    $('#blocks').innerHTML = M.buildBlocks(S.agents.map((a) => ({ x: a.x, y: a.y, tall: Math.min(tallOf(a), 200) + 20 })));
  }).catch(() => {
    $('#blocks').innerHTML = M.buildBlocks([]);
    toast('Нет связи с сервером', 'Проверь, что приложение запущено. Повторю попытку.', 'x', true);
  }).finally(() => setTimeout(poll, CONFIG.pollMs));
})();
