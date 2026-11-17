/* Фигурки агентов: чиби-персонажи, нарисованные в SVG.
   Ноги стоят в точке (0,0), рост ~100 единиц. */
(function () {
  'use strict';

  function shade(hex, amt) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    const n = parseInt(c, 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + (amt < 0 ? v * amt : (255 - v) * amt))));
    const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  const SKIN = '#f2c9a4';

  // Простое лицо для подчинённых агентов.
  function face(o) {
    const skin = o.skin || SKIN;
    const eyes = o.glasses
      ? `<g fill="none" stroke="#2a2f3a" stroke-width="1.8"><circle cx="-8.5" cy="-67" r="5.2" fill="#ffffff55"/><circle cx="8.5" cy="-67" r="5.2" fill="#ffffff55"/><path d="M-3.3,-67h6.6"/></g><circle cx="-8.5" cy="-67" r="1.9" fill="#222"/><circle cx="8.5" cy="-67" r="1.9" fill="#222"/>`
      : o.shades
        ? `<path d="M-15,-70h12a2,2 0 0 1 2,2v2a5,5 0 0 1-5,5h-6a5,5 0 0 1-5-5v-2a2,2 0 0 1 2-2zM3,-70h12a2,2 0 0 1 2,2v2a5,5 0 0 1-5,5h-6a5,5 0 0 1-5-5v-2a2,2 0 0 1 2-2z" fill="#111"/><path d="M-1,-68h2" stroke="#111" stroke-width="2"/><path d="M-12,-68l3,0" stroke="#fff8" stroke-width="1.2"/>`
        : `<g class="eyes"><ellipse cx="-8.5" cy="-67" rx="2.6" ry="3.1" fill="#232733"/><ellipse cx="8.5" cy="-67" rx="2.6" ry="3.1" fill="#232733"/><circle cx="-7.6" cy="-68.2" r=".9" fill="#fff"/><circle cx="9.4" cy="-68.2" r=".9" fill="#fff"/></g>`;
    return `
      <ellipse cx="-22" cy="-66" rx="4" ry="5.5" fill="${shade(skin, -0.08)}"/>
      <ellipse cx="22" cy="-66" rx="4" ry="5.5" fill="${shade(skin, -0.08)}"/>
      <ellipse cx="0" cy="-68" rx="21.5" ry="22.5" fill="${skin}"/>
      <ellipse cx="-12" cy="-58" rx="4.5" ry="2.6" fill="#ff8a80" opacity=".35"/>
      <ellipse cx="12" cy="-58" rx="4.5" ry="2.6" fill="#ff8a80" opacity=".35"/>
      ${eyes}
      <path d="M-5,-55q5,4 10,0" stroke="#8a4b3c" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      ${o.hair || ''}`;
  }

  // Туловище: пиджак/худи/форма. top — цвет одежды.
  function torso(o) {
    const top = o.top, dark = shade(top, -0.25);
    const shirt = o.shirt ? `<path d="M-7,-46L0,-30L7,-46z" fill="${o.shirt}"/>` : '';
    const tie = o.tie ? `<path d="M-2.2,-44h4.4l1.6,3-2.3,13-1.5,2-1.5-2-2.3-13z" fill="${o.tie}"/>` : '';
    return `
      <rect x="-12" y="-14" width="10" height="14" rx="3" fill="${o.pants || '#2b3040'}"/>
      <rect x="2" y="-14" width="10" height="14" rx="3" fill="${o.pants || '#2b3040'}"/>
      <ellipse cx="-7" cy="-1" rx="7" ry="3.4" fill="${o.shoes || '#15171d'}"/>
      <ellipse cx="7" cy="-1" rx="7" ry="3.4" fill="${o.shoes || '#15171d'}"/>
      <path d="M-18,-40q0-8 8-8h20q8,0 8,8v26q0,3-3,3h-30q-3,0-3-3z" fill="${top}"/>
      <path d="M-18,-40q0-8 8-8h4v37h-9q-3,0-3-3z" fill="${dark}" opacity=".35"/>
      ${shirt}${tie}
      <rect x="-25" y="-45" width="9" height="27" rx="4.5" fill="${top}" transform="rotate(8 -20 -45)"/>
      <rect x="16" y="-45" width="9" height="27" rx="4.5" fill="${top}" transform="rotate(-8 20 -45)"/>
      <circle cx="-23.5" cy="-17" r="4.6" fill="${o.skin || SKIN}"/>
      <circle cx="23.5" cy="-17" r="4.6" fill="${o.skin || SKIN}"/>`;
  }

  function wrap(inner, head, extra) {
    return `<g class="fig">
      <ellipse class="fig-shadow" cx="0" cy="1" rx="22" ry="6" fill="#000" opacity=".28"/>
      <g class="fig-body">${inner}<g class="fig-head">${head}</g>${extra || ''}</g>
    </g>`;
  }

  // ── Главный агент: дружеская шарж-фигурка (высокий лоб, светлые редкие
  //    волосы по бокам, спокойный взгляд, тёмный костюм, белая рубашка, галстук).
  function putin() {
    const skin = '#f0c7a6';
    const hair = '#cdb48c';
    const head = `
      <ellipse cx="-21" cy="-68" rx="4" ry="6" fill="#e2b393"/>
      <ellipse cx="21" cy="-68" rx="4" ry="6" fill="#e2b393"/>
      <path d="M-20,-76c0-14 9-21 20-21s20,7 20,21c0,9-2,15-5,19c-4,6-9,9-15,9s-11-3-15-9c-3-4-5-10-5-19z" fill="${skin}"/>
      <path d="M-20.5,-74c-1-8 1-13 4-16c-1,5-1,9 0,14c-1.5,1-3,2-4,2z" fill="${hair}"/>
      <path d="M20.5,-74c1-8-1-13-4-16c1,5 1,9 0,14c1.5,1 3,2 4,2z" fill="${hair}"/>
      <path d="M-12,-92.5q12,-6.5 24,0" stroke="${hair}" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".85"/>
      <path d="M-8,-95q8,-3 16,0" stroke="${hair}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".6"/>
      <ellipse cx="-3" cy="-86" rx="9" ry="4.2" fill="#fff" opacity=".22"/>
      <path d="M-14,-73.5q5,-2.2 9.5,-.6M14,-73.5q-5,-2.2 -9.5,-.6" stroke="#b39a74" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <path d="M-13,-68.2q4.5,-2.6 8.5,0" stroke="#7a5a48" stroke-width="1.1" fill="none"/>
      <path d="M13,-68.2q-4.5,-2.6 -8.5,0" stroke="#7a5a48" stroke-width="1.1" fill="none"/>
      <ellipse cx="-8.8" cy="-66.6" rx="2.3" ry="1.7" fill="#3c5266"/>
      <ellipse cx="8.8" cy="-66.6" rx="2.3" ry="1.7" fill="#3c5266"/>
      <circle cx="-8.2" cy="-67.2" r=".6" fill="#fff"/><circle cx="9.4" cy="-67.2" r=".6" fill="#fff"/>
      <path d="M-12,-63.4q3.3,1.3 6.4,0M12,-63.4q-3.3,1.3 -6.4,0" stroke="#d29f84" stroke-width="1" fill="none"/>
      <path d="M.6,-66q-2.6,7 -.4,8.6q1.6,.6 3,-.4" stroke="#c48d70" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M-5.5,-52.6q5.5,2.2 11,0" stroke="#9a5747" stroke-width="1.7" fill="none" stroke-linecap="round"/>
      <ellipse cx="-13.5" cy="-58" rx="3.4" ry="1.8" fill="#ff8a80" opacity=".22"/>
      <ellipse cx="13.5" cy="-58" rx="3.4" ry="1.8" fill="#ff8a80" opacity=".22"/>`;
    const body = `
      <rect x="-12" y="-14" width="10" height="14" rx="3" fill="#1b2029"/>
      <rect x="2" y="-14" width="10" height="14" rx="3" fill="#1b2029"/>
      <ellipse cx="-7" cy="-1" rx="7.4" ry="3.4" fill="#0b0c10"/>
      <ellipse cx="7" cy="-1" rx="7.4" ry="3.4" fill="#0b0c10"/>
      <path d="M-20,-39q0-9 9-9h22q9,0 9,9v25q0,3-3,3h-34q-3,0-3-3z" fill="#222a38"/>
      <path d="M-7.5,-48L0,-30L7.5,-48z" fill="#f7f7f2"/>
      <path d="M-2.4,-46.5h4.8l1.4,3-2.4,14-1.6,2-1.6-2-2.4-14z" fill="#8e1b2a"/>
      <path d="M-2.4,-46.5h4.8l.8,2h-6.4z" fill="#6f1420"/>
      <path d="M-11,-48L0,-28L-4,-12" stroke="#151a24" stroke-width="1.6" fill="none"/>
      <path d="M11,-48L0,-28" stroke="#151a24" stroke-width="1.6" fill="none"/>
      <path d="M-11,-48l-3,9 6,2-6,4 9,6" fill="#2b3446" stroke="#151a24" stroke-width=".8"/>
      <path d="M11,-48l3,9-6,2 6,4-9,6" fill="#2b3446" stroke="#151a24" stroke-width=".8"/>
      <circle cx="-9" cy="-37" r="1.6" fill="#c8102e"/><circle cx="-9" cy="-37" r=".7" fill="#fff"/>
      <circle cx="0" cy="-22" r="1.1" fill="#0d1017"/><circle cx="0" cy="-16" r="1.1" fill="#0d1017"/>
      <rect x="-27" y="-45" width="10" height="28" rx="5" fill="#222a38" transform="rotate(6 -22 -45)"/>
      <rect x="17" y="-45" width="10" height="28" rx="5" fill="#222a38" transform="rotate(-6 22 -45)"/>
      <rect x="-27.5" y="-20" width="8" height="3" rx="1.2" fill="#f7f7f2" transform="rotate(6 -22 -45)"/>
      <rect x="19.5" y="-20" width="8" height="3" rx="1.2" fill="#f7f7f2" transform="rotate(-6 22 -45)"/>
      <circle cx="-24.5" cy="-15.5" r="4.8" fill="${skin}"/>
      <circle cx="24.5" cy="-15.5" r="4.8" fill="${skin}"/>`;
    return wrap(body, head);
  }

  const HAIR = {
    short: (c) => `<path d="M-21,-70c-2-17 9-25 21-25s23,8 21,25c-3-7-8-12-14-13c-6,4-17,6-28,13z" fill="${c}"/>`,
    messy: (c) => `<path d="M-22,-68c-3-18 8-27 22-27s25,9 22,27l-4-8-4,4-3-8-5,5-4-8-5,6-4-7-4,7-4-5z" fill="${c}"/>`,
    bob: (c) => `<path d="M-23,-60c-4-22 8-34 23-34s27,12 23,34c-2-8-3-14-6-18c-10,2-22,1-34,0c-3,4-4,10-6,18z" fill="${c}"/>`,
    bun: (c) => `<circle cx="0" cy="-95" r="7" fill="${c}"/><path d="M-22,-64c-3-20 8-29 22-29s25,9 22,29c-3-9-8-15-22-17c-14,2-19,8-22,17z" fill="${c}"/>`,
  };

  function generic(o) {
    return wrap(torso(o), face(o), o.extra);
  }

  const KINDS = {
    putin,
    army: () => generic({
      top: '#556b2f', pants: '#3e4f22', shoes: '#1a1a12',
      hair: `<path d="M-23,-78q0-17 23-17t23,17z" fill="#4a5e2a"/><rect x="-25" y="-80" width="50" height="6" rx="3" fill="#2f3b1a"/><path d="M-20,-77q20,9 40,0l2,4q-22,8-44,0z" fill="#1d2410"/><path d="M0,-91l1.8,3.8 4.2.4-3.2,2.8 1,4.1-3.8-2.2-3.8,2.2 1-4.1-3.2-2.8 4.2-.4z" fill="#c8102e"/>`,
      extra: `<rect x="-19" y="-48" width="9" height="3" rx="1" fill="#d4a017"/><rect x="10" y="-48" width="9" height="3" rx="1" fill="#d4a017"/><rect x="-8" y="-39" width="5" height="3" fill="#c8102e"/><rect x="-8" y="-36" width="5" height="2" fill="#1f5fbf"/>
        <g transform="translate(19,-30) rotate(-8)"><rect x="0" y="0" width="15" height="19" rx="2" fill="#f5f2e8" stroke="#2f3b1a"/><rect x="3" y="11" width="2" height="5" fill="#2e7d32"/><rect x="6.5" y="7" width="2" height="9" fill="#2e7d32"/><rect x="10" y="4" width="2" height="12" fill="#c8102e"/></g>`,
    }),
    poker: () => generic({
      top: '#0f6b4a', shirt: '#f5f0e1', tie: '#111', pants: '#1c1c1c',
      hair: HAIR.short('#3a2a1e') + `<path d="M-24,-80h48l-6,8h-36z" fill="#1aa36f" opacity=".92"/><rect x="-22" y="-82" width="44" height="4" rx="2" fill="#0d5a3e"/>`,
      extra: `<g transform="translate(14,-36) rotate(14)"><rect x="0" y="0" width="12" height="17" rx="2" fill="#fff" stroke="#999" stroke-width=".6" transform="rotate(-18)"/><rect x="4" y="0" width="12" height="17" rx="2" fill="#fff" stroke="#999" stroke-width=".6"/><text x="7.5" y="10" font-size="9" fill="#c8102e" font-family="serif">♥</text><text x="9" y="15.5" font-size="6" fill="#111" font-family="sans-serif" font-weight="700">A</text></g>
        <g transform="translate(-30,-12)"><ellipse cx="0" cy="0" rx="6" ry="2.2" fill="#c8102e"/><ellipse cx="0" cy="-2.5" rx="6" ry="2.2" fill="#1f5fbf"/><ellipse cx="0" cy="-5" rx="6" ry="2.2" fill="#111"/><ellipse cx="0" cy="-5.6" rx="3" ry="1" fill="#fff" opacity=".7"/></g>`,
    }),
    trading: () => generic({
      top: '#1f4fa3', shirt: '#e8f2ff', tie: '#1f7ae0', pants: '#1b2a44',
      hair: HAIR.short('#2a1f17'),
      extra: `<g transform="translate(15,-42)"><rect x="0" y="0" width="22" height="16" rx="2" fill="#0b1626" stroke="#7fc4ff" stroke-width="1"/><path d="M3,12l4-4 4,2 5-6 3,2" stroke="#27e08f" stroke-width="1.6" fill="none"/><path d="M16,3l3,1-1,3" stroke="#27e08f" stroke-width="1.3" fill="none"/></g>`,
    }),
    devops: () => generic({
      top: '#e0662b', pants: '#2b3040',
      hair: HAIR.short('#5a3b22') + `<path d="M-23,-76q0-21 23-21t23,21z" fill="#ffc21a"/><rect x="-26" y="-78" width="52" height="5" rx="2.5" fill="#e6a700"/><rect x="-3" y="-97" width="6" height="19" rx="2" fill="#ffd34d"/>`,
      extra: `<rect x="-18" y="-35" width="36" height="4" fill="#ffd34d" opacity=".9"/><g transform="translate(24,-28) rotate(30)"><rect x="-2" y="0" width="4" height="18" rx="1.5" fill="#9aa4b2"/><path d="M-6,-2a6,6 0 1 1 12,0h-3v3h-6v-3z" fill="#9aa4b2"/></g>`,
    }),
    qa: () => generic({
      top: '#0369a1', shirt: '#e0f2fe', pants: '#0c4a6e', glasses: true,
      hair: HAIR.short('#2c241c'),
      extra: `<g transform="translate(14,-38) rotate(8)"><rect x="0" y="0" width="16" height="20" rx="2" fill="#f8fafc" stroke="#0284c7" stroke-width="1"/><path d="M3,7.5 l2.4,2.4 5,-5.2" fill="none" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round"/><path d="M3,13h10M3,16.2h7" stroke="#94a3b8" stroke-width="1"/></g>`,
    }),
    dev: () => generic({
      top: '#6a3fe0', pants: '#22253a',
      hair: HAIR.messy('#2c2119') + `<path d="M-25,-70a25,25 0 0 1 50,0" stroke="#1a1a2e" stroke-width="3.5" fill="none"/><rect x="-28" y="-74" width="7" height="12" rx="3" fill="#1a1a2e"/><rect x="21" y="-74" width="7" height="12" rx="3" fill="#7c4dff"/>`,
      extra: `<path d="M-10,-48q10,8 20,0" stroke="#e3d8ff" stroke-width="2" fill="none"/><g transform="translate(-17,-32)"><rect x="0" y="0" width="34" height="20" rx="2" fill="#2a2d3e" stroke="#9f86ff" stroke-width="1"/><rect class="screen" x="3" y="3" width="28" height="14" rx="1" fill="#18122e"/><text x="17" y="13.5" text-anchor="middle" font-size="8" fill="#b9a5ff" font-family="monospace" font-weight="700">&lt;/&gt;</text></g>`,
    }),
    temshik: () => generic({
      top: '#2b2b2b', pants: '#3a3a3a', shades: true,
      hair: `<path d="M-22,-74q0-20 22-20t22,20z" fill="#d4a017"/><path d="M-22,-74h-9q0-4 9-5z" fill="#b8860b"/><rect x="-22" y="-77" width="44" height="4" rx="2" fill="#b8860b"/>`,
      extra: `<path d="M-10,-47q10,14 20,0" stroke="#f5c451" stroke-width="2.4" fill="none" stroke-dasharray="2 1.5"/><circle cx="0" cy="-39" r="3.2" fill="#f5c451"/><g transform="translate(26,-40)"><circle r="7" fill="#ffe066" opacity=".95"/><rect x="-3" y="6" width="6" height="4" rx="1" fill="#999"/><path d="M-2,-1l2,-3 2,3-2,3z" fill="#fff"/></g>`,
    }),
    finance: () => generic({
      top: '#1a3a5c', shirt: '#f7f3e8', tie: '#c6a15a', pants: '#14283c',
      hair: HAIR.short('#3a2e24'),
      extra: `<g transform="translate(16,-28)"><rect x="0" y="2" width="16" height="12" rx="1.5" fill="#5b3a1e"/><rect x="5" y="-1" width="6" height="4" fill="none" stroke="#5b3a1e" stroke-width="1.5"/><text x="8" y="12" text-anchor="middle" font-size="8" fill="#f5c451" font-weight="800">₽</text></g>`,
    }),
    invest: () => generic({
      top: '#8a6a1f', shirt: '#fff6d8', tie: '#1a3a5c', pants: '#2a2416',
      hair: HAIR.short('#2a2118'),
      extra: `<g transform="translate(14,-40)"><rect x="0" y="0" width="22" height="15" rx="2" fill="#1a1408" stroke="#f5c451" stroke-width="1"/><path d="M3,11l4-5 4,3 6-6" stroke="#f5c451" stroke-width="1.6" fill="none"/><path d="M14,3h3v3" stroke="#f5c451" stroke-width="1.4" fill="none"/></g>`,
    }),
    analyst: () => generic({
      top: '#2f6b4f', shirt: '#f3faf4', pants: '#1c3326', glasses: true,
      hair: HAIR.bob('#4a3428'),
      extra: `<g transform="translate(-28,-34) rotate(-8)"><rect x="0" y="0" width="16" height="20" rx="1.5" fill="#f7fbf6" stroke="#1a3a5c"/><rect x="3" y="12" width="2" height="5" fill="#1a3a5c"/><rect x="7" y="8" width="2" height="9" fill="#c6a15a"/><rect x="11" y="5" width="2" height="12" fill="#2f6b4f"/></g>`,
    }),
    blog: () => generic({
      top: '#e83e8c', pants: '#2b2140',
      hair: HAIR.bob('#4a2b1d'),
      extra: `<path d="M-20,-62q-6,8 4,13" stroke="#222" stroke-width="1.6" fill="none"/><circle cx="-14" cy="-50" r="2.4" fill="#222"/>
        <g transform="translate(14,-40)"><rect x="0" y="2" width="20" height="14" rx="3" fill="#1d1f27"/><circle cx="10" cy="9" r="5" fill="#3b4256" stroke="#9aa" stroke-width="1"/><circle cx="10" cy="9" r="2.2" fill="#7dd3fc"/><rect x="4" y="-1" width="7" height="4" rx="1" fill="#1d1f27"/><circle class="rec" cx="17" cy="5" r="1.6" fill="#ff3b3b"/></g>`,
    }),
    lang: () => generic({
      top: '#f59e0b', pants: '#3a2f22', glasses: true,
      hair: HAIR.bun('#6b3e26'),
      extra: `<g transform="translate(-30,-36) rotate(-10)"><rect x="0" y="0" width="16" height="20" rx="1.5" fill="#1d4ed8"/><rect x="2" y="2" width="12" height="16" fill="#fff" opacity=".2"/><text x="8" y="14" text-anchor="middle" font-size="9" fill="#fff" font-family="sans-serif" font-weight="800">En</text></g>`,
    }),
    biz: () => generic({
      top: '#0f766e', shirt: '#ecfeff', tie: '#f59e0b', pants: '#123c3a',
      hair: HAIR.short('#1f1a17'),
      extra: `<g transform="translate(18,-22)"><rect x="0" y="0" width="18" height="13" rx="2" fill="#5b3a1e"/><rect x="6" y="-3" width="6" height="4" rx="1" fill="none" stroke="#5b3a1e" stroke-width="1.6"/><rect x="0" y="5" width="18" height="1.6" fill="#3d2712"/></g>`,
    }),
    social: () => generic({
      top: '#a21caf', pants: '#3b0764',
      hair: HAIR.bob('#3a241c'),
      extra: `<g transform="translate(14,-36) rotate(8)"><rect x="0" y="0" width="12" height="18" rx="2" fill="#1c1224" stroke="#f0abfc" stroke-width="1"/><rect x="1.6" y="2.2" width="8.8" height="11.5" rx="1" fill="#4a044e"/><path d="M4.1,7.4c0,-1.5 1.2,-2.1 1.8,-1 .6,-1.1 1.8,-.5 1.8,1.1 0,1.5-1.8,2.8-1.8,2.8s-1.8,-1.3-1.8,-2.9z" fill="#fb7185"/></g>`,
    }),
    routines: () => generic({
      top: '#9a3412', shirt: '#fff7ed', tie: '#f5c451', pants: '#3f1d0d',
      hair: HAIR.short('#2a2118'),
      extra: `<g transform="translate(-28,-36) rotate(-8)"><rect x="0" y="0" width="14" height="18" rx="1.5" fill="#fff7ed" stroke="#7c2d12"/><path d="M3,5h8M3,8.5h8M3,12h5" stroke="#c2410c" stroke-width="1.1"/></g><g transform="translate(20,-24)" fill="none" stroke="#f5c451" stroke-width="1.4"><circle r="5.5"/><path d="M0,-7.4v2.2M0,5.2v2.2M-7.4,0h2.2M5.2,0h2.2"/></g>`,
    }),
    vacant: () => `<g class="fig vacant">
      <ellipse cx="0" cy="1" rx="22" ry="6" fill="#000" opacity=".22"/>
      <g class="fig-body" opacity=".9">
        <path d="M-18,-40q0-8 8-8h20q8,0 8,8v26q0,3-3,3h-30q-3,0-3-3z" fill="none" stroke="#cbd2dc" stroke-width="2" stroke-dasharray="4 3"/>
        <rect x="-12" y="-12" width="10" height="11" rx="3" fill="none" stroke="#cbd2dc" stroke-width="2" stroke-dasharray="3 3"/>
        <rect x="2" y="-12" width="10" height="11" rx="3" fill="none" stroke="#cbd2dc" stroke-width="2" stroke-dasharray="3 3"/>
        <circle cx="0" cy="-68" r="21" fill="#ffffff10" stroke="#cbd2dc" stroke-width="2" stroke-dasharray="4 3"/>
        <text x="0" y="-59" text-anchor="middle" font-size="26" font-weight="800" fill="#e5e7eb" font-family="Unbounded, sans-serif">?</text>
      </g></g>`,
  };

  function generic2(color) {
    return generic({ top: color || '#64748b', hair: HAIR.short('#3a2a1e') });
  }

  window.Figures = {
    shade,
    render(kind, color) {
      const f = KINDS[kind];
      return f ? f() : generic2(color);
    },
  };
})();
