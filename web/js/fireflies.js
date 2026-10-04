// Soft drifting fireflies and a few falling leaves over the map. Purely decorative.
const LEAF_COLORS = ['#e8a33d', '#d9663b', '#c9b13f', '#8fc46a', '#b8562f'];

export function startFireflies(canvas, count = 28, leafCount = 7) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1;
  const flies = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < count; i++) {
    flies.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      phase: Math.random() * Math.PI * 2, speed: 0.008 + Math.random() * 0.02,
      r: 1.2 + Math.random() * 1.8,
    });
  }

  const newLeaf = (anywhere) => ({
    x: Math.random() * w, y: anywhere ? Math.random() * h : -20,
    vy: 0.25 + Math.random() * 0.35, sway: 0.6 + Math.random() * 1.2,
    phase: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.03, rot: Math.random() * Math.PI * 2,
    size: 5 + Math.random() * 4, color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)],
  });
  const leaves = Array.from({ length: leafCount }, () => newLeaf(true));

  function drawLeaf(l) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.rot);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = l.color;
    ctx.beginPath();
    ctx.moveTo(0, -l.size);
    ctx.quadraticCurveTo(l.size * 0.9, 0, 0, l.size);
    ctx.quadraticCurveTo(-l.size * 0.9, 0, 0, -l.size);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60, 35, 10, 0.5)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(0, -l.size * 0.8); ctx.lineTo(0, l.size * 1.3); ctx.stroke();
    ctx.restore();
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const [i, l] of leaves.entries()) {
      l.phase += 0.02;
      l.y += l.vy;
      l.x += Math.sin(l.phase) * l.sway * 0.5;
      l.rot += l.spin + Math.cos(l.phase) * 0.01;
      if (l.y > h + 20) leaves[i] = newLeaf(false);
      drawLeaf(l);
    }
    for (const f of flies) {
      f.phase += f.speed;
      f.vx += (Math.random() - 0.5) * 0.02; f.vy += (Math.random() - 0.5) * 0.02;
      f.vx *= 0.98; f.vy *= 0.98;
      f.x = (f.x + f.vx + w) % w; f.y = (f.y + f.vy + h) % h;
      const a = 0.25 + 0.75 * Math.max(0, Math.sin(f.phase));
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 6);
      g.addColorStop(0, `rgba(255, 236, 140, ${a})`);
      g.addColorStop(0.3, `rgba(220, 255, 120, ${a * 0.35})`);
      g.addColorStop(1, 'rgba(220, 255, 120, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 6, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  frame();
}
