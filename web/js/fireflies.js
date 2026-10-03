// Soft drifting fireflies over the map. Purely decorative.
export function startFireflies(canvas, count = 28) {
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

  function frame() {
    ctx.clearRect(0, 0, w, h);
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
