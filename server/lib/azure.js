// Thin REST wrappers for the Azure services the content scripts use.
// Stories, images and narration are made ahead of time. "Ask the tree" uses chat live.

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

// Re-draws a real photo of the spot as another era, keeping the camera angle,
// so "then" and "now" line up. Needs an image model that supports edits (gpt-image-1).
export async function imageFromPhoto(env, prompt, photo, { size = '1024x1024' } = {}) {
  need(env, 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_IMAGE_DEPLOYMENT');
  const base = env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
  const version = env.AZURE_OPENAI_IMAGE_EDIT_API_VERSION || '2025-04-01-preview';
  const form = new FormData();
  form.append('image', new Blob([photo.buffer], { type: photo.type }), photo.name);
  form.append('prompt', prompt);
  form.append('size', size);
  const res = await fetch(`${base}/openai/deployments/${encodeURIComponent(env.AZURE_OPENAI_IMAGE_DEPLOYMENT)}/images/edits?api-version=${version}`, {
    method: 'POST', headers: { 'api-key': env.AZURE_OPENAI_KEY }, body: form,
  });
  if (!res.ok) throw new Error(`Azure OpenAI image edit ${res.status}: ${await res.text()}`);
  return Buffer.from((await res.json()).data[0].b64_json, 'base64');
}

export async function embed(env, input) {
  need(env, 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
  const res = await fetch(openaiUrl(env, env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT, 'embeddings'), {
    method: 'POST',
    headers: { 'api-key': env.AZURE_OPENAI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`Azure OpenAI embeddings ${res.status}: ${await res.text()}`);
  const data = (await res.json()).data;
  return Array.isArray(input) ? data.map((d) => d.embedding) : data[0].embedding;
}

// Azure AI Translator. Haitian Creole is "ht", Simplified Chinese is "zh-Hans".
// `to` uses our codes; `codeMap` maps any that Translator spells differently.
export async function translate(env, text, to, codeMap = {}) {
  need(env, 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION');
  const res = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en${to.map((t) => `&to=${codeMap[t] ?? t}`).join('')}`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_TRANSLATOR_KEY,
      'Ocp-Apim-Subscription-Region': env.AZURE_TRANSLATOR_REGION,
      'content-type': 'application/json',
    },
    body: JSON.stringify([{ text }]),
  });
  if (!res.ok) throw new Error(`Azure Translator ${res.status}: ${await res.text()}`);
  const back = Object.fromEntries(to.map((t) => [(codeMap[t] ?? t).toLowerCase(), t]));
  return Object.fromEntries((await res.json())[0].translations.map((t) => [back[t.to.toLowerCase()] ?? t.to, t.text]));
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function ssml(text, persona, voice = persona.voice) {
  const lang = voice.split('-').slice(0, 2).join('-');
  const { rate = '0%', pitch = '0%' } = persona.prosody ?? {};
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}">${xml(text)}</prosody></voice></speak>`;
}

export async function speak(env, text, persona, voice = persona.voice) {
  need(env, 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION');
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'tree-detective',
    },
    body: ssml(text, persona, voice),
  });
  if (!res.ok) throw new Error(`Azure Speech ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
