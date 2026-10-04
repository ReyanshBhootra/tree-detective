// Google Gemini API (aistudio.google.com). Used for writing, fact search and
// images when Azure OpenAI isn't available.
import { EMBEDDING_DIMS } from './tiger.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Google retires and renames Gemini models often, so instead of hard-coding
// names we ask the API which models this key can use and pick the newest
// fitting one. GEMINI_*_MODEL in .env overrides the pick.
const version = (name) => (name.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0').split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [version(a), version(b)];
  return (x[0] - y[0]) || ((x[1] ?? 0) - (y[1] ?? 0));
};
const stable = (n) => !/preview|exp|latest/.test(n);

export function pickModels(list) {
  const gen = list.filter((m) => m.methods.includes('generateContent')).map((m) => m.name);
  const byBest = (names) => [...names].sort((a, b) => (stable(b) - stable(a)) || newer(b, a));
  const chat = byBest(gen.filter((n) => /^gemini-[\d.]+-flash$/.test(n)))[0]
    ?? byBest(gen.filter((n) => /^gemini-[\d.]+-flash(-lite)?(-preview[\w-]*)?$/.test(n)))[0]
    ?? byBest(gen.filter((n) => /^gemini-.*flash/.test(n) && !/image|tts|audio|live|embedding/.test(n)))[0];
  const image = byBest(gen.filter((n) => /^gemini-[\d.]+-flash(-lite)?-image/.test(n)))[0]
    ?? byBest(gen.filter((n) => /^gemini-.*-image/.test(n)))[0];
  const embedNames = list.filter((m) => m.methods.includes('embedContent')).map((m) => m.name);
  // gemini-embedding-001 is known to support 1536-number embeddings; prefer it while it's offered.
  const embed = embedNames.find((n) => n === 'gemini-embedding-001')
    ?? [...embedNames.filter((n) => /^gemini-embedding/.test(n))].sort().reverse()[0];
  return { chat, image, embed };
}

