/* Агенты · Москва — игровая карта штаба GROK. Чистый JS, без сборки. */
(function () {
  'use strict';

  // ── Настройки клиента ────────────────────────────────────────────────────
  // Ростер приходит с сервера. На карте только главные здания: заместители
  // (parentId) сидят в помещении родителя, советник — в помещении Кремля
  // (ROOM_OF, у него нет parentId, но он в links у grok). Иерархия не меняется.
  const CONFIG = {
    pollMs: 4000,
    mainId: 'grok',
    xpPerTask: 100, // опыт за выполненную задачу
    xpPerSent: 10, // опыт за полученную задачу
    figScale: 0.84,
  };

  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r = document) => r.querySelector(s);
  function focusInside(root) {
    const active = document.activeElement;
    return !!(root && active && active !== document.body && root.contains(active));
  }
  // Chrome блокирует aria-hidden, если фокус остался внутри скрываемого блока.
  function releaseFocus(root, next) {
    if (!focusInside(root)) return;
    const outside = next && next.nodeType === 1 && !root.contains(next);
    if (outside && typeof next.focus === 'function') {
      try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); }
    }
    if (focusInside(root) && document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  }
  function focusEl(el) {
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  }
  // Кнопка, ссылка или элемент с tabindex. Обычный div получает tabindex=-1,
  // чтобы на него можно было вернуть фокус, не добавляя его в Tab.
  function asFocusTarget(el, opts) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return null;
    if (el === document.body || el === document.documentElement || el.disabled) return null;
    let node = el;
    while (node && node !== document.body) {
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return null;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      node = node.parentElement;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const off = rect.bottom <= 1 || rect.right <= 1 || rect.top >= innerHeight - 1 || rect.left >= innerWidth - 1;
    if (off && !(opts && opts.allowOffscreen)) return null;
    const tab = el.getAttribute('tabindex');
    const natural = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName);
    if (tab === null && !natural) el.setAttribute('tabindex', '-1');
    if (typeof el.focus !== 'function') return null;
    return el;
  }
  function focusFallback(agentId) {
    const chip = agentId ? document.querySelector(`#roster .chip[data-id="${agentId}"]`) : null;
    return asFocusTarget(chip) || asFocusTarget($('#agentBarToggle')) || asFocusTarget($('#btnHome')) || asFocusTarget($('#btnHier'));
  }
  function restoreFocus(root, preferred, fallback, opts) {
    const loose = opts && opts.allowOffscreen;
    const target = asFocusTarget(preferred, { allowOffscreen: loose }) || asFocusTarget(fallback);
    if (root && focusInside(root)) releaseFocus(root, target);
    const active = document.activeElement;
    const lost = !active || active === document.body || active === document.documentElement || (root && root.contains(active));
    if (lost && target && document.activeElement !== target) focusEl(target);
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const M = window.MoscowMap;
  const Feed = window.OfficeFeed;
  const Sender = window.OfficeSender;

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
    deputies: [],
    peekId: null,
    roomId: null,
    roomSig: '',
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
  const plainName = (a) => (a && a.id === CONFIG.mainId ? 'Путин' : (a && a.name) || '');
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
  const figScaleOf = () => CONFIG.figScale;
  const figFeet = () => 32;
  // Витрина карты. Координаты только для рисунка, серверные x/y не трогаем в API.
  // Зазор подобран так, чтобы таблички не пересекались на десктопе и на 390px.
  const MAP_POS = {
    grok: [800, 540],
    blog: [860, 150],
    dev: [480, 150],
    social: [1280, 170],
    poker: [190, 500],
    finance: [1300, 490],
    routines: [150, 760],
    army: [500, 860],
    temshik: [860, 920],
    devops: [1180, 900],
    qa: [1500, 740],
    health: [556, 620],
  };
  // Кто сидит внутри чужого здания и на карте не рисуется.
  const ROOM_OF = { advisor: 'grok' };
  const roomHostId = (a) => {
    if (!a) return null;
    if (a.parentId) return a.parentId;
    return ROOM_OF[a.id] || null;
  };
  const onMap = (a) => !!(a && !roomHostId(a));
  const mapHost = (a) => {
    const hostId = roomHostId(a);
    return (hostId && S.byId.get(hostId)) || a;
  };
  function roomGuests(hostId) {
    const visible = S.agents.filter((a) => roomHostId(a) === hostId);
    const deputies = (S.deputies || []).filter((a) => a && a.parentId === hostId && !visible.some((item) => item.id === a.id));
    return visible.concat(deputies).sort((a, b) => {
      const rank = (agent) => (agent.number ? 0 : 1);
      const byRank = rank(a) - rank(b);
      if (byRank) return byRank;
      return cmpNum(a, b) || String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru');
    });
  }
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
    const sorted = [...S.agents].filter(onMap).sort((a, b) => a.y - b.y);
    for (const a of sorted) {
      const tier = tierOf(a);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `agent tier-${tier} st-${statusTone(a)}`);
      g.setAttribute('transform', `translate(${a.x},${a.y})`);
      g.dataset.id = a.id;
      g.style.setProperty('--agent-glow', Figures.shade(a.color, 0.35));
      const feet = figFeet();
      const plot = `<ellipse class="ground" cx="0" cy="${feet + 2}" rx="34" ry="10"/>`;
      const bld = tier === 'main' ? M.building('putin', a.color) : M.building(a.kind || 'generic', a.color);
      const beaconY = -Math.min(tallOf(a), 120) - 8;
      g.innerHTML = `${plot}<g class="bld">${bld}</g>
        <g class="beacon" transform="translate(0,${beaconY})"><circle r="6" fill="${a.color}" opacity=".45"/></g>
        <g class="fig-wrap" transform="translate(0,${feet}) scale(${figScaleOf()})">${Figures.render(a.kind, a.color)}</g>`;
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
      tag.onclick = (e) => {
        e.stopPropagation();
        if (eatClick) { eatClick = false; return; }
        openRoom(a.id, tag);
      };
      tag.addEventListener('pointerdown', (e) => armHold(e, a.id));
      tag.addEventListener('pointerenter', () => setPeek(a.id));
      tag.addEventListener('pointerleave', () => { if (S.peekId === a.id) setPeek(null); });
      tag.addEventListener('contextmenu', (e) => e.preventDefault());
      overlay.appendChild(tag);
      const bubble = document.createElement('div');
      bubble.className = 'bubble hide';
      bubble.onclick = (e) => { e.stopPropagation(); select(a.id, { opener: bubble }); };
      overlay.appendChild(bubble);
      const badge = document.createElement('div');
      badge.className = 'order-badge hide';
      badge.dataset.id = a.id;
      badge.onclick = (e) => { e.stopPropagation(); select(a.id, { opener: badge }); };
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
    for (const a of S.agents) {
      if (a.id !== 'advisor' || a.archived || a.vacant) continue;
      const tag = document.createElement('div');
      tag.className = `tag ${tierOf(a)} guest`;
      tag.style.setProperty('--c', a.color);
      tag.dataset.id = a.id;
      tag.onclick = (e) => {
        e.stopPropagation();
        select(a.id, { opener: tag });
      };
      overlay.appendChild(tag);
      S.els.set(a.id, { g: null, tag, bubble: null, badge: null, awaitBadge: null, link: null, packets: null, w: 0 });
    }
    buildRoster();
    buildMiniDots();
  }

  function updateAgents() {
    for (const a of S.agents) {
      const e = S.els.get(a.id);
      if (!e) continue;
      const tier = tierOf(a);
      const act = activityClass(a);
      const tone = statusTone(a);
      if (e.g) e.g.setAttribute('class', `agent tier-${tier} st-${tone}${act}${S.selected === a.id ? ' sel' : ''}`);
      if (!e.g) {
        e.tag.className = `tag guest${S.selected === a.id ? ' sel' : ''}${actStateClass(a)}`;
        e.tag.innerHTML = `<span class="dot ${tone}"></span>`;
      } else {
        e.tag.className = `tag ${tier}${a.id === 'health' ? ' fit' : ''}${S.selected === a.id ? ' sel' : ''}${actStateClass(a)}`;
        e.tag.innerHTML = `<span class="nm">${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</span><span class="dot ${tone}"></span>`;
      }
      e.w = 0;
      const show = showsStatusBubble(a);
      const peek = S.peekId === a.id || S.selected === a.id;
      if (e.bubble) e.bubble.className = `bubble ${tone}${show && peek ? '' : ' hide'}`;
      e.bubbleOn = !!(e.bubble && show && peek);
      const thinking = a.live && a.live.status === 'working';
      if (e.bubble) e.bubble.innerHTML = (thinking ? '<span class="typing"><i></i><i></i><i></i></span>' : '') + esc(a.now || '');
      if (e.link) {
        const hot = activityMode(a) === 'working';
        e.link.setAttribute('class', `link${tier === 'sub' ? ' sub' : ''}${hot ? ' hot' : ''}${S.selected === a.id ? ' sel' : ''}`);
        e.packets.setAttribute('class', `packet${hot ? ' on' : ''}`);
      }
      paintOrderBadge(e, a);
      paintAwaitBadge(e.awaitBadge, a.id, true);
    }
    paintRoom();
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
  function needsOnBadge(agentId, team) {
    const ids = team ? [agentId, ...roomGuests(agentId).map((a) => a.id)] : [agentId];
    const seen = new Set();
    const open = [];
    for (const id of ids) {
      for (const n of Feed.openNeedsForAgent(S.needs, id)) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        open.push(n);
      }
    }
    return open;
  }
  function paintAwaitBadge(el, agentId, team) {
    if (!el) return;
    const open = needsOnBadge(agentId, !!team);
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
    const ros = ($('#agentBar') || $('#roster')).getBoundingClientRect();
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
    const core = S.agents.filter((a) => onMap(a) && tierOf(a) !== 'extra');
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
      if (pts.size === 1) {
        moved = 0;
        start = { x: e.clientX, y: e.clientY, target: e.target };
        const held = e.target.closest && e.target.closest('.agent');
        if (held) armHold(e, held.dataset.id);
        else clearHold();
      }
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
        nudgeHold(e);
        if (moved > 5) { clearHold(); svg.classList.add('dragging'); S.cam.tx += dx; S.cam.ty += dy; S.userMoved = true; clampCam(); applyCam(); hideTip(); }
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
        if (eatClick) { eatClick = false; clearHold(); return; }
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
      if (e.key === 'Escape') { if (roomOpen()) closeRoom(); else select(null); }
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
    if (ag) { openRoom(ag.dataset.id, ag); return; }
    const lm = target.closest && target.closest('.landmark');
    if (lm) {
      blip(740);
      const x = +lm.dataset.x, y = +lm.dataset.y;
      if (lm.dataset.lm === 'kremlin') { openRoom(CONFIG.mainId, lm); return; }
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
      if (a) { setPeek(a.id); showDeputyTip(a, e.clientX, e.clientY); }
    } else if (lm) { setPeek(null); showTip(e, lm.dataset.name); }
    else { setPeek(null); hideTip(); }
  }
  function agoText(iso) {
    if (window.LiveStream && LiveStream.ago) return LiveStream.ago(iso);
    return '';
  }
  function busyTip(a) {
    if (!a || activityMode(a) !== 'working') return '';
    const what = a.doing || a.currentTask || '';
    const age = agoText(a.doingSince || a.lastSeenAt);
    const bits = [];
    if (what) bits.push(`чем занят: ${what}`);
    if (age) bits.push(age);
    return bits.join(' · ');
  }
  function deputyTipText(a) {
    const kids = roomGuests(a.id);
    const base = !kids.length ? 'Заместителей нет' : `Заместители: ${kids.length}\n${kids.map((k) => plainName(k)).join('\n')}`;
    const busy = busyTip(a);
    return busy ? `${base}\n${busy}` : base;
  }
  function showDeputyTip(a, x, y) {
    tip.textContent = deputyTipText(a);
    tip.classList.add('show', 'tip-list');
    placeTip(x, y);
  }
  function placeTip(x, y) {
    tip.style.left = '0px';
    tip.style.top = '0px';
    const w = tip.offsetWidth || 140;
    const h = tip.offsetHeight || 28;
    const pad = 8;
    const left = Math.max(pad + w / 2, Math.min(innerWidth - pad - w / 2, x));
    let top = y - 14;
    if (top - h < pad) top = Math.min(innerHeight - pad, y + 18 + h);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  let holdTimer = 0;
  let eatClick = false;
  let holdAt = null;
  function clearHold() {
    clearTimeout(holdTimer);
    holdTimer = 0;
  }
  function armHold(e, id) {
    clearHold();
    if (!id || e.pointerType === 'mouse' || e.pointerType === 'pen') return;
    holdAt = { x: e.clientX, y: e.clientY, id };
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      eatClick = true;
      const a = S.byId.get(id);
      if (a) showDeputyTip(a, holdAt.x, holdAt.y);
    }, 500);
  }
  function nudgeHold(e) {
    if (!holdTimer || !holdAt) return;
    if (Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 12) clearHold();
  }
  function setPeek(id) {
    S.peekId = id || null;
    document.querySelectorAll('#overlay .act-marker').forEach((el) => {
      el.classList.toggle('peek', !!id && el.dataset.id === id);
    });
    for (const a of S.agents) {
      const e = S.els.get(a.id);
      if (!e) continue;
      const show = showsStatusBubble(a);
      const peek = S.peekId === a.id || S.selected === a.id;
      if (e.bubble) e.bubble.className = `bubble ${statusTone(a)}${show && peek ? '' : ' hide'}`;
      e.bubbleOn = !!(e.bubble && show && peek);
      if (e.g) e.g.classList.toggle('peek', S.peekId === a.id);
    }
  }
  function showTip(e, text) {
    tip.textContent = text;
    tip.classList.add('show');
    tip.classList.remove('tip-list');
    placeTip(e.clientX, e.clientY);
  }
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
      const gx = a.x + (e.tag.classList.contains('guest') ? 70 : 0);
      const gy = a.y + (e.tag.classList.contains('guest') ? 90 : 0);
      const sx = gx * k + tx, sy = (gy + (tierOf(a) === 'main' ? 84 : 50)) * k + ty;
      const r = { x: sx - e.w / 2, y: sy, w: e.w, h: e.h };
      const off = sx - e.w / 2 < 2 || sx + e.w / 2 > innerWidth - 2 || sy < 2 || sy + e.h > innerHeight - 2;
      const hidden = off || hit(r);
      e.tag.classList.toggle('hide', hidden);
      e.tag.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,0)`;
      if (!hidden) placed.push(r);
    }
    for (const a of order) {
      const e = S.els.get(a.id);
      if (!e) continue;
      const sx = a.x * k + tx, sy = (a.y + figTop(a) - 8) * k + ty;
      if (!e.bubble || !e.bubbleOn || k < 0.42) { if (e.bubble) e.bubble.classList.add('hide'); continue; }
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
    const mode = activityMode(a);
    return (S.selected === a.id ? 100 : 0) + (tierOf(a) === 'main' ? 50 : 0) + (mode === 'working' ? 20 : mode === 'waiting' ? 15 : 0) + (tierOf(a) === 'dept' ? 10 : 0) - (a.vacant ? 5 : 0);
  }

  // ── Ростер и мини-карта ─────────────────────────────────────────────────
  function portrait(a, vb) {
    if (a && a.id === 'health') {
      const file = String(vb).startsWith('-34') ? 'health-sport.png' : 'health-sport-avatar.svg';
      return `<img class="avatar-img" src="/img/${file}" alt="">`;
    }
    return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice">${Figures.render(a.kind, a.color)}</svg>`;
  }
  function buildRoster() {
    const r = $('#roster');
    const list = S.agents.filter(onMap).sort(cmpNum);
    let html = '', lastGroup = null;
    for (const a of list) {
      const t = tierOf(a);
      const group = t === 'main' ? 'main' : t === 'extra' ? 'extra' : 'staff';
      if (lastGroup && group !== lastGroup) html += '<span class="roster-sep"></span>';
      lastGroup = group;
      html += `<button class="chip ${t}${a.vacant ? ' vacant' : ''}" data-id="${esc(a.id)}" style="--c:${esc(a.color)}" title="${esc(titled(a))}">
        <span class="await-you is-off" data-id="${esc(a.id)}" hidden aria-hidden="true"></span>
        <span class="av">${portrait(a, '-27 -100 54 56')}</span><span class="st"></span><span class="lv"></span><span class="cn">${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</span>
        <span class="chip-events" hidden></span></button>`;
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
    const toggle = $('#agentBarToggle');
    const peek = $('#agentBarPeek');
    if (toggle) toggle.onclick = () => setAgentBar(!$('#agentBar').classList.contains('collapsed'), true);
    if (peek) peek.onclick = () => setAgentBar(false, true);
    setAgentBar(localStorage.getItem('agentBar') === 'collapsed', false);
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
      c.classList.toggle('coord', activityMode(a) === 'coordinating');
      c.classList.toggle('wait', activityMode(a) === 'waiting');
      c.classList.toggle('sleep', activityMode(a) === 'resting');
      c.classList.toggle('act-working', activityMode(a) === 'working');
      c.classList.toggle('act-coordinating', activityMode(a) === 'coordinating');
      c.classList.toggle('act-waiting', activityMode(a) === 'waiting');
      c.classList.toggle('act-idle', activityMode(a) === 'resting');
      c.querySelector('.st').className = `st ${statusTone(a)}`;
      c.querySelector('.lv').textContent = a.vacant ? '—' : `${levelInfo(a).lvl}`;
      paintAwaitBadge(c.querySelector('.await-you'), a.id, true);
      paintGuestEvents(c, a);
    });
    paintAgentBar();
  }
  function setAgentBar(collapsed, persist) {
    const bar = $('#agentBar');
    const roster = $('#roster');
    const toggle = $('#agentBarToggle');
    const peek = $('#agentBarPeek');
    if (!bar || !roster || !toggle) return;
    if (collapsed) releaseFocus(roster, toggle);
    bar.classList.toggle('collapsed', !!collapsed);
    document.body.classList.toggle('agent-bar-collapsed', !!collapsed);
    roster.inert = !!collapsed;
    if (peek) peek.hidden = !collapsed;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть панель агентов' : 'Свернуть панель агентов');
    if (persist) localStorage.setItem('agentBar', collapsed ? 'collapsed' : 'open');
    paintAgentBar();
    if (!S.loaded) return;
    placeOverlay();
    if (!S.userMoved && !S.selected) goHome(false);
    else applyCam();
  }
  function paintAgentBar() {
    const countEl = $('#agentBarAwait');
    const dots = $('#agentBarDots');
    if (countEl && window.OfficeFeed) {
      const n = Feed.needsForGeneral(S.needs || []).length;
      countEl.textContent = String(n);
      const wrap = countEl.closest('.agent-bar-await');
      if (wrap) wrap.classList.toggle('zero', n === 0);
    }
    if (!dots) return;
    const html = S.agents.filter(onMap).sort(cmpNum).map((a) => {
      const st = statusTone(a);
      return `<i class="agent-bar-dot ${st}"></i>`;
    }).join('');
    if (dots.dataset.sig !== html) {
      dots.dataset.sig = html;
      dots.innerHTML = html;
    }
  }
  function paintGuestEvents(chip, host) {
    const box = chip.querySelector('.chip-events');
    if (!box) return;
    const lines = roomGuests(host.id).map((guest) => {
      const text = String(guest.currentTask || '').trim();
      if (!text) return '';
      return `${plainName(host)} · ${plainName(guest)}: ${text}`;
    }).filter(Boolean);
    const sig = lines.join('\n');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = lines.map((line) => `<span class="chip-event">${esc(line)}</span>`).join('');
    }
    box.hidden = lines.length === 0;
  }
  function buildMiniDots() {
    $('#miniDots').innerHTML = S.agents.filter(onMap).map((a) => `<circle class="mini-dot" cx="${a.x}" cy="${a.y}" r="18" fill="${a.color}" opacity=".8"/>`).join('');
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
    box.onclick = (e) => {
      if (e.target !== box && !e.target.closest('.lb-close')) return;
      releaseFocus(box, S.lightboxOpener);
      box.classList.remove('show');
    };
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
    const opener = document.activeElement;
    S.lightboxOpener = opener && opener !== document.body ? opener : null;
    box.classList.add('show');
  }

  // ── Выбор агента и панель ────────────────────────────────────────────────
  function concealPanel(preferred, agentId) {
    const panel = $('#panel');
    if (!panel) return;
    try {
      restoreFocus(panel, preferred, focusFallback(agentId));
      if (focusInside(panel)) releaseFocus(panel, $('#agentBarToggle'));
    } finally {
      panel.classList.remove('open');
      panel.inert = true;
      panel.setAttribute('aria-hidden', 'true');
    }
  }
  function select(id, opts) {
    const prev = S.selected;
    const scrollTo = opts && opts.scrollTo;
    const panel = $('#panel');
    const requested = id && S.byId.has(id) ? id : null;
    if (!requested) {
      concealPanel(S.panelOpener, prev);
      S.panelOpener = null;
      S.selected = null;
      updateAgents();
      if ($('#hier').classList.contains('open')) renderHierarchy(true);
      if (prev) setTimeout(() => { if (!S.selected) goHome(); }, 50);
      return;
    }
    const from = (opts && opts.opener && opts.opener.nodeType === 1) ? opts.opener : document.activeElement;
    const room = $('#room');
    const insideRoom = !!(room && from && room.contains(from));
    if (from && from !== document.body && from !== document.documentElement && panel && !panel.contains(from) && !insideRoom) {
      S.panelOpener = from;
    } else if (insideRoom && S.roomOpener) {
      S.panelOpener = S.roomOpener;
    }
    S.selected = requested;
    panel.inert = false;
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    if (prev !== S.selected) blip(prev ? 820 : 700);
    if (innerWidth <= 900 && $('#hier').classList.contains('open')) setHierarchy(false);
    S.panelScrollTo = scrollTo || '';
    renderPanel({ preserveScroll: prev === S.selected && !scrollTo });
    S.panelSig = panelContentSig(S.selected);
    panel.classList.add('open');
    updateAgents();
    if ($('#hier').classList.contains('open')) renderHierarchy(true);
    const a = S.byId.get(S.selected);
    const host = mapHost(a);
    const k = Math.max(innerWidth <= 700 ? 0.95 : 1.15, Math.min(S.cam.k, 1.6));
    setTimeout(() => flyTo(host.x, host.y + figTop(host) / 2 + 10, k), 30);
  }

  function roomOpen() {
    const room = $('#room');
    return !!(room && room.classList.contains('open'));
  }
  function openRoom(id, from) {
    const head = S.byId.get(id);
    if (!head || roomHostId(head)) return;
    S.roomId = id;
    S.roomSig = '';
    const opener = (from && from.nodeType === 1) ? from : document.activeElement;
    S.roomOpener = opener && opener !== document.body && opener !== document.documentElement && !($('#room') && $('#room').contains(opener)) ? opener : null;
    const room = $('#room');
    room.hidden = false;
    room.classList.add('open');
    room.setAttribute('aria-hidden', 'false');
    hideTip();
    paintRoom();
    blip(640);
  }
  function closeRoom(opts) {
    const room = $('#room');
    if (!room) return;
    const explicit = opts && opts.focus;
    const preferred = explicit || S.roomOpener;
    const agentId = S.roomId;
    restoreFocus(room, preferred, focusFallback(agentId), { allowOffscreen: !!explicit });
    S.roomId = null;
    S.roomSig = '';
    S.roomOpener = null;
    room.classList.remove('open');
    room.hidden = true;
    room.setAttribute('aria-hidden', 'true');
  }
  function roomInterior() {
    return `<svg class="room-bg" viewBox="0 0 640 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="640" height="220" fill="#efe6d2"/>
      <rect y="128" width="640" height="92" fill="#e4d3b4"/>
      <path d="M0 128h640" stroke="#d7c4a2" stroke-width="3"/>
      <g fill="#f7f1e4" stroke="#cbb892">
        <rect x="36" y="28" width="92" height="70" rx="4"/>
        <rect x="512" y="28" width="92" height="70" rx="4"/>
      </g>
      <g fill="#d5e6f2">
        <rect x="46" y="38" width="72" height="48"/>
        <rect x="522" y="38" width="72" height="48"/>
      </g>
      <path d="M82 38v48M46 62h72M558 38v48M522 62h72" stroke="#f7f1e4" stroke-width="3"/>
      <rect x="250" y="18" width="140" height="8" rx="3" fill="#e7d7b0"/>
      <circle cx="320" cy="46" r="14" fill="#f6e7b0" stroke="#e0c56a"/>
      <rect x="314" y="60" width="12" height="10" fill="#c4b08a"/>
      <ellipse cx="320" cy="176" rx="150" ry="28" fill="#c45a4a" opacity=".35"/>
      <ellipse cx="320" cy="176" rx="108" ry="16" fill="#f3e2b0" opacity=".55"/>
      <rect x="70" y="150" width="16" height="36" rx="3" fill="#6d8f62"/>
      <circle cx="78" cy="142" r="16" fill="#7ea572"/>
      <rect x="554" y="150" width="16" height="36" rx="3" fill="#6d8f62"/>
      <circle cx="562" cy="142" r="16" fill="#7ea572"/>
    </svg>`;
  }
  function seatMode(a) {
    if (window.AgentStatus && typeof AgentStatus.finalStatus === 'function') return AgentStatus.finalStatus(a);
    return activityMode(a);
  }
  function seatLook(a) {
    if (window.AgentStatus && AgentStatus.presence) return AgentStatus.presence(a);
    const mode = seatMode(a);
    const inactive = mode === 'resting';
    return {
      mode,
      dot: inactive ? 'idle' : (mode === 'waiting' ? 'waiting' : 'working'),
      opacity: inactive ? 0.55 : 1,
      filter: inactive ? 'grayscale(0.4)' : 'none',
    };
  }
  function seatHTML(a, head) {
    const role = a.id === head.id ? 'Руководитель' : (a.parentId ? 'Заместитель' : 'В этом здании');
    const phrase = deliveryPhrase(a);
    const look = seatLook(a);
    const st = phrase || (window.AgentStatus ? AgentStatus.activityLabel(a) : activityLabel(a));
    const note = phrase ? '' : (a.doing || a.now || '');
    const figStyle = `opacity:${look.opacity};filter:${look.filter}`;
    return `<article class="room-seat" data-id="${esc(a.id)}" data-presence="${esc(look.mode)}">
      <div class="room-sit">
        <svg class="room-fig" style="${figStyle}" viewBox="-40 -108 80 116" aria-hidden="true">${Figures.render(a.kind, a.color)}</svg>
        <svg class="room-desk" viewBox="0 0 150 70" aria-hidden="true">
          <ellipse cx="75" cy="64" rx="58" ry="6" fill="#000" opacity=".12"/>
          <path d="M22 40h106v14H22z" fill="#c4a36a"/>
          <path d="M22 40h106v5H22z" fill="#e6d2a4"/>
          <path d="M30 28h12v16H30zM108 28h12v16h-12z" fill="#8b5e34"/>
          <path d="M36 16h78v16H36z" fill="#a56b3c"/>
        </svg>
      </div>
      <div class="room-meta">
        <div class="room-role">${esc(role)}</div>
        <div class="room-name">${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</div>
        <div class="room-status"><span class="room-dot" data-status="${esc(look.mode)}"></span><span class="status-pill ${esc(phrase ? 'queued' : look.dot)}">${esc(st)}</span><span class="now">${esc(note)}</span></div>
        <button type="button" class="btn gold room-go" data-id="${esc(a.id)}">Открыть</button>
      </div>
    </article>`;
  }
  function paintRoom() {
    const scroll = $('#roomScroll');
    if (!scroll || !S.roomId) return;
    const head = S.byId.get(S.roomId);
    if (!head) { closeRoom(); return; }
    const people = [head, ...roomGuests(head.id)];
    const sig = people.map((a) => [a.id, a.number, a.name, seatMode(a), a.activity, a.doing, a.status, a.now].join(':')).join('|');
    if (scroll.dataset.sig === sig && S.roomSig === sig) return;
    const top = scroll.scrollTop;
    S.roomSig = sig;
    scroll.dataset.sig = sig;
    scroll.innerHTML = `<div class="room-top"><div class="room-kicker">Помещение</div><h2 id="roomTitle">${esc(titled(head))}</h2><div class="room-where">${esc(head.district || '')}</div></div>
      <div class="room-stage">${roomInterior()}<div class="room-seats">${people.map((a) => seatHTML(a, head)).join('')}</div></div>`;
    scroll.scrollTop = top;
  }
  function initRoom() {
    const room = $('#room');
    if (!room) return;
    room.addEventListener('click', (e) => { if (e.target === room) closeRoom(); });
    $('#roomX').onclick = () => closeRoom();
    $('#roomScroll').addEventListener('click', (e) => {
      const btn = e.target.closest('.room-go');
      if (!btn) return;
      const id = btn.dataset.id;
      select(id);
      const panel = $('#panel');
      const next = panel && (panel.querySelector('#pClose') || panel.querySelector('button, a, input, textarea, select'));
      closeRoom({ focus: next });
    });
  }

  const STATUS_TEXT = { working: 'Работает', idle: 'Свободен', waiting: 'Ждёт тебя' };
  const ACTIVITY_TEXT = { working: 'Работает', coordinating: 'Координирует', waiting: 'Ждёт', resting: 'Спит' };
  function activityMode(a) {
    if (window.AgentStatus && AgentStatus.finalStatus) return AgentStatus.finalStatus(a);
    if (window.AgentStatus) return AgentStatus.activityMode(a);
    if (a && a.activity === 'working') return 'working';
    if (a && a.activity === 'coordinating') return 'coordinating';
    if (a && a.activity === 'waiting') return 'waiting';
    return 'resting';
  }
  function statusTone(a) {
    if (window.AgentStatus && AgentStatus.presence) return AgentStatus.presence(a).dot;
    if (window.AgentStatus) return AgentStatus.statusTone(a);
    const mode = activityMode(a);
    if (mode === 'working') return 'working';
    if (mode === 'waiting') return 'waiting';
    return 'idle';
  }
  function showsStatusBubble(a) {
    if (!a || a.vacant || !a.now) return false;
    const mode = activityMode(a);
    return mode === 'working' || mode === 'waiting';
  }
  function actStateClass(a) {
    const mode = activityMode(a);
    if (mode === 'working') return ' act-working';
    if (mode === 'coordinating') return ' act-coordinating';
    if (mode === 'waiting') return ' act-waiting';
    return ' act-idle';
  }
  function activityClass(a) {
    const mode = activityMode(a);
    const dim = actStateClass(a);
    if (mode === 'working') return ` pulse${dim}`;
    if (mode === 'coordinating') return ` coord${dim}`;
    if (mode === 'waiting') return ` wait${dim}`;
    return ` sleep${dim}`;
  }
  function activityLabel(a) {
    if (window.AgentStatus) return AgentStatus.activityLabel(a);
    return ACTIVITY_TEXT[activityMode(a)] || STATUS_TEXT[a && a.status] || '';
  }
  function deliveryPhrase(a) {
    if (!a || activityMode(a) === 'working') return '';
    const task = S.tasks.find((t) => (t.agentId || t.agent) === a.id && t.deliveryLabel);
    return task ? task.deliveryLabel : '';
  }
  function activityDot(a) {
    const mode = activityMode(a);
    if (mode === 'working') return 'working';
    if (mode === 'coordinating') return 'coord';
    if (mode === 'waiting') return 'waiting';
    return 'idle';
  }
  function statusNowHTML(a) {
    const mode = activityMode(a);
    const active = mode === 'working' || mode === 'coordinating';
    const what = String((a && (a.doing || (active ? a.currentTask : '') || a.now)) || '').trim();
    if (!active || !what) return `<span class="now">${esc(a && a.now || '')}</span>`;
    const age = agoText(a.doingSince || a.lastSeenAt);
    return `<span class="now"><span class="k">чем занят</span> ${esc(what)}</span>${age ? `<span class="ago">уже ${esc(age)}</span>` : ''}`;
  }
  function taskBadge(t) {
    const a = S.byId.get(t.agent);
    const latest = S.tasks.find((x) => x.agent === t.agent);
    return Feed.taskBadge(t, { agent: a, latest, mode: activityMode(a) });
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
  const fmtTime = (iso) => {
    try {
      if (Feed && typeof Feed.formatClockMsk === 'function') return Feed.formatClockMsk(iso);
    } catch (_) { /* запасной формат ниже */ }
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow', hourCycle: 'h23' }) + ' МСК';
    } catch (_) { return ''; }
  };

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
    const owner = Sender.senderName(id);
    if (owner) return owner;
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
    if (t.routeLabel && names.length <= 2) {
      return `<div class="order-chain">${esc(t.routeLabel).replace(/→/g, '<span class="arr">→</span>')}</div>`;
    }
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
      const word = Feed.historyCaption ? Feed.historyCaption(t, h) : (ORDER_WORD[h.status] || h.status || '');
      return `<li><time datetime="${esc(h.at || '')}">${fmtTime(h.at)}</time><b>${esc(word)}</b>${bits.length ? `<span>${esc(bits.join(' · '))}</span>` : ''}</li>`;
    }).join('')}</ol>`;
  }

  function chatHTML(agent) {
    const msgs = Feed.messagesForAgent(S.messages, S.tasks, agent.id).slice().sort((a, b) =>
      String(a.timestamp || a.createdAt).localeCompare(String(b.timestamp || b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const wait = Feed.replyWaitCaption ? Feed.replyWaitCaption(S.tasks, S.messages, agent.id) : '';
    const note = wait ? `<p class="reply-wait">${esc(wait)}</p>` : '';
    if (!msgs.length && !note) return '<div class="empty"><b>Сообщений пока нет</b>Дай задачу — она появится здесь и в чате агента.</div>';
    return note + msgs.map((m) => {
      if (m.role === 'system') {
        return `<div class="msg-row system"><div class="msg-sys">${linkify(Sender.displayOrderSender(m.text))}</div></div>`;
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
    const taskKey = tasks.map((t) => [t.id, t.status, t.orderStatus, t.deliveryLabel, t.progress, t.note, t.fromAgentId, t.parentOrderId, t.text, t.result, t.forwardStatus, Feed.orderDirection(t, a.id, S.tasks), JSON.stringify(t.history || []), JSON.stringify(t.attachments || [])].join('\u0001')).join('\u0002');
    const msgKey = Feed.messagesForAgent(S.messages, S.tasks, a.id).map((m) => [m.id, m.role, m.agentId, m.text, m.timestamp || m.createdAt, JSON.stringify(m.attachments || [])].join('\u0001')).join('\u0002');
    const needKey = Feed.needsForAgent(S.needs, a.id).map((n) => [n.id, n.what, n.where, n.closedAt, n.stale, n.urgency, n.kind, n.checkedAt, n.actionUrl, n.docUrl, n.actionLabel, n.actionHint, n.answerStatus, n.answerDeliveryLabel, (n.participants || []).join(',')].join('\u0001')).join('\u0002');
    const depts = S.agents.filter((x) => tierOf(x) !== 'main' && !x.vacant).sort(cmpNum).map((d) => `${d.id}:${d.number}:${d.name}:${d.deliveryRoute || ''}`).join(',');
    return [a.id, a.deliveryRoute || '', a.name, a.role, a.status, a.activity, a.currentTask, a.doing, a.doingSince, a.now, a.completed, a.vacant, (a.done || []).join('\u0001'), (a.responsibilities || []).join('\u0001'), a.district, L.lvl, L.into, L.need, depts, taskKey, msgKey, needKey].join('\u0003');
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
      form = `<div class="vacant-note"><b>Это свободный участок.</b> Придумай восьмое направление и скажи Путину в чате, например: «назови восьмое направление „Здоровье“, отвечает за спорт и питание». Агент займёт участок, как только пришлёт статус с именем (<code>agent: "slot8"</code>). Можно и вручную: объект <code>slot8</code> в <code>SEED_AGENTS</code> в server.js.</div>`;
    } else {
      form = `<form class="task-form" id="taskForm">
        ${tier === 'main' ? `<label for="taskTarget">Кому поручить</label><select id="taskTarget">
            <option value="${esc(a.id)}">1. Путину лично</option>
            ${depts.map((d) => `<option value="${esc(d.id)}">${esc(titled(d))}</option>`).join('')}
            <option value="__all">Всем направлениям (${depts.filter((d) => tierOf(d) === 'dept').length})</option></select>` : ''}
        <p class="task-route" id="taskRoute" data-route="none"></p>
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
        <div class="p-title"><div class="kicker">${esc(tier === 'main' ? 'Кремль · Путин' : (a.district || '') + (tier === 'extra' ? ' · союзник' : ''))}</div>
          <h2>${a.number ? `<span class="ord">${esc(numLabel(a))}</span> ` : ''}${esc(plainName(a))}</h2><div class="role">${esc(a.role || '')}</div>${parent ? `<button type="button" class="parent-link" data-parent="${esc(parent.id)}">Помощник · ${esc(titled(parent))}</button>` : ''}</div>
      </div>
      <div class="p-body">
        ${panelNeedsHTML(a)}
        ${a.vacant ? '' : `<div class="p-row" data-anchor="level"><div class="lvl-badge"><div><b>${L.lvl}</b><span>УРОВЕНЬ</span></div></div>
          <div class="xp"><div class="xp-top"><span>Опыт <b>${L.into}</b> / ${L.need}</span><span>Выполнено: <b>${a.completed || 0}</b></span></div><div class="bar"><i style="width:${Math.round((L.into / L.need) * 100)}%"></i></div></div></div>
        <div class="status-line" data-anchor="status"><span class="status-pill ${deliveryPhrase(a) ? 'queued' : activityDot(a)}">${esc(deliveryPhrase(a) || activityLabel(a))}</span>${deliveryPhrase(a) ? '<span class="now"></span>' : statusNowHTML(a)}</div>
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
      paintTaskRoute();
      const targetSel = $('#taskTarget');
      if (targetSel) targetSel.addEventListener('change', paintTaskRoute);
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
  function routeKindOf(id) {
    const agent = S.byId.get(id);
    const kind = agent && agent.deliveryRoute;
    return kind === 'agent' || kind === 'putin' || kind === 'env' || kind === 'none' ? kind : 'none';
  }
  function paintTaskRoute() {
    const el = $('#taskRoute');
    if (!el || !window.OfficeFeed || typeof OfficeFeed.routeSummary !== 'function') return;
    const sel = $('#taskTarget');
    let ids;
    if (sel && sel.value === '__all') ids = S.agents.filter((x) => tierOf(x) === 'dept' && !x.vacant).map((x) => x.id);
    else if (sel) ids = [sel.value];
    else ids = [S.selected];
    const kinds = ids.map(routeKindOf);
    el.textContent = OfficeFeed.routeSummary(kinds);
    el.dataset.route = new Set(kinds).size === 1 ? kinds[0] : 'mixed';
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
    const sentRoutes = [];
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
        sentRoutes.push(data && data.deliveryRoute ? data.deliveryRoute : 'none');
        try {
          if (data && data.id && !S.seenOrders.has(data.id)) {
            S.seenOrders.add(data.id);
            flyOrder(data);
          }
        } catch (err) {
          logClientError('анимация приказа', err);
        }
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
      await loadState();
      const formMsg = $('#formMsg');
      if (formMsg) {
        const phrase = window.OfficeFeed && typeof OfficeFeed.routeSummary === 'function'
          ? OfficeFeed.routeSummary(sentRoutes)
          : '';
        formMsg.className = lastErr ? 'msg err' : 'msg ok';
        formMsg.textContent = lastErr || (phrase ? `Приказ сохранён. ${phrase}` : 'Приказ сохранён.');
      }
    } else {
      msg.className = 'msg err'; msg.textContent = lastErr || 'Не удалось отправить';
    }
  }
  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function roofOf(agent) {
    const host = mapHost(agent);
    if (!host) return kremlin();
    const lift = host.id === CONFIG.mainId ? 70 : Math.min(tallOf(host), 150) * 0.62;
    return [host.x, host.y - lift];
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
    if (modal) {
      releaseFocus(modal, $('#btnKey'));
      modal.classList.remove('show');
    }
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
    const sig = S.tasks.map((t) => [t.id, t.status, t.orderStatus, t.deliveryLabel, t.forwardStatus, t.progress, t.note, t.fromAgentId, t.parentOrderId, (t.history || []).length, t.result, (t.attachments || []).length].join(':')).join('|');
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
    return S.tasks.filter((t) => t.agent === id && t.status !== 'выполнена' && t.orderStatus !== 'cancelled' && t.orderStatus !== 'done' && t.orderStatus !== 'failed').length;
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
    const b = $('#btnHier');
    if (open && innerWidth <= 900 && $('#panel').classList.contains('open')) concealPanel(S.panelOpener, S.selected);
    if (!open) releaseFocus(h, b);
    h.classList.toggle('open', open);
    document.body.classList.toggle('hier-on', open);
    b.classList.toggle('on', open);
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open) {
      $('#journal').classList.remove('mobile-open');
      renderHierarchy(true);
    }
    placeOverlay();
  }
  function renderUsage() {
    const fallback = {
      empty: true, level: 'empty', plan: '', pctText: '', splitText: '', resetText: '', updatedText: '', timesText: '',
      banner: '', meter: 0, label: 'Лимит',
    };
    const view = window.GrokUsage ? window.GrokUsage.present(S.grokUsage) : fallback;
    const box = $('#grokUsage');
    const banner = $('#usageBanner');
    if (!box) return;
    if (view.empty) {
      box.hidden = true;
      box.dataset.level = 'empty';
      if (banner) { banner.hidden = true; banner.textContent = ''; }
      document.body.classList.remove('usage-known', 'usage-hot');
      return;
    }
    box.hidden = false;
    box.dataset.level = view.level;
    box.setAttribute('aria-label', view.label);
    $('#usagePlan').textContent = view.plan;
    $('#usagePct').textContent = view.pctText;
    $('#usageSplit').textContent = view.splitText;
    $('#usageReset').textContent = view.resetText || '';
    $('#usageUpdated').textContent = view.updatedText || '';
    $('#usageMeter').style.width = `${view.meter}%`;
    const track = $('#usageMeterTrack');
    if (track) track.setAttribute('aria-valuenow', String(Math.round(view.meter)));
    if (!banner) return;
    banner.hidden = !view.banner;
    banner.textContent = view.banner;
    document.body.classList.toggle('usage-known', true);
    document.body.classList.toggle('usage-hot', view.level === 'critical');
  }
  function renderHUD() {
    const staff = S.agents.filter((a) => !a.vacant);
    const active = staff.filter((a) => {
      const mode = window.AgentStatus && AgentStatus.finalStatus ? AgentStatus.finalStatus(a) : activityMode(a);
      return mode === 'working';
    }).length;
    const node = $('#stActive');
    if (node) node.textContent = `${active}/${staff.length}`;
    renderUsage();
  }
  function initJournal() {
    const j = $('#journal');
    if (innerWidth > 900 && localStorage.getItem('journal') === 'collapsed') j.classList.add('collapsed');
    $('#jClose').onclick = () => {
      if (innerWidth <= 900) {
        releaseFocus(j, $('#btnJournal'));
        j.classList.remove('mobile-open');
        return;
      }
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
  function moscowStamp(iso) {
    const d = new Date(iso || '');
    if (Number.isNaN(d.getTime())) return '';
    const clock = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
    return `обновлено ${clock} МСК`;
  }
  function moscowClock(iso) {
    const d = new Date(iso || '');
    if (Number.isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const hour = (parts.find((part) => part.type === 'hour') || {}).value || '';
    const minute = (parts.find((part) => part.type === 'minute') || {}).value || '';
    if (!hour || !minute) return '';
    return `${hour}:${minute} МСК`;
  }
  function needFromLabel(id) {
    const a = S.byId.get(id);
    return a ? titled(a) : (id || 'агент');
  }
  function setNeedsOpen(open) {
    const pop = $('#needsPop');
    if (!pop) return;
    if (!open) releaseFocus(pop, $('#btnNeeds'));
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
    if (/^grokbot:\/\//i.test(url)) return '';
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
      <div class="need-meta"><span>от <b class="need-from">${esc(needFromLabel(n.fromAgentId))}</b></span><span class="need-where">где: <b>${esc(n.where || '')}</b></span><span class="need-urg">${NEED_LABEL[view] || NEED_LABEL.normal}</span><span class="need-updated">${esc(moscowStamp(n.updatedAt || n.createdAt))}</span>${n.answerDeliveryLabel ? `<span class="need-answered">${esc(n.answerDeliveryLabel)}</span>` : ''}</div>
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
    const sig = list.map((n) => [n.id, n.what, n.where, n.fromAgentId, n.urgency, n.kind, n.stale, n.updatedAt, n.checkedAt, n.actionUrl, n.docUrl, n.actionLabel, n.actionHint, n.answerStatus, n.answerDeliveryLabel].join('\u0001')).join('\n');
    if (box.dataset.sig === sig) return;
    const top = box.scrollTop;
    const main = list.length
      ? list.map((n) => needCardHTML(n, false)).join('')
      : '<div class="empty"><b>Пусто</b>Сейчас от вас ничего не ждут.</div>';
    box.innerHTML = main;
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
    const list = (Array.isArray(raw) ? raw : []).filter((n) => n && n.id && authorVisible(n.fromAgentId) && !Feed.isTestNeed(n));
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
  function showAgent(id) {
    if (!id || !S.byId.has(id)) return;
    if (S.selected === id && $('#panel').classList.contains('open')) return;
    select(id);
  }
  window.Office = { openOrder, showAgent };

  // ── Загрузка состояния ───────────────────────────────────────────────────
  async function loadState() {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('state ' + res.status);
    const data = await res.json();
    const incoming = (data.agents || []).filter((a) => a && a.id);
    S.archivedIds = new Set(incoming.filter((a) => a.archived).map((a) => a.id));
    const agents = incoming.filter((a) => !a.archived);
    S.deputies = incoming.filter((a) => a.archived && a.parentId);
    for (const a of agents) {
      a.x = Number.isFinite(a.x) ? a.x : 800; a.y = Number.isFinite(a.y) ? a.y : 540;
      if (MAP_POS[a.id]) { a.x = MAP_POS[a.id][0]; a.y = MAP_POS[a.id][1]; }
      a.kind = a.kind || (a.id === CONFIG.mainId ? 'putin' : 'generic');
      a.status = ['working', 'idle', 'waiting'].includes(a.status) ? a.status : 'idle';
    }
    const prevStatus = S.taskStatus;
    S.agents = agents; S.tasks = data.tasks || []; S.messages = data.messages || [];
    S.grokUsage = data.grokUsage || null;
    S.byId = new Map(agents.map((a) => [a.id, a]));
    for (const deputy of S.deputies) S.byId.set(deputy.id, deputy);
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
          toast(`${plainName(a)}: задача выполнена`, `+${CONFIG.xpPerTask} XP · ${t.result ? t.result.slice(0, 90) : t.text.slice(0, 90)}`, 'check');
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
  async function refreshNeeds() {
    const headers = {};
    const password = getPassword();
    if (password) headers['x-app-password'] = password;
    const res = await fetch('/api/needs', { cache: 'no-store', headers });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const open = Array.isArray(data.needs) ? data.needs : [];
    const seen = new Set(open.map((n) => n && n.id).filter(Boolean));
    const merged = new Map(S.needs.map((n) => [n.id, n]));
    for (const item of open) {
      if (item && item.id) merged.set(item.id, item);
    }
    for (const item of S.needs) {
      if (!item || !item.id || seen.has(item.id) || item.closedAt || Feed.isTestNeed(item)) continue;
      merged.set(item.id, { ...item, closedAt: new Date().toISOString() });
    }
    syncNeeds([...merged.values()]);
    if (S.selected) {
      const sig = panelContentSig(S.selected);
      if (sig !== S.panelSig) {
        S.panelSig = sig;
        renderPanel({ preserveScroll: true });
      }
    }
  }
  let pollTimer = null;
  function pollWait() {
    if (document.hidden) return null;
    if (window.LiveStream && typeof LiveStream.pollMs === 'function') return LiveStream.pollMs();
    return CONFIG.pollMs;
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    const wait = pollWait();
    if (wait == null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      poll();
    }, wait);
  }
  function poll() {
    if (document.hidden) return;
    loadState().catch(() => {}).finally(schedulePoll);
  }
  document.addEventListener('livestream', () => {
    if (!document.hidden) schedulePoll();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      pollTimer = null;
      return;
    }
    loadState().catch(() => {}).finally(schedulePoll);
  });
  setInterval(() => { refreshNeeds().catch(() => {}); }, 30000);

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

    function archivedAuthor() {
      return !!(need && need.fromAgentId && S.archivedIds && S.archivedIds.has(need.fromAgentId));
    }
    function hideArchivedNeed() {
      if (title) title.textContent = 'Пункт не найден';
      if (who) who.textContent = '';
      if (where) where.textContent = '';
      if (details) details.innerHTML = '';
      const saved = $('#needAnswers');
      if (saved) saved.innerHTML = '';
      if (external) external.innerHTML = '';
      if (form) form.hidden = true;
      if (badge) badge.hidden = true;
    }
    function paintWho() {
      if (!need || !who) return;
      if (archivedAuthor()) {
        hideArchivedNeed();
        return;
      }
      const agent = S.byId.get(need.fromAgentId);
      if (!agent) {
        who.textContent = '';
        return;
      }
      who.textContent = `Ждёт: ${titled(agent)}`;
    }
    document.addEventListener('officestate', paintWho);

    function paintExternal() {
      if (!external) return;
      external.innerHTML = needDocHTML(need);
    }
    function answerEntries(data) {
      const list = Array.isArray(data && data.answers) ? data.answers.slice() : [];
      if (!list.length && data && (data.answer === 'yes' || data.answer === 'no')) {
        list.push({ text: data.answer === 'no' ? 'Нет' : 'Да', at: data.answeredAt || null });
      }
      return list;
    }
    function paintAnswers(data) {
      const box = $('#needAnswers');
      if (!box) return;
      box.innerHTML = answerEntries(data).map((entry) => {
        const text = esc(entry && entry.text ? entry.text : '');
        const note = entry && entry.note ? `<span class="note">${esc(entry.note)}</span>` : '';
        const time = esc(moscowClock(entry && entry.at));
        return `<article class="need-answer"><p>${text}</p>${note}${time ? `<time>${time}</time>` : ''}</article>`;
      }).join('');
    }
    function needAnswerMode(data) {
      if (data && (data.answerMode === 'yesno' || data.answerMode === 'text')) return data.answerMode;
      return data && data.kind === 'approval' ? 'yesno' : 'text';
    }
    function needCanAnswer(data) {
      if (!data || data.closedAt) return false;
      if (data.kind === 'approval' || data.kind === 'test' || data.answerable === true || data.hasDetails === true) return true;
      return typeof data.details === 'string' && !!String(data.details).trim();
    }
    function showAnswerForm(data) {
      if (!form) return;
      const open = needCanAnswer(data);
      const mode = needAnswerMode(data);
      const textBox = $('#needTextAnswer');
      const choice = $('#needYesNo');
      form.hidden = !open;
      if (choice) choice.hidden = !(open && mode === 'yesno');
      if (textBox) textBox.hidden = !(open && mode === 'text');
      form.classList.toggle('is-test', !!(data && data.kind === 'test'));
    }
    function paintDetails(data) {
      const markdown = data && typeof data.details === 'string' ? data.details : '';
      if (details) details.innerHTML = markdown && window.renderSafeMarkdown ? window.renderSafeMarkdown(markdown) : '';
    }
    function rememberNeed(data) {
      if (!data || !data.id || Feed.isTestNeed(data)) return;
      const idx = S.needs.findIndex((item) => item && item.id === data.id);
      if (idx >= 0) S.needs[idx] = Object.assign({}, S.needs[idx], data);
      else S.needs.unshift(data);
      renderNeeds();
    }
    function paintPublic() {
      if (title) title.textContent = need.what || 'Вопрос';
      if (where) where.textContent = need.where ? `Где: ${need.where}` : '';
      if (badge) {
        const cap = need && need.answerDeliveryLabel ? need.answerDeliveryLabel : '';
        badge.hidden = !cap;
        if (cap) badge.textContent = cap;
      }
      paintWho();
      paintExternal();
    }
    function paintPrivate(data) {
      need = data;
      paintPublic();
      paintDetails(data);
      paintAnswers(data);
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
      paintAnswers(data);
      if (data.kind === 'test' || data.id === 'need-test-qa' || data.id === 'need-test-question') {
        paintDetails(data);
        showAnswerForm(data);
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
    let sendingAnswer = false;
    let answerLocked = false;
    function isTestPage(data) {
      return !!(data && (data.kind === 'test' || data.id === 'need-test-qa' || data.id === 'need-test-question'));
    }
    async function sendAnswer(body) {
      if (sendingAnswer || answerLocked) return;
      const token = authToken;
      const test = isTestPage(need);
      if (!test && !getPassword()) {
        queueAuth(() => sendAnswer(body));
        return;
      }
      if (token !== authToken) return;
      sendingAnswer = true;
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
        sendingAnswer = false;
        if (msg) msg.textContent = messageForClientException(err);
        return;
      }
      if (token !== authToken) return;
      if (res.status === 401) {
        sendingAnswer = false;
        localStorage.removeItem('appPassword');
        if (token !== authToken) return;
        queueAuth(() => sendAnswer(body), 'Пароль не подошёл. Попробуй ещё раз.');
        return;
      }
      if (!res.ok) {
        sendingAnswer = false;
        if (msg) msg.textContent = data.error || 'Не удалось отправить';
        return;
      }
      if (area) area.value = '';
      const partialBox = $('#needPartial');
      if (partialBox) partialBox.checked = false;
      rememberNeed(data);
      paintPrivate(data);
      if (data.closedAt) {
        answerLocked = true;
        if (msg) msg.textContent = 'Ответ записан';
        setTimeout(() => { location.assign('/'); }, 2000);
        return;
      }
      sendingAnswer = false;
      if (msg) msg.textContent = 'Частичный ответ записан';
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
        const partialBox = $('#needPartial');
        await sendAnswer({ text, partial: !!(partialBox && partialBox.checked) });
      };
    }
    loadPublic().catch(() => {
      if (title) title.textContent = 'Не удалось открыть вопрос';
    });
  }

  // ── Старт ────────────────────────────────────────────────────────────────
  initTheme(); initSound(); buildStatic(); initLightbox(); initInput(); initMinimap(); initModal(); initJournal(); initNeeds(); initRoster(); initNeedPage(); initRoom();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeOverlay());
  addEventListener('resize', () => {
    if (innerWidth <= 900 && $('#hier').classList.contains('open') && $('#panel').classList.contains('open')) {
      $('#panel').classList.remove('open');
    }
    if (!S.userMoved && !S.selected) goHome(false); else { clampCam(); applyCam(); }
  });
  if (window.LiveStream) LiveStream.start(() => { loadState().catch(() => {}); });
  // Кварталы строятся после первой загрузки, чтобы не застраивать участки агентов.
  loadState().then(() => {
    $('#blocks').innerHTML = M.buildBlocks(S.agents.filter(onMap).map((a) => ({ x: a.x, y: a.y, tall: Math.min(tallOf(a), 200) + 20 })));
  }).catch(() => {
    $('#blocks').innerHTML = M.buildBlocks([]);
    toast('Нет связи с сервером', 'Проверь, что приложение запущено. Повторю попытку.', 'x', true);
  }).finally(schedulePoll);
  window.OfficeLayout = { pos: MAP_POS, roomHostId };
})();
