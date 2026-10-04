// Today's real weather from the US National Weather Service (free, no key).
// The tree only ever says things that follow from the actual reading.

export function weatherLine(w) {
  if (!w) return null;
  const t = Math.round(w.tempF);
  const sky = (w.summary || '').toLowerCase();
  if (/thunder/.test(sky)) return `Storms around, ${t}°F. Admire me from indoors today.`;
  if (/rain|shower|drizzle/.test(sky)) return `${t}°F and wet. My roots are very happy about this rain.`;
  if (/snow|flurr/.test(sky)) return `${t}°F with snow. I'm resting until spring.`;
  if (t >= 85) return `It's ${t}°F right now. Come stand in my shade for a minute.`;
  if (t <= 40) return `Brr, ${t}°F. Good thing I brought my bark.`;
  return `${t}°F and ${sky || 'calm'}. A good day to be a tree.`;
}

export function createWeather({ lat, lng, fetchImpl = fetch, ttlMs = 30 * 60 * 1000 } = {}) {
  let cache = null;
  let hourlyUrl = null;
  return async function current() {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    const headers = { 'User-Agent': 'tree-detective (campus tree game)', Accept: 'application/geo+json' };
    try {
      if (!hourlyUrl) {
        const p = await fetchImpl(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers });
        if (!p.ok) throw new Error(`points ${p.status}`);
        hourlyUrl = (await p.json()).properties.forecastHourly;
      }
      const f = await fetchImpl(hourlyUrl, { headers });
      if (!f.ok) throw new Error(`forecast ${f.status}`);
      const now = (await f.json()).properties.periods[0];
      const tempF = now.temperatureUnit === 'C' ? now.temperature * 9 / 5 + 32 : now.temperature;
      const value = { tempF, summary: now.shortForecast, at: now.startTime };
      cache = { at: Date.now(), value };
      return value;
    } catch (e) {
      console.warn('weather unavailable:', e.message);
      cache = { at: Date.now() - ttlMs + 5 * 60 * 1000, value: null }; // retry in 5 min
      return null;
    }
  };
}