const cache = new Map();
export async function geminiModels(env, fetchImpl = fetch) {
  const key = env.GEMINI_API_KEY;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const res = await fetchImpl(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
      if (!res.ok) throw new Error(`Gemini model list ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const list = ((await res.json()).models ?? []).map((m) => ({
        name: m.name.replace(/^models\//, ''), methods: m.supportedGenerationMethods ?? [],
      }));
      return pickModels(list);
    })().catch((e) => {
      cache.delete(key);
      throw e;
    }));
  }
  const picked = await cache.get(key);
  const out = {
    chat: env.GEMINI_CHAT_MODEL || picked.chat,
    image: env.GEMINI_IMAGE_MODEL || picked.image,
    embed: env.GEMINI_EMBEDDING_MODEL || picked.embed,
  };
  return out;
}

async function model(env, job, fetchImpl) {
  const name = (await geminiModels(env, fetchImpl))[job];
  if (!name) throw new Error(`Your Gemini key has no model for ${job}`);
  return name;
}

// Gemini 2.5 can switch thinking off; newer models think by default, so they
// just get more room for it instead.
const thinking = (name, maxTokens) => (/gemini-2\.5/.test(name)
  ? { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } }
  : { maxOutputTokens: Math.max(maxTokens * 4, 2048) });

async function call(env, model, method, body, fetchImpl) {
  const res = await fetchImpl(`${BASE}/models/${encodeURIComponent(model)}:${method}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Takes OpenAI-style messages ({role: system|user|assistant, content}).
export async function geminiChat(env, messages, { temperature = 0.7, maxTokens = 600 } = {}, fetchImpl = fetch) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const name = await model(env, 'chat', fetchImpl);
  const json = await call(env, name, 'generateContent', {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: { temperature, ...thinking(name, maxTokens) },
  }, fetchImpl);
  const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) throw new Error(`Gemini returned no text (${json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? 'unknown'})`);
  return text;
}

// Gemini embeddings cut to 1536 numbers so they fit the same TigerData column
// as Azure's text-embedding-3-small. Shortened vectors must be re-normalized.
const normalize = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

export async function geminiEmbed(env, input, fetchImpl = fetch) {
  const embedModel = await model(env, 'embed', fetchImpl);
  const texts = Array.isArray(input) ? input : [input];
  const json = await call(env, embedModel, 'batchEmbedContents', {
    requests: texts.map((text) => ({
      model: `models/${embedModel}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMS,
    })),
  }, fetchImpl);
  const vectors = json.embeddings.map((e) => normalize(e.values));
  return Array.isArray(input) ? vectors : vectors[0];
}

// Draws an image from a prompt, or redraws a real photo when one is given.
export async function geminiImage(env, prompt, photo = null, fetchImpl = fetch) {
  const parts = [{ text: prompt }];
  if (photo) parts.push({ inlineData: { mimeType: photo.type, data: photo.buffer.toString('base64') } });
  const json = await call(env, await model(env, 'image', fetchImpl), 'generateContent', {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }, fetchImpl);
  const img = (json.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData || p.inline_data);
  if (!img) throw new Error(`Gemini returned no image (${json.candidates?.[0]?.finishReason ?? 'unknown'})`);
  return Buffer.from((img.inlineData ?? img.inline_data).data, 'base64');
}

// Looks at a tree photo and says whether it shows a problem. No training
// needed: Gemini already knows what spotted lanternflies, broken limbs and
// dead trees look like. Anything uncertain comes back "unclear" (no flag).
export const HEALTH_LABELS = ['healthy', 'pest', 'damage', 'dying', 'unclear'];

export async function geminiHealth(env, buffer, mime, fetchImpl = fetch) {
  const name = await model(env, 'chat', fetchImpl);
  const json = await call(env, name, 'generateContent', {
    contents: [{
      role: 'user',
      parts: [
        {
          text:
            'You check photos of campus trees for a tree-care team. Pick one label:\n' +
            '- pest: insects or signs of them clearly on the tree (spotted lanternfly adults, red-and-black nymphs, grey mud-like egg masses, webs, bore holes)\n' +
            '- damage: broken, split or hanging limbs, trunk wounds, missing bark from injury\n' +
            '- dying: mostly dead or bare canopy in growing season, large dead sections, fungus conks at the base\n' +
            '- healthy: the tree is clearly visible and none of the above\n' +
            '- unclear: no tree visible, too blurry, too far away, or you are not sure\n' +
            'Only choose pest, damage or dying when you can clearly see it. Confidence is 0 to 1. Reason is one short sentence.',
        },
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      ...thinking(name, 200),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', enum: HEALTH_LABELS },
          confidence: { type: 'NUMBER' },
          reason: { type: 'STRING' },
        },
        required: ['label', 'confidence', 'reason'],
      },
    },
  }, fetchImpl);
  const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const out = JSON.parse(text);
  if (!HEALTH_LABELS.includes(out.label)) throw new Error(`Gemini gave an unknown label: ${out.label}`);
  return { label: out.label, confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), reason: String(out.reason ?? '').slice(0, 200) };
}

// Reads the text printed on a Tree Detective tag (backup when the QR won't decode).
export async function geminiReadTag(env, buffer, mime, fetchImpl = fetch) {
  const name = await model(env, 'chat', fetchImpl);
  const json = await call(env, name, 'generateContent', {
    contents: [{
      role: 'user',
      parts: [
        {
          text:
            'This photo may show a "Tree Detective" tag: a QR code with a code printed under it like "TD-001-AB12CD", ' +
            'or a screen showing such a tag. Copy the printed code exactly. If you can read a web link, copy it too. ' +
            'If there is no tag, return empty strings.',
        },
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      ...thinking(name, 200),
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { code: { type: 'STRING' }, link: { type: 'STRING' } },
        required: ['code', 'link'],
      },
    },
  }, fetchImpl);
  const out = JSON.parse((json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''));
  return out.link || out.code || '';
}

async function jsonCall(env, parts, schema, fetchImpl) {
  const name = await model(env, 'chat', fetchImpl);
  const json = await call(env, name, 'generateContent', {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, ...thinking(name, 200), responseMimeType: 'application/json', responseSchema: schema },
  }, fetchImpl);
  return JSON.parse((json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''));
}

// Does this photo complete the photo quest? ("a tree with red or orange leaves")
export async function geminiQuestCheck(env, buffer, mime, quest, fetchImpl = fetch) {
  const out = await jsonCall(env, [
    { text: `A player in a campus tree game sent this photo for the quest: "${quest}". Does the photo clearly show that? Be fair but not gullible: it must be a real photo of the thing, not a screen or a drawing. Reason is one short, friendly sentence to the player.` },
    { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
  ], {
    type: 'OBJECT',
    properties: { match: { type: 'BOOLEAN' }, confidence: { type: 'NUMBER' }, reason: { type: 'STRING' } },
    required: ['match', 'confidence', 'reason'],
  }, fetchImpl);
  return { match: Boolean(out.match), confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), reason: String(out.reason ?? '').slice(0, 200) };
}

// Transcribes a voice memory and checks it is fine to play to strangers.
export async function geminiListen(env, buffer, mime, fetchImpl = fetch) {
  const out = await jsonCall(env, [
    { text: 'This is a short voice memory someone left at a tree in a family-friendly campus game. Transcribe it. safe is false if it has insults, hate, sexual content, threats, personal info like phone numbers or addresses, or ads.' },
    { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
  ], {
    type: 'OBJECT',
    properties: { transcript: { type: 'STRING' }, safe: { type: 'BOOLEAN' } },
    required: ['transcript', 'safe'],
  }, fetchImpl);
  return { transcript: String(out.transcript ?? '').trim().slice(0, 400), safe: out.safe !== false };
}
