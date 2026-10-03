// Storybook placeholder scenes for a tree's life, drawn in SVG.
// Used until the real generated images exist (tree.timelapse[i].imageUrl).
// Like the real ones, these are impressions, never historical photos.

function rng(seed) {
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function eraScene({ era, index, total, code, glow = '#ffe08a' }) {
  const rand = rng(`${code}:${index}`);
  const growth = era === 'before' ? 0 : Math.max(0.08, total > 1 ? index / (total - 1) : 1);
  // Older eras get an older, warmer, sepia palette.
  const age = total > 1 ? 1 - index / (total - 1) : 0;
  const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * age));
  const rgb = (c) => `rgb(${c.join(',')})`;
  const skyTop = rgb(mix([118, 178, 220], [214, 180, 128]));
  const skyBot = rgb(mix([214, 236, 230], [238, 214, 168]));
  const hill = rgb(mix([96, 160, 104], [150, 140, 90]));
  const ground = rgb(mix([76, 140, 84], [130, 118, 72]));
  const leaf = rgb(mix([72, 160, 92], [120, 130, 70]));
  const leafLight = rgb(mix([126, 206, 140], [176, 180, 110]));

  const cx = 200, base = 250;
  const trunkH = 18 + 120 * growth;
  const trunkW = 4 + 18 * growth;
  const canopyR = 10 + 70 * growth;
  const top = base - trunkH;

  const clouds = Array.from({ length: 3 }, () => {
    const x = 30 + rand() * 340, y = 30 + rand() * 50, s = 0.6 + rand() * 0.7;
    return `<g opacity="0.85" transform="translate(${x} ${y}) scale(${s})"><ellipse rx="34" ry="12" fill="#fff"/><ellipse cx="-16" cy="-8" rx="16" ry="12" fill="#fff"/><ellipse cx="12" cy="-10" rx="20" ry="14" fill="#fff"/></g>`;
  }).join('');

  const grass = Array.from({ length: 26 }, () => {
    const x = rand() * 400, y = 258 + rand() * 40, h = 5 + rand() * 7;
    return `<path d="M${x} ${y} q2 -${h} 4 -${h * 1.2} M${x + 3} ${y} q1 -${h} -2 -${h}" stroke="${leafLight}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.7"/>`;
  }).join('');

  let tree = '';
  if (era !== 'before') {
    const blobs = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 + rand();
      const r = canopyR * (0.55 + rand() * 0.25);
      return `<circle cx="${cx + Math.cos(a) * canopyR * 0.55}" cy="${top - canopyR * 0.35 + Math.sin(a) * canopyR * 0.4}" r="${r}" fill="${i % 2 ? leaf : leafLight}"/>`;
    }).join('');
    const stake = growth < 0.2
      ? `<line x1="${cx + 10}" y1="${base}" x2="${cx + 10}" y2="${base - trunkH - 8}" stroke="#8a6a40" stroke-width="3"/><line x1="${cx}" y1="${base - trunkH * 0.6}" x2="${cx + 10}" y2="${base - trunkH * 0.6}" stroke="#c9b48a" stroke-width="2"/>`
      : '';
    tree = `
      <ellipse cx="${cx}" cy="${base + 4}" rx="${canopyR * 0.9 + 10}" ry="${6 + growth * 6}" fill="rgba(0,0,0,0.18)"/>
      ${stake}
      <path d="M${cx - trunkW / 2} ${base} Q${cx - trunkW / 3} ${top + trunkH / 2} ${cx - trunkW / 4} ${top} L${cx + trunkW / 4} ${top} Q${cx + trunkW / 3} ${top + trunkH / 2} ${cx + trunkW / 2} ${base} Z" fill="#7a5132"/>
      <circle cx="${cx}" cy="${top - canopyR * 0.4}" r="${canopyR}" fill="${leaf}"/>
      ${blobs}
      ${era === 'today' ? `<circle cx="${cx}" cy="${top - canopyR * 0.4}" r="${canopyR + 12}" fill="none" stroke="${glow}" stroke-width="3" opacity="0.5"/>` : ''}`;
  } else {
    tree = `<path d="M${cx - 8} ${base} q8 -14 16 0" fill="${leafLight}"/><circle cx="${cx}" cy="${base - 3}" r="2.5" fill="#7a5132"/>`;
  }

  const town = era === 'today' || era === 'midlife'
    ? Array.from({ length: 7 }, (_, i) => {
        const x = i * 60 + rand() * 20, h = 30 + rand() * (era === 'today' ? 70 : 35);
        return `<rect x="${x}" y="${200 - h}" width="${40 + rand() * 20}" height="${h + 20}" fill="rgba(80,70,90,${era === 'today' ? 0.35 : 0.22})" rx="2"/>`;
      }).join('')
    : '';

  return `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Storybook impression: ${era}">
    <defs><linearGradient id="sky-${code}-${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBot}"/></linearGradient></defs>
    <rect width="400" height="300" fill="url(#sky-${code}-${index})"/>
    ${clouds}
    ${town}
    <path d="M0 215 Q90 175 180 205 T400 195 V300 H0Z" fill="${hill}"/>
    <path d="M0 250 Q120 236 240 248 T400 244 V300 H0Z" fill="${ground}"/>
    ${grass}
    ${tree}
    <rect width="400" height="300" fill="rgba(120,90,40,${(age * 0.18).toFixed(2)})"/>
  </svg>`;
}
