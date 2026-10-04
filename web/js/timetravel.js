// "Time travel" slider: slide from the 1930s aerial survey through later aerial
// and satellite photos up to today's storybook map. Stops come from /api/timeline
// (NJ Office of GIS surveys + Esri World Imagery Wayback), shown in true color.
export async function initTimeTravel(map, historic, toast, api) {
  const box = document.getElementById('timetravel');
  if (!box) return;
  let stops = [];
  try {
    stops = (await api('/api/timeline')).stops ?? [];
  } catch {
    // fall back to the 1930 photo alone
  }
  if (!stops.length && historic) {
    stops = [{ year: historic.year, kind: 'wms', url: historic.wmsUrl, layer: historic.layer, label: String(historic.year), attribution: historic.attribution }];
  }
  if (!stops.length) return;

  // Photos get their own pane above the storybook-tinted map, so they keep real colors.
  map.createPane('timeline');
  map.getPane('timeline').style.zIndex = 250;

  const slider = document.getElementById('tt-range');
  const yearLabel = document.getElementById('tt-year');
  document.getElementById('tt-start').textContent = stops[0].year;
  const last = stops.length; // the extra last stop is today's map
  slider.min = 0;
  slider.max = last;
  slider.step = 0.01;
  slider.value = last;
  box.hidden = false;

  const layers = new Map();
  const failed = new Set();
  function layerFor(i) {
    if (layers.has(i)) return layers.get(i);
    const s = stops[i];
    const opts = { pane: 'timeline', opacity: 0, maxZoom: 20, attribution: s.attribution, zIndex: i + 1 };
    const layer = s.kind === 'wms'
      ? L.tileLayer.wms(s.url, { ...opts, layers: s.layer, format: 'image/jpeg', transparent: false, version: '1.1.1' })
      : L.tileLayer(s.url, { ...opts, maxNativeZoom: 19 });
    let errors = 0;
    layer.on('tileerror', () => {
      if (++errors === 4 && !failed.has(i)) {
        failed.add(i);
        toast(`The ${s.label} photos aren't loading right now.`);
      }
    });
    layer.addTo(map);
    layers.set(i, layer);
    return layer;
  }

  function show(p) {
    const i = Math.floor(p);
    const frac = p - i;
    // Load this stop and the next so the fade is ready.
    for (const j of [i, i + 1]) if (j < stops.length) layerFor(j);
    layers.forEach((layer, j) => {
      let o = 0;
      if (j === i) o = i + 1 >= last ? 1 - frac : 1; // fading into today's map
      else if (j === i + 1) o = frac;
      layer.setOpacity(o);
    });
    const near = Math.round(p);
    yearLabel.textContent = near >= last ? 'Today' : stops[near].label;
    box.classList.toggle('past', p < last - 0.5);
  }

  slider.addEventListener('input', () => show(Number(slider.value)));
  // Let go and it settles on the nearest year.
  slider.addEventListener('change', () => {
    slider.value = Math.round(Number(slider.value));
    show(Number(slider.value));
  });
  yearLabel.textContent = 'Today';
}
