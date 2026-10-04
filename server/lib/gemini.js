// Google Gemini API (aistudio.google.com). Used for writing, fact search and
// images when Azure OpenAI isn't available.
import { EMBEDDING_DIMS } from './tiger.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const models = (env) => ({
  chat: env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash',
  image: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
  embed: env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
});

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
  const json = await call(env, models(env).chat, 'generateContent', {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    // Thinking off: short in-character replies don't need it, and it would eat the token budget.
    generationConfig: { temperature, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
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
  const model = models(env).embed;
  const texts = Array.isArray(input) ? input : [input];
  const json = await call(env, model, 'batchEmbedContents', {
    requests: texts.map((text) => ({
      model: `models/${model}`,
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
  const json = await call(env, models(env).image, 'generateContent', {
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
  const json = await call(env, models(env).chat, 'generateContent', {
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
      maxOutputTokens: 200,
      thinkingConfig: { thinkingBudget: 0 },
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
