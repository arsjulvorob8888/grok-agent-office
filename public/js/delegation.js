/* Стрелки делегирования: от здания отправителя к зданию исполнителя, пока приказ жив. */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const OPEN = new Set(['sent', 'accepted', 'in_progress']);
  let lastSig = '';
  let lastEvent = 0;

  function layer() {
    let g = document.getElementById('delegations');
    if (g) return g;
    const world = document.getElementById('world');
    if (!world) return null;
    g = document.createElementNS(SVGNS, 'g');
    g.id = 'delegations';
    const before = document.getElementById('agents');
    if (before) world.insertBefore(g, before);
    else world.appendChild(g);
    return g;
  }

  function screenScale() {
    const world = document.getElementById('world');
    if (!world || !world.getScreenCTM) return 1;
    const m = world.getScreenCTM();
    if (!m) return 1;
    return Math.max(0.05, Math.hypot(m.a, m.b));
  }

  function roof(agent, byId) {
    if (!agent) return null;
    let host = agent;
    const layout = window.OfficeLayout;
    if (layout && byId) {
      const hostId = layout.roomHostId(agent);
      if (hostId && byId.get(hostId)) host = byId.get(hostId);
    }
    const pos = layout && layout.pos && layout.pos[host.id];
    const x = pos ? pos[0] : host.x;
    const y = pos ? pos[1] : host.y;
    const main = host.id === 'grok' || host.tier === 'main';
    const lift = main ? 78 : 86;
    return { x, y: y - lift };
  }

  function curve(x0, y0, x1, y1, bendSign) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(120, len * 0.22) * bendSign;
    const cx = (x0 + x1) / 2 - (dy / len) * bend;
    const cy = (y0 + y1) / 2 + (dx / len) * bend - 28;
    return { d: `M${x0.toFixed(1)},${y0.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`, cx, cy, x1, y1 };
  }

  function loop(x, y) {
    const cx = x;
    const cy = y - 70;
    return { d: `M${x.toFixed(1)},${y.toFixed(1)} C ${(x - 46).toFixed(1)},${(y - 90).toFixed(1)} ${(x + 46).toFixed(1)},${(y - 90).toFixed(1)} ${x.toFixed(1)},${(y - 8).toFixed(1)}`, cx, cy, x1: x, y1: y - 8 };
  }

  function arrowPoints(tip, cx, cy, size) {
    const ang = Math.atan2(tip.y - cy, tip.x - cx);
    const back = ang + Math.PI;
    const wing = 0.45;
    const p1 = [tip.x, tip.y];
    const p2 = [tip.x + Math.cos(back + wing) * size, tip.y + Math.sin(back + wing) * size];
    const p3 = [tip.x + Math.cos(back - wing) * size, tip.y + Math.sin(back - wing) * size];
    return [p1, p2, p3].map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
  }

  function activeOrders(tasks) {
    return (tasks || []).filter((t) => t && OPEN.has(t.orderStatus));
  }

  function draw(tasks, agents) {
    const g = layer();
    if (!g) return;
    const byId = new Map((agents || []).map((a) => [a.id, a]));
    const orders = activeOrders(tasks);
    const pairCount = new Map();
    const parts = [];
    for (const t of orders) {
      const to = byId.get(t.agentId || t.agent);
      if (!to || to.archived) continue;
      const fromId = !t.fromAgentId || t.fromAgentId === 'owner' ? 'grok' : t.fromAgentId;
      const from = byId.get(fromId) || byId.get('grok');
      if (!from || from.archived) continue;
      const a = roof(from, byId);
      const b = roof(to, byId);
      if (!a || !b) continue;
      const key = [from.id, to.id].sort().join('>');
      const n = pairCount.get(key) || 0;
      pairCount.set(key, n + 1);
      const same = Math.hypot(b.x - a.x, b.y - a.y) < 12;
      const shape = same ? loop(a.x, a.y) : curve(a.x, a.y, b.x, b.y, n % 2 === 0 ? 1 : -1);
      if (!same && n > 0) {
        const extra = (n % 2 === 0 ? 1 : -1) * n * 18;
        const again = curve(a.x, a.y + extra * 0.2, b.x, b.y, (n % 2 === 0 ? 1 : -1) * (1 + n * 0.35));
        shape.d = again.d;
        shape.cx = again.cx;
        shape.cy = again.cy;
        shape.x1 = again.x1;
        shape.y1 = again.y1;
      }
      const status = t.orderStatus;
      parts.push({ id: t.id, status, shape });
    }
    const sig = parts.map((p) => `${p.id}:${p.status}:${p.shape.d}`).join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      g.replaceChildren();
      for (const p of parts) {
        const node = document.createElementNS(SVGNS, 'g');
        node.setAttribute('class', `deleg ${p.status}`);
        node.dataset.orderId = p.id;
        node.dataset.status = p.status;
        const hit = document.createElementNS(SVGNS, 'path');
        hit.setAttribute('class', 'deleg-hit');
        hit.setAttribute('data-order-id', p.id);
        hit.setAttribute('d', p.shape.d);
        const line = document.createElementNS(SVGNS, 'path');
        line.setAttribute('class', `deleg-line ${p.status}`);
        line.setAttribute('data-order-id', p.id);
        line.setAttribute('data-status', p.status);
        line.setAttribute('d', p.shape.d);
        const head = document.createElementNS(SVGNS, 'polygon');
        head.setAttribute('class', `deleg-arrow ${p.status}`);
        head.setAttribute('data-order-id', p.id);
        head.dataset.cx = String(p.shape.cx);
        head.dataset.cy = String(p.shape.cy);
        head.dataset.x = String(p.shape.x1);
        head.dataset.y = String(p.shape.y1);
        node.append(hit, line, head);
        g.appendChild(node);
      }
    }
    rescale();
  }

  function rescale() {
    const k = screenScale();
    const hit = Math.max(16, 40 / k);
    const stroke = Math.max(4, 4.5 / k);
    const arrow = Math.max(14, 16 / k);
    document.querySelectorAll('#delegations .deleg-hit').forEach((p) => {
      p.setAttribute('stroke-width', hit.toFixed(1));
    });
    document.querySelectorAll('#delegations .deleg-line').forEach((p) => {
      p.setAttribute('stroke-width', stroke.toFixed(1));
    });
    document.querySelectorAll('#delegations .deleg-arrow').forEach((poly) => {
      const tip = { x: Number(poly.dataset.x), y: Number(poly.dataset.y) };
      poly.setAttribute('points', arrowPoints(tip, Number(poly.dataset.cx), Number(poly.dataset.cy), arrow));
    });
  }

  function click(target) {
    if (!target || !target.closest) return false;
    const node = target.closest('#delegations [data-order-id]');
    if (!node) return false;
    const id = node.getAttribute('data-order-id') || node.dataset.orderId;
    if (id && window.Office && typeof window.Office.openOrder === 'function') window.Office.openOrder(id);
    return true;
  }

  function take(data) {
    draw((data && data.tasks) || [], (data && data.agents) || []);
  }

  document.addEventListener('officestate', (e) => {
    lastEvent = Date.now();
    take(e.detail);
  });

  const world = document.getElementById('world');
  if (world) {
    new MutationObserver(() => rescale()).observe(world, { attributes: true, attributeFilter: ['transform'] });
  }

  async function fallback() {
    if (Date.now() - lastEvent < 6000) return;
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return;
    lastEvent = Date.now();
    take(await res.json());
  }
  setInterval(() => { fallback().catch(() => {}); }, 4000);

  window.Delegation = { click, rescale, take };
})();
