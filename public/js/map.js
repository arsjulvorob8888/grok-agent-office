/* Стилизованная карта Москвы (2.5D, вид сверху-с юга). Всё рисуется в SVG.
   Холст 1600×1100, север сверху, Кремль ≈ (800, 540). */
(function () {
  'use strict';
  const W = 1600, H = 1100;
  const shade = (c, a) => window.Figures.shade(c, a);

  // Детерминированный генератор случайных чисел, чтобы город всегда был одинаковым.
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  // Сглаживание ломаной в кривую (Catmull-Rom → Безье).
  function smooth(pts, closed) {
    const p = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < p.length - 2; i++) {
      const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[i + 2];
      d += `C${(x1 + (x2 - x0) / 6).toFixed(1)},${(y1 + (y2 - y0) / 6).toFixed(1)} ${(x2 - (x3 - x1) / 6).toFixed(1)},${(y2 - (y3 - y1) / 6).toFixed(1)} ${x2},${y2}`;
    }
    return d + (closed ? 'Z' : '');
  }
  function sampleSmooth(pts, n) {
    // Плотная ломаная по той же кривой — для расчёта расстояний.
    const out = [];
    const p = [pts[0], ...pts, pts[pts.length - 1]];
    for (let i = 1; i < p.length - 2; i++) {
      const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[i + 2];
      const c1 = [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6], c2 = [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6];
      for (let t = 0; t < 1; t += 1 / n) {
        const u = 1 - t;
        out.push([
          u * u * u * x1 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * x2,
          u * u * u * y1 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * y2,
        ]);
      }
    }
    return out;
  }
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  function distPoly(px, py, pl) {
    let m = Infinity;
    for (let i = 1; i < pl.length; i++) m = Math.min(m, distSeg(px, py, pl[i - 1][0], pl[i - 1][1], pl[i][0], pl[i][1]));
    return m;
  }
  function inPoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  // ── География ────────────────────────────────────────────────────────────
  const RIVER = [[-40, 300], [120, 330], [240, 372], [300, 452], [380, 520], [465, 580], [470, 665], [425, 752], [432, 850], [520, 892], [620, 860], [668, 782], [702, 702], [760, 652], [840, 634], [930, 642], [1010, 690], [1080, 762], [1180, 832], [1320, 884], [1460, 930], [1640, 962]];
  const RIVER_LINE = sampleSmooth(RIVER, 12);
  const YAUZA = [[1090, 760], [1110, 690], [1120, 600], [1150, 500], [1190, 400], [1230, 300], [1280, 150], [1320, -20]];

  const KREMLIN = [[712, 592], [880, 592], [792, 452]];
  const RED_SQ = [[806, 447], [892, 586], [928, 574], [846, 440]];

  const PARKS = {
    gorky: [[712, 728], [748, 690], [802, 688], [858, 714], [866, 790], [792, 818], [718, 802]],
    sparrow: [[318, 884], [420, 892], [520, 920], [640, 884], [664, 926], [540, 968], [420, 950], [312, 934]],
    luzh: [[478, 690], [560, 676], [642, 756], [622, 846], [520, 868], [452, 800]],
    alex: [[674, 604], [776, 428], [762, 422], [659, 597]],
    sokol: [[1080, 182], [1262, 168], [1304, 300], [1236, 384], [1098, 366]],
    losiny: [[1310, -10], [1610, -10], [1610, 210], [1420, 170]],
    fili: [[40, 230], [200, 236], [226, 330], [80, 352]],
    izm: [[1430, 330], [1610, 300], [1610, 470], [1470, 470]],
    kolom: [[1150, 960], [1310, 966], [1300, 1110], [1120, 1110]],
    botan: [[930, 96], [1020, 86], [1040, 206], [940, 214]],
  };
  const PARK_NAMES = { gorky: 'Парк Горького', sparrow: 'Воробьёвы горы', sokol: 'Сокольники', losiny: 'Лосиный Остров', izm: 'Измайлово', kolom: 'Коломенское', botan: 'Ботанический сад', fili: 'Фили' };

  const RINGS = {
    garden: { cx: 805, cy: 560, rx: 300, ry: 255 },
    ttk: { cx: 790, cy: 585, rx: 560, ry: 380 },
    mkad: { cx: 800, cy: 560, rx: 900, ry: 640 },
  };
  const RADIALS = [
    [[760, 470], [470, -20]], // Тверская
    [[770, 520], [-20, 395]], // Кутузовский
    [[815, 470], [870, -20]], // Проспект Мира
    [[770, 610], [560, 1120]], // Ленинский
    [[860, 620], [960, 1120]], // Варшавка
    [[900, 560], [1620, 640]], // Энтузиастов
    [[860, 480], [1400, -20]], // Ярославка
    [[750, 480], [150, -20]], // Ленинградка
  ];

  function ellipsePath(r) {
    return `M${r.cx - r.rx},${r.cy}a${r.rx},${r.ry} 0 1,0 ${2 * r.rx},0a${r.rx},${r.ry} 0 1,0 ${-2 * r.rx},0z`;
  }
  function ringDist(x, y, r) {
    const k = Math.hypot((x - r.cx) / r.rx, (y - r.cy) / r.ry);
    return Math.abs(k - 1) * Math.min(r.rx, r.ry);
  }
  const BULVAR = (() => {
    const cx = 805, cy = 545, rx = 168, ry = 140;
    const a0 = (160 * Math.PI) / 180, a1 = (380 * Math.PI) / 180;
    const pts = [];
    for (let a = a0; a <= a1 + 1e-6; a += (a1 - a0) / 40) pts.push([cx + rx * Math.cos(a), cy - ry * Math.sin(a)]);
    return pts;
  })();

  // ── Примитивы 2.5D ───────────────────────────────────────────────────────
  // Коробка: основание x..x+w, y..y+d, высота h. Видна крыша и южный фасад.
  function box(x, y, w, d, h, color, o = {}) {
    const top = o.top || shade(color, 0.18), front = o.front || shade(color, -0.18);
    let s = `<rect x="${x}" y="${y + d - h}" width="${w}" height="${h}" fill="${front}"/>`;
    s += `<rect x="${x}" y="${y - h}" width="${w}" height="${d}" fill="${top}"/>`;
    if (o.windows) {
      const cols = Math.max(1, Math.floor((w - 4) / 7)), rows = Math.max(1, Math.floor((h - 4) / 8));
      const r = o.rand || Math.random;
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < rows; j++) {
          const off = r() < 0.35 ? ' off' : '';
          s += `<rect class="win${off}" x="${(x + 3 + i * ((w - 4) / cols)).toFixed(1)}" y="${(y + d - h + 3 + j * ((h - 4) / rows)).toFixed(1)}" width="3" height="4"/>`;
        }
    }
    return s;
  }
  // Призма по многоугольнику: южные стены + крыша.
  function prism(poly, h, top, side) {
    const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    let s = '';
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0];
      if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      if (ny > 0) s += `<path d="M${a[0]},${a[1]}L${b[0]},${b[1]}L${b[0]},${b[1] - h}L${a[0]},${a[1] - h}z" fill="${side}"/>`;
    }
    s += `<path d="M${poly.map((p) => `${p[0]},${p[1] - h}`).join('L')}z" fill="${top}"/>`;
    return s;
  }
  function onion(cx, by, r, color, gold) {
    return `<rect x="${cx - r * 0.6}" y="${by - r * 0.9}" width="${r * 1.2}" height="${r * 0.9}" fill="#f1e6d0"/>
      <path d="M${cx - r},${by - r * 0.9}C${cx - r * 1.25},${by - r * 2.2} ${cx - 0.2},${by - r * 2.1} ${cx},${by - r * 3}C${cx + 0.2},${by - r * 2.1} ${cx + r * 1.25},${by - r * 2.2} ${cx + r},${by - r * 0.9}z" fill="${color}"/>
      <path d="M${cx - r * 0.45},${by - r * 1.1}Q${cx - r * 0.5},${by - r * 2} ${cx},${by - r * 2.8}" stroke="#fff" stroke-opacity=".35" stroke-width="${r * 0.25}" fill="none"/>
      <path d="M${cx},${by - r * 3}v${-r * 0.9}M${cx - r * 0.35},${by - r * 3.5}h${r * 0.7}" stroke="${gold || '#e7b53b'}" stroke-width="${Math.max(1, r * 0.18)}"/>`;
  }
  function kremlinTower(x, y, s, o = {}) {
    const w = 10 * s, h = (o.h || 16) * s;
    let t = box(x - w / 2, y - 3 * s, w, 6 * s, h, '#b4302a', { top: '#c94a3c', front: '#9e2620' });
    t += `<path d="M${x - w / 2 - 1},${y - h - 3 * s}L${x},${y - h - 3 * s - 15 * s}L${x + w / 2 + 1},${y - h - 3 * s}z" fill="#2f6b3f"/>`;
    t += `<path d="M${x},${y - h - 3 * s}L${x},${y - h - 3 * s - 15 * s}L${x + w / 2 + 1},${y - h - 3 * s}z" fill="#24543a"/>`;
    const sy = y - h - 3 * s - 15 * s - 4 * s;
    t += `<path class="ruby" d="M${x},${sy - 4 * s}l${1.2 * s},${2.8 * s} ${3 * s},${0.3 * s}-${2.3 * s},${2 * s} ${0.7 * s},${3 * s}-${2.6 * s},-${1.6 * s}-${2.6 * s},${1.6 * s} ${0.7 * s},-${3 * s}-${2.3 * s},-${2 * s} ${3 * s},-${0.3 * s}z" fill="#e0182d"/>`;
    if (o.clock) t += `<circle cx="${x}" cy="${y + 3 * s - h * 0.62}" r="${3.3 * s}" fill="#f6efe0" stroke="#d4a017" stroke-width="${0.9 * s}"/><path d="M${x},${y + 3 * s - h * 0.62}v${-2.2 * s}M${x},${y + 3 * s - h * 0.62}h${1.6 * s}" stroke="#222" stroke-width=".7"/>`;
    return `<g class="ktower">${t}</g>`;
  }
  function tree(x, y, r) {
    x = +x; y = +y; r = +r;
    return `<circle class="tree-s" cx="${x + 1.5}" cy="${y + 2}" r="${r}"/><circle class="tree" cx="${x}" cy="${y}" r="${r}"/><circle class="tree-h" cx="${x - r * 0.3}" cy="${y - r * 0.35}" r="${r * 0.45}"/>`;
  }

  // ── Базовый слой: земля, вода, парки, дороги ─────────────────────────────
  function buildBase() {
    const r = rng(7);
    let s = `<rect class="land-out" x="-3000" y="-3000" width="${W + 6000}" height="${H + 6000}"/><rect x="-3000" y="-3000" width="${W + 6000}" height="${H + 6000}" fill="url(#landGrid)" opacity=".35"/>`;
    s += `<rect class="land" x="0" y="0" width="${W}" height="${H}" rx="60"/>`;
    s += `<rect x="0" y="0" width="${W}" height="${H}" rx="28" fill="url(#landGrid)" opacity=".55"/>`;
    s += `<path class="mkad" d="${ellipsePath(RINGS.mkad)}"/>`;
    for (const [k, p] of Object.entries(PARKS)) s += `<path class="park" data-park="${k}" d="${smooth(p, true)}"/>`;
    // Дороги
    s += `<g class="roads">`;
    for (const [a, b] of RADIALS) s += `<path class="road-e" d="M${a}L${b}"/>`;
    s += `<path class="road-e ring" d="${ellipsePath(RINGS.ttk)}"/><path class="road-e ring" d="${ellipsePath(RINGS.garden)}"/>`;
    for (const [a, b] of RADIALS) s += `<path class="road" d="M${a}L${b}"/>`;
    s += `<path id="ring-ttk" class="road ring" d="${ellipsePath(RINGS.ttk)}"/><path id="ring-garden" class="road ring garden" d="${ellipsePath(RINGS.garden)}"/>`;
    s += `<path class="bulvar" d="${smooth(BULVAR)}"/><path class="bulvar-t" d="${smooth(BULVAR)}"/>`;
    s += `</g>`;
    // Река
    const rd = smooth(RIVER);
    s += `<path class="river-bank" d="${rd}"/><path class="river" id="river-path" d="${rd}"/><path class="river-hl" d="${rd}"/><path class="river-shimmer" d="${rd}"/>`;
    s += `<path class="yauza-bank" d="${smooth(YAUZA)}"/><path class="yauza" d="${smooth(YAUZA)}"/>`;
    // Мосты
    for (const [a, b] of RADIALS) {
      for (let i = 1; i < RIVER_LINE.length; i++) {
        const p = segInter(a, b, RIVER_LINE[i - 1], RIVER_LINE[i]);
        if (p) {
          const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          s += `<rect class="bridge" x="${p[0] - 22}" y="${p[1] - 7}" width="44" height="14" rx="2" transform="rotate(${ang.toFixed(1)} ${p[0]} ${p[1]})"/>`;
          break;
        }
      }
    }
    return s;
  }
  function segInter(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * q[1] - r[1] * q[0];
    if (!den) return null;
    const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
  }

  // Подписи на карте (река, кольца, парки).
  function buildLabels() {
    let s = `<path id="river-label-path" d="${smooth(RIVER.slice(13, 18))}" fill="none"/>`;
    s += `<text class="map-label water-l" dy="4"><textPath href="#river-label-path" startOffset="18%">Москва-река</textPath></text>`;
    s += `<path id="garden-label-path" d="M${805 - 300 * Math.cos(0.5)},${560 - 255 * Math.sin(0.5)}A300,255 0 0,1 ${805 + 300 * Math.cos(0.5)},${560 - 255 * Math.sin(0.5)}" fill="none"/>`;
    s += `<text class="map-label ring-l" dy="-11"><textPath href="#garden-label-path" startOffset="50%" text-anchor="middle">Садовое кольцо</textPath></text>`;
    const pos = { gorky: [800, 812], sparrow: [600, 952], sokol: [1240, 214], losiny: [1500, 80], izm: [1525, 395], kolom: [1220, 1040], botan: [985, 238], fili: [130, 300] };
    for (const [k, p] of Object.entries(pos)) s += `<text class="map-label park-l" x="${p[0]}" y="${p[1]}" text-anchor="middle">${PARK_NAMES[k]}</text>`;
    s += `<text class="map-label ring-l" x="1290" y="${585 - 0}" text-anchor="middle" transform="rotate(84 1350 585)" dy="-8">ТТК</text>`;
    return s;
  }

  // ── Процедурные кварталы ─────────────────────────────────────────────────
  function buildBlocks(agents) {
    const r = rng(42);
    const parts = [];
    const step = 36;
    const excl = (x, y) => {
      if (x < 22 || y < 30 || x > W - 22 || y > H - 18) return true;
      if (distPoly(x, y, RIVER_LINE) < 34) return true;
      if (ringDist(x, y, RINGS.garden) < 14 || ringDist(x, y, RINGS.ttk) < 13) return true;
      for (const [a, b] of RADIALS) if (distSeg(x, y, a[0], a[1], b[0], b[1]) < 13) return true;
      if (distPoly(x, y, BULVAR) < 9) return true;
      for (const p of Object.values(PARKS)) if (inPoly(x, y, p)) return true;
      if (inPoly(x, y, [[660, 632], [930, 632], [795, 395]])) return true;
      if (inPoly(x, y, [[775, 405], [925, 625], [1000, 625], [880, 395]])) return true;
      if (distPoly(x, y, sampleSmooth(YAUZA, 6)) < 14) return true;
      for (const lm of LANDMARK_ZONES) if (Math.abs(x - lm[0]) < lm[2] && y < lm[1] + 20 && y > lm[1] - lm[3]) return true;
      for (const a of agents) {
        const dx = x - a.x, dy = y - a.y;
        if ((dx / 110) ** 2 + (dy / 70) ** 2 < 1) return true;
        if (Math.abs(dx) < 80 && dy < 0 && dy > -(a.tall || 120)) return true;
      }
      return false;
    };
    for (let gy = 30; gy < H; gy += step) {
      for (let gx = 20; gx < W; gx += step) {
        const x = gx + (r() - 0.5) * 8, y = gy + (r() - 0.5) * 8;
        if (r() < 0.12) continue;
        const w = 14 + r() * 14, d = 9 + r() * 10;
        if (excl(x + w / 2, y + d / 2) || excl(x, y) || excl(x + w, y + d)) continue;
        const center = Math.hypot((x - 800) / 700, (y - 560) / 500);
        const h = 4 + r() * (center < 0.5 ? 16 : center < 0.9 ? 11 : 7);
        const cls = 'b' + (1 + Math.floor(r() * 3));
        let wins = '';
        if (r() < 0.75) {
          const n = 1 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) wins += `<rect class="bw${r() < 0.4 ? ' off' : ''}" x="${(x + 2 + r() * (w - 6)).toFixed(1)}" y="${(y + d - h + 1.5 + r() * Math.max(0.5, h - 5)).toFixed(1)}" width="2.4" height="2.6"/>`;
        }
        parts.push(`<g class="blk ${cls}"><rect class="bf" x="${x.toFixed(1)}" y="${(y + d - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/><rect class="bt" x="${x.toFixed(1)}" y="${(y - h).toFixed(1)}" width="${w.toFixed(1)}" height="${d.toFixed(1)}"/>${wins}</g>`);
      }
    }
    // Деревья в парках
    for (const p of Object.values(PARKS)) {
      const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
      const n = Math.round(((maxx - minx) * (maxy - miny)) / 700);
      for (let i = 0; i < n; i++) {
        const x = minx + r() * (maxx - minx), y = miny + r() * (maxy - miny);
        if (!inPoly(x, y, p) || distPoly(x, y, RIVER_LINE) < 22) continue;
        if (agents.some((a) => Math.abs(x - a.x) < 90 && y < a.y + 40 && y > a.y - (a.tall || 120))) continue;
        if (Math.hypot(x - 545, y - 775) < 62) continue;
        parts.push(tree(x.toFixed(1), y.toFixed(1), (4 + r() * 4).toFixed(1)));
      }
    }
    return parts.join('');
  }

  // [x, y, полуширина, высота] — зоны достопримечательностей без кварталов.
  const LANDMARK_ZONES = [
    [545, 775, 70, 50], [680, 615, 34, 70], [1031, 635, 34, 130], [1012, 392, 30, 120], [790, 790, 10, 10],
  ];

  // ── Достопримечательности ───────────────────────────────────────────────
  function buildLandmarks() {
    const L = [];
    const lm = (id, name, x, y, inner) => L.push(`<g class="landmark" data-lm="${id}" data-name="${name}" data-x="${x}" data-y="${y}">${inner}</g>`);

    // Кремль
    let k = `<path d="M${KREMLIN.map((p) => p.join(',')).join('L')}z" class="kremlin-ground"/>`;
    k += `<path d="M${RED_SQ.map((p) => p.join(',')).join('L')}z" class="redsq"/>`;
    k += `<path d="M${RED_SQ.map((p) => p.join(',')).join('L')}z" fill="url(#cobble)" opacity=".5"/>`;
    // ГУМ вдоль Красной площади
    k += prism([[848, 432], [936, 568], [952, 562], [864, 426]], 14, '#e9dcc3', '#cbb894');
    // постройки внутри
    k += box(728, 512, 60, 16, 20, '#efe3c2', { top: '#4f8a63', front: '#e6d6ad', windows: true, rand: rng(3) });
    k += prism([[778, 478], [812, 478], [795, 500]], 16, '#f1e2b1', '#d9c48e');
    k += `<ellipse cx="796" cy="474" rx="7" ry="4" fill="#3f7d58"/><path d="M796,470v-8" stroke="#d4a017" stroke-width="1.6"/>`;
    k += box(818, 512, 9, 7, 46, '#f6f1e6', { front: '#e7dfcc' });
    k += onion(822.5, 466, 4.5, '#e2b53a', '#f6d26b');
    for (const [cx, cy] of [[768, 548], [790, 552], [748, 548]]) {
      k += box(cx - 7, cy - 6, 14, 8, 12, '#f6f1e6', { front: '#e2dac8' });
      k += onion(cx, cy - 16, 3.2, '#e2b53a', '#f6d26b');
    }
    // стены: «объём» за счёт двух обводок
    const wall = `M${KREMLIN.map((p) => p.join(',')).join('L')}z`;
    k += `<path d="${wall}" class="kwall-side"/><path d="${wall}" class="kwall-top" transform="translate(0,-6)"/><path d="${wall}" class="kwall-cren" transform="translate(0,-9)"/>`;
    // башни
    const towers = [[712, 592, 1.2], [880, 592, 1.2], [792, 452, 1.25], [752, 522, 1.05], [796, 592, 1.0], [826, 494, 1.0], [748, 592, 0.9], [840, 592, 0.9]];
    for (const [x, y, s] of towers) k += kremlinTower(x, y, s);
    k += kremlinTower(857, 556, 1.55, { h: 30, clock: true });
    lm('kremlin', 'Московский Кремль', 800, 520, `<g transform="translate(800,540) scale(1.25) translate(-800,-540)">${k}</g>`);

    // Собор Василия Блаженного
    let sb = box(906, 592, 42, 16, 12, '#c0453a', { top: '#d8705f', front: '#a8352c' });
    sb += `<path d="M927,580l-6,-6h12z" fill="#8e2a22"/><path d="M921.5,574l5.5,-34l5.5,34z" fill="#c9a043"/><path d="M921.5,574l5.5,-34l1,34z" fill="#3b7d4f"/>`;
    sb += onion(927, 538, 2.4, '#e2b53a');
    sb += onion(912, 584, 4.6, '#2f8f5b') + onion(942, 584, 4.6, '#d4a017') + onion(918, 594, 5.2, '#c8102e') + onion(936, 594, 5.2, '#1f6fbf') + onion(927, 600, 4.4, '#e05a2b');
    lm('basil', 'Храм Василия Блаженного', 959, 590, `<g transform="translate(800,540) scale(1.25) translate(-800,-540)">${sb}</g>`);

    // Храм Христа Спасителя
    let hx = box(662, 606, 36, 18, 20, '#f4f1ea', { front: '#e0dbcf', top: '#ece6d8' });
    hx += `<ellipse cx="680" cy="588" rx="11" ry="4" fill="#e3e0d6"/><path d="M669,588a11,13 0 0 1 22,0z" fill="#e2b53a"/><path d="M680,575v-8M677,571h6" stroke="#e2b53a" stroke-width="1.6"/>`;
    for (const dx of [-13, 13]) hx += `<path d="M${680 + dx - 3.5},${590}a3.5,4.5 0 0 1 7,0z" fill="#e2b53a"/>`;
    lm('hhs', 'Храм Христа Спасителя', 680, 600, hx);

    // Высотка на Котельнической
    let kt = box(974, 612, 54, 14, 22, '#e9dcc0', { windows: true, rand: rng(11) });
    kt += box(988, 604, 26, 12, 56, '#efe2c5', { windows: true, rand: rng(12) });
    kt += box(995, 598, 12, 8, 72, '#f2e6cb');
    kt += `<path d="M1001,526l0,-26" stroke="#d4a017" stroke-width="2.4"/><path d="M1001,500l2,4 4,.5-3,2.6 1,4-4-2-4,2 1-4-3-2.6 4-.5z" fill="#e0182d"/>`;
    lm('kotel', 'Высотка на Котельнической', 1031, 600, `<g transform="translate(30,10)">${kt}</g>`);

    // Гостиница «Ленинградская»
    let lg = box(992, 386, 40, 12, 26, '#e3d4b6', { windows: true, rand: rng(13) });
    lg += box(1002, 380, 20, 10, 62, '#eadcc0', { windows: true, rand: rng(14) });
    lg += `<path d="M1012,318l0,-26" stroke="#d4a017" stroke-width="2"/><path d="M1006,330l6,-12 6,12z" fill="#cdb98f"/>`;
    lm('lenin', 'Высотка «Ленинградская»', 1012, 370, lg);

    // Лужники
    let lz = `<ellipse cx="545" cy="783" rx="58" ry="34" class="stad-side"/><ellipse cx="545" cy="775" rx="58" ry="34" class="stad-top"/>`;
    lz += `<ellipse cx="545" cy="775" rx="44" ry="24" fill="#2e8b57"/><ellipse cx="545" cy="775" rx="44" ry="24" fill="none" stroke="#c94a3c" stroke-width="5" opacity=".9"/>`;
    lz += `<rect x="527" y="767" width="36" height="16" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1"/><path d="M545,767v16" stroke="#fff" stroke-opacity=".7"/><circle cx="545" cy="775" r="4" fill="none" stroke="#fff" stroke-opacity=".7"/>`;
    lz += `<ellipse cx="545" cy="775" rx="58" ry="34" fill="none" stroke="#fff" stroke-width="3" stroke-opacity=".8"/>`;
    lm('luzh', 'Стадион «Лужники»', 545, 770, lz);

    // Арка Парка Горького
    let gp = box(770, 806, 40, 6, 18, '#efe7d6', { front: '#e2d7bf' });
    gp += `<rect x="784" y="800" width="12" height="12" rx="6" fill="#6b5b45"/>`;
    for (let i = 0; i < 6; i++) gp += `<rect x="${772 + i * 7}" y="794" width="1.6" height="18" fill="#cfc2a6"/>`;
    gp += `<path d="M774,788h32" stroke="#c8102e" stroke-width="2"/>`;
    lm('gorky', 'Парк Горького', 790, 790, gp);

    return L.join('');
  }

  // ── Здания направлений ─────────────────────────────────────────────────
  // Высота «шапки» здания над точкой агента (для расстановки облачков).
  const TALL = { putin: 150, trading: 190, blog: 260, lang: 200, army: 130, poker: 110, devops: 100, dev: 130, temshik: 100, finance: 120, invest: 78, analyst: 72, vacant: 120, biz: 110, generic: 110 };

  function building(kind, color) {
    const R = rng(color.length * 97 + kind.length * 13);
    const c = color;
    switch (kind) {
      case 'putin':
        return `<ellipse cx="0" cy="34" rx="34" ry="10" fill="#8e1b2a" opacity=".85"/><ellipse cx="0" cy="34" rx="34" ry="10" fill="none" stroke="#f5c451" stroke-width="1.5"/>`;
      case 'army': {
        let s = box(-62, -30, 124, 22, 40, '#cfc4a0', { windows: true, rand: R, top: '#b9ad86', front: '#ddd2ae' });
        s += box(-18, -40, 36, 18, 74, '#d8cda9', { windows: true, rand: R, top: '#c4b78f' });
        s += `<path d="M0,-114v-14" stroke="#8b7a4a" stroke-width="2"/><path d="M0,-140l3,6 6.5,.6-5,4.3 1.5,6.3-6-3.4-6,3.4 1.5-6.3-5-4.3 6.5-.6z" class="ruby" fill="#e0182d"/>`;
        s += `<rect x="-56" y="-2" width="112" height="3" fill="${c}"/><path d="M-50,-28v-26M50,-28v-26" stroke="#555" stroke-width="1.2"/><path d="M-50,-54h10v6h-10zM50,-54h-10v6h10z" fill="#c8102e"/>`;
        return s;
      }
      case 'poker': {
        let s = box(-58, -26, 116, 22, 46, '#14513b', { top: '#0f3d2c', front: '#1a6b4d' });
        s += `<rect x="-58" y="-28" width="116" height="4" fill="#d4a017"/>`;
        s += `<rect x="-36" y="-22" width="72" height="20" rx="4" fill="#0b2a1f" stroke="#d4a017" stroke-width="1.5"/>`;
        s += `<text class="neon" x="0" y="-7" text-anchor="middle" font-size="14" font-weight="800" fill="#ffd34d" font-family="Unbounded, sans-serif">♠ SPIN</text>`;
        for (let i = 0; i < 14; i++) s += `<circle class="marquee" style="animation-delay:${(i * 0.12).toFixed(2)}s" cx="${-54 + i * 8.3}" cy="-54" r="1.8" fill="#ffd34d"/>`;
        s += box(-40, -76, 20, 14, 10, '#0d3326') + box(18, -76, 24, 14, 12, '#0d3326');
        return s;
      }
      case 'trading': {
        let s = '';
        const T = [[-66, 70, '#5aa9e6'], [-40, 132, '#2f7fd1'], [-14, 168, '#1f6fbf'], [12, 150, '#3c8fe0'], [38, 104, '#77b9ef'], [-90, 54, '#8cc6f2']];
        for (const [x, h, col] of T) {
          s += `<rect x="${x}" y="${-h + 4}" width="24" height="${h}" fill="${shade(col, -0.15)}"/>`;
          s += `<rect x="${x}" y="${-h - 10}" width="24" height="14" fill="${shade(col, 0.25)}"/>`;
          for (let y = -h + 8; y < 0; y += 7) s += `<rect class="win${R() < 0.3 ? ' off' : ''}" x="${x + 2}" y="${y}" width="20" height="2.2" opacity=".85"/>`;
          s += `<rect x="${x + 2}" y="${-h + 4}" width="5" height="${h - 4}" fill="#fff" opacity=".18"/>`;
        }
        s += `<path d="M-14,-178l12,-14 14,14" fill="none" stroke="#bfe3ff" stroke-width="1.5"/>`;
        s += `<g class="ticker"><rect x="-70" y="-6" width="140" height="12" rx="3" fill="#06121f"/><text x="0" y="3.5" text-anchor="middle" font-size="8.5" fill="#27e08f" font-family="monospace" font-weight="700">▲ IMOEX +1.24%  ▲ BTC +2.1%</text></g>`;
        return s;
      }
      case 'devops': {
        let s = box(-60, -24, 120, 24, 34, '#4b5563', { top: '#6b7280', front: '#374151' });
        for (let r = 0; r < 3; r++) for (let i = 0; i < 12; i++) s += `<circle class="led" style="animation-delay:${(R() * 2).toFixed(2)}s" cx="${-54 + i * 9.8}" cy="${-30 + r * 9}" r="1.6" fill="${R() < 0.7 ? '#22c55e' : '#f59e0b'}"/>`;
        for (const x of [-42, -10, 22]) s += `<circle cx="${x + 10}" cy="-52" r="8" fill="#9ca3af"/><g class="fan" style="transform-origin:${x + 10}px -52px"><path d="M${x + 10},-52l0,-7M${x + 10},-52l6,4M${x + 10},-52l-6,4" stroke="#374151" stroke-width="2.2"/></g>`;
        s += `<path d="M48,-58v-34" stroke="#9ca3af" stroke-width="2"/><circle class="blink" cx="48" cy="-94" r="3" fill="#ef4444"/><path d="M40,-80l8-6 8,6" stroke="#9ca3af" fill="none"/>`;
        s += `<rect x="-60" y="-2" width="120" height="3" fill="${c}"/>`;
        return s;
      }
      case 'dev': {
        let s = box(-44, -30, 88, 24, 80, '#4c2fa6', { top: '#6d4fd6', front: '#3a2380' });
        for (let y = -100; y < -8; y += 9) for (let x = -40; x < 40; x += 10) s += `<rect class="win${R() < 0.35 ? ' off' : ''}" x="${x}" y="${y}" width="7" height="5"/>`;
        s += `<rect x="-26" y="-140" width="52" height="22" rx="5" fill="#120a2b" stroke="#9f86ff" stroke-width="1.5"/><text class="neon" x="0" y="-124" text-anchor="middle" font-size="13" font-weight="800" fill="#b9a5ff" font-family="monospace">&lt;/&gt;</text>`;
        s += `<path d="M-20,-118v8M20,-118v8" stroke="#9f86ff" stroke-width="1.5"/>`;
        return s;
      }
      case 'temshik': {
        let s = '';
        const cols = ['#d4a017', '#c8102e', '#1f7ae0', '#0f8a5f'];
        for (let i = 0; i < 4; i++) {
          const x = -64 + i * 32;
          s += box(x, -26, 28, 16, 18, '#7a5a2a', { top: '#8a6a3a', front: '#6b4e24' });
          s += `<path d="M${x - 3},-44l17,-16 17,16z" fill="${cols[i]}"/><path d="M${x + 4},-44l10,-16 3,16z" fill="#fff" opacity=".25"/>`;
        }
        s += `<g class="bulb"><circle cx="0" cy="-92" r="15" fill="#ffe066"/><circle cx="0" cy="-92" r="22" fill="#ffe066" opacity=".22"/><rect x="-6" y="-78" width="12" height="7" rx="2" fill="#8b8b8b"/><text x="0" y="-86" text-anchor="middle" font-size="16" font-weight="900" fill="#7a5a00" font-family="Unbounded, sans-serif">₽</text></g>`;
        return s;
      }
      case 'blog': {
        let s = box(-60, -22, 56, 20, 28, '#e3d8e8', { windows: true, rand: R, top: '#cdbfd6' });
        s += `<rect x="-56" y="-46" width="48" height="11" rx="2" fill="#2b0f1d"/><text class="onair" x="-32" y="-37.5" text-anchor="middle" font-size="8" font-weight="800" fill="#ff4d6d" font-family="Unbounded, sans-serif">ON AIR</text>`;
        // Останкинская башня
        s += `<path d="M14,0l12,-36l6,0l12,36z" fill="#d9d6d0"/><path d="M26,-36l3,-150h0l3,150z" fill="#eceae5"/><path d="M29,-186l0,0" />`;
        s += `<rect x="22" y="-120" width="14" height="10" rx="2" fill="#bdb8ae"/><rect x="21" y="-124" width="16" height="4" rx="1.5" fill="#9e9a92"/>`;
        s += `<path d="M29,-186v-70" stroke="#e6e3dc" stroke-width="3"/><path d="M29,-226v-30" stroke="#c94a3c" stroke-width="3" stroke-dasharray="5 5"/><circle class="blink" cx="29" cy="-258" r="3" fill="#ff4d6d"/>`;
        return s;
      }
      case 'lang': {
        let s = box(-70, -20, 140, 18, 30, '#e8dcc2', { windows: true, rand: R });
        s += box(-40, -28, 80, 16, 70, '#eee2c8', { windows: true, rand: R });
        s += box(-20, -34, 40, 12, 120, '#f2e6cc', { windows: true, rand: R });
        s += `<path d="M-8,-154l8,-20 8,20z" fill="#d9c9a5"/><path d="M0,-174v-24" stroke="#d4a017" stroke-width="2.4"/><circle cx="0" cy="-200" r="4" fill="#e7b53b"/>`;
        return s;
      }
      case 'biz': {
        let s = box(-40, -34, 80, 30, 66, '#0e7c74', { top: '#16a39a', front: '#0b5f59' });
        for (let x = -36; x < 40; x += 10) s += `<path d="M${x},-96v92" stroke="#7de3d9" stroke-opacity=".4"/>`;
        for (let y = -90; y < 0; y += 10) s += `<path d="M-40,${y}h80" stroke="#7de3d9" stroke-opacity=".4"/>`;
        return s;
      }
      case 'finance': {
        let s = box(-72, -26, 144, 24, 46, '#e6dcc4', { top: '#f4efe2', front: '#d4c8aa', windows: true, rand: R });
        for (let i = 0; i < 6; i++) {
          const x = -54 + i * 20;
          s += `<rect x="${x}" y="-58" width="7" height="34" fill="#f7f3e8"/><rect x="${x - 1}" y="-62" width="9" height="5" fill="#e4d094"/>`;
        }
        s += `<path d="M-64,-62 L0,-96 L64,-62 Z" fill="#f8f3e6" stroke="#c6a15a" stroke-width="1.6"/>`;
        s += `<text x="0" y="-70" text-anchor="middle" font-size="16" font-weight="800" fill="#8a6a1f" font-family="Unbounded, sans-serif">₽</text>`;
        s += `<rect x="-16" y="-24" width="32" height="22" fill="#1a3a5c"/><rect x="-7" y="-18" width="14" height="16" fill="#0e2438"/>`;
        s += `<rect x="-72" y="-2" width="144" height="4" fill="#1a3a5c"/>`;
        return s;
      }
      case 'invest': {
        let s = box(-38, -16, 76, 16, 34, '#1a3a5c', { top: '#24527a', front: '#12283f' });
        s += `<path d="M-26,-30 l12,-16 8,9 16,-22 10,8" fill="none" stroke="#f5c451" stroke-width="2.6" stroke-linejoin="round"/>`;
        s += `<circle cx="20" cy="-51" r="3.2" fill="#f5c451"/>`;
        s += `<text x="0" y="-6" text-anchor="middle" font-size="12" font-weight="800" fill="#f5c451" font-family="Unbounded, sans-serif">₽</text>`;
        return s;
      }
      case 'analyst': {
        let s = box(-36, -14, 72, 16, 30, '#e7efe4', { top: '#f4faf3', front: '#d5e4d4', windows: true, rand: R });
        [14, 24, 18, 30].forEach((h, i) => {
          s += `<rect x="${-24 + i * 13}" y="${-18 - h}" width="9" height="${h}" rx="1" fill="${i % 2 ? '#1a3a5c' : '#c6a15a'}"/>`;
        });
        return s;
      }
      case 'vacant': {
        let s = `<rect x="-64" y="-30" width="128" height="34" fill="#a68a64" opacity=".55"/><path d="M-64,-30h128v34h-128z" fill="none" stroke="#f5c451" stroke-width="2" stroke-dasharray="6 4"/>`;
        s += `<path d="M-48,0v-108M-48,-108h92M-48,-92l16,-16M36,-108v30" stroke="#f5b400" stroke-width="3" fill="none"/><path d="M-52,0h8M-48,-20l-6,0" stroke="#f5b400" stroke-width="3"/>`;
        for (let y = -100; y < 0; y += 12) s += `<path d="M-52,${y}l8,10" stroke="#f5b400" stroke-width="1.5"/>`;
        s += `<rect class="hook" x="30" y="-78" width="12" height="10" fill="#7a5a2a"/>`;
        s += `<rect x="20" y="-20" width="34" height="16" rx="2" fill="#f5c451"/><text x="37" y="-9" text-anchor="middle" font-size="8" font-weight="800" fill="#4a3500" font-family="Unbounded, sans-serif">СКОРО</text>`;
        return s;
      }
      default: {
        let s = box(-46, -30, 92, 24, 60, c, { windows: true, rand: R });
        s += `<rect x="-46" y="-2" width="92" height="3" fill="${shade(c, 0.4)}"/>`;
        return s;
      }
    }
  }

  window.MoscowMap = { W, H, buildBase, buildBlocks, buildLandmarks, buildLabels, building, TALL, RINGS, RADIALS, ellipsePath, smooth };
})();
