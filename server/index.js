import { loadEnv } from './config.js';

loadEnv();
const { createApp } = await import('./app.js');

const port = Number(process.env.PORT || 3000);
// The iMessage bot runs in this same window when Photon keys are set (PHOTON=off to skip).
const withPhoton = Boolean(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET) && process.env.PHOTON !== 'off';
if (withPhoton) process.env.PHOTON_IN_APP = '1';

createApp().listen(port, () => {
  console.log(`Tree Detective is awake on http://localhost:${port}`);
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) console.log('  storage: local JSON in .data/ (set AZURE_STORAGE_CONNECTION_STRING for Azure)');
  if (!withPhoton) return;
  import('../photon/index.js')
    .then((m) => m.startPhoton())
    .catch((e) => console.error('iMessage bot stopped (the website keeps running):', e.message));
});
