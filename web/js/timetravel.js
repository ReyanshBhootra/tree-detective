// "Time travel" slider: fades the real 1930s aerial survey of New Jersey
// over today's map. Layer comes from the state's WMS (see /api/config).
export function initTimeTravel(map, historic, toast) {
  const box = document.getElementById('timetravel');
  if (!historic || !box) return;
  box.hidden = false;
  document.getElementById('tt-year').textContent = historic.year;
  const slider = document.getElementById('tt-range');
  let layer = null;
  let failures = 0;

  slider.addEventListener('input', () => {
    const t = Number(slider.value) / 100;
    if (!layer && t > 0) {
      layer = L.tileLayer.wms(historic.wmsUrl, {
        layers: historic.layer,
        format: 'image/jpeg',
        transparent: false,
        version: '1.1.1',
        maxZoom: 20,
        attribution: historic.attribution,
        className: 'historic-tiles',
      }).addTo(map);
      layer.on('tileerror', () => {
        if (++failures === 3) toast(`The ${historic.year} photos aren't loading right now.`);
      });
    }
    layer?.setOpacity(t);
    box.classList.toggle('past', t > 0.5);
  });
}
