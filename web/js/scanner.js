// Camera QR scanning. Uses the built-in BarcodeDetector where the browser has it,
// otherwise loads jsQR from a CDN. The phone's own camera app also works because
// every tag encodes a normal website link.

let jsQRPromise;
function loadJsQR() {
  jsQRPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => reject(new Error('could not load the QR reader'));
    document.head.appendChild(s);
  });
  return jsQRPromise;
}

// Pulls {code, key} out of whatever the QR or the typed box holds:
// a full link (?tree=TD-001&k=7K3QXZ), a typed "TD-001-7K3QXZ", or a bare code.
export function parseTag(value) {
  const raw = String(value ?? '').trim();
  try {
    const url = new URL(raw);
    const code = url.searchParams.get('tree');
    if (code) return { code: code.toUpperCase(), key: (url.searchParams.get('k') ?? '').toUpperCase() };
  } catch { /* not a URL */ }
  const clean = raw.toUpperCase().replace(/\s+/g, '-');
  const signed = clean.match(/^([A-Z0-9-]{3,20})-([A-HJ-NP-Z2-9]{6})$/);
  if (signed) return { code: signed[1], key: signed[2] };
  return /^[A-Z0-9-]{3,20}$/.test(clean) ? { code: clean, key: '' } : null;
}

export async function startScanner(video, onCode, onStatus) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    onStatus('Camera unavailable. Type the code below instead.');
    return () => {};
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  onStatus('Looking for a QR code…');

  let stopped = false;
  let detect;
  if ('BarcodeDetector' in window) {
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => (await detector.detect(video))[0]?.rawValue;
  } else {
    const jsQR = await loadJsQR().catch(() => null);
    if (!jsQR) {
      onStatus('QR reader failed to load. Type the code below instead.');
    } else {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        if (!video.videoWidth) return null;
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
      };
    }
  }

  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  (async function loop() {
    while (!stopped && detect) {
      try {
        const value = await detect();
        const tag = parseTag(value);
        if (tag) { stop(); onCode(tag); return; }
        if (value) onStatus("That QR code isn't a Tree Detective tag.");
      } catch { /* keep trying */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  return stop;
}
