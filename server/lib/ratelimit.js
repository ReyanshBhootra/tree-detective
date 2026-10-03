// Tiny in-memory sliding window. Good enough for one App Service instance.
export function rateLimiter(limit, windowMs = 3600_000) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
