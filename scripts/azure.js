// Thin REST wrappers for the Azure services the content scripts use.
// These run ahead of time on a laptop, never during the live demo.

function need(env, ...keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} in .env`);
}

function openaiUrl(env, deployment, op) {
  const base = env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/${op}?api-version=${env.AZURE_OPENAI_API_VERSION || '2024-10-21'}`;
}

export async function chat(env, messages, { temperature = 0.7, maxTokens = 600 } = {}) {
  need(env, 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_CHAT_DEPLOYMENT');
  const res = await fetch(openaiUrl(env, env.AZURE_OPENAI_CHAT_DEPLOYMENT, 'chat/completions'), {
    method: 'POST',
    headers: { 'api-key': env.AZURE_OPENAI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`Azure OpenAI chat ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content.trim();
}

export async function image(env, prompt, { size = '1024x1024' } = {}) {
  need(env, 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_IMAGE_DEPLOYMENT');
  const res = await fetch(openaiUrl(env, env.AZURE_OPENAI_IMAGE_DEPLOYMENT, 'images/generations'), {
    method: 'POST',
    headers: { 'api-key': env.AZURE_OPENAI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, n: 1, size }),
  });
  if (!res.ok) throw new Error(`Azure OpenAI image ${res.status}: ${await res.text()}`);
  const item = (await res.json()).data[0];
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  const img = await fetch(item.url);
  if (!img.ok) throw new Error(`downloading generated image failed: ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function ssml(text, persona) {
  const lang = persona.voice.split('-').slice(0, 2).join('-');
  const { rate = '0%', pitch = '0%' } = persona.prosody ?? {};
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${persona.voice}"><prosody rate="${rate}" pitch="${pitch}">${xml(text)}</prosody></voice></speak>`;
}

export async function speak(env, text, persona) {
  need(env, 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION');
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'tree-detective',
    },
    body: ssml(text, persona),
  });
  if (!res.ok) throw new Error(`Azure Speech ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
