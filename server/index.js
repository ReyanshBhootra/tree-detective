import { loadEnv } from './config.js';

loadEnv();
const { createApp } = await import('./app.js');

const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => {
  console.log(`Tree Detective is awake on http://localhost:${port}`);
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) console.log('  storage: local JSON in .data/ (set AZURE_STORAGE_CONNECTION_STRING for Azure)');
});
