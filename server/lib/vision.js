// Photo analysis.
// Species: Pl@ntNet (free, knows tens of thousands of plants) when PLANTNET_API_KEY
// is set, otherwise an Azure Custom Vision species model if you trained one.
// Health: an Azure Custom Vision model with tags "healthy", "pest", "damage", "dying"
// if you trained one, otherwise Gemini looks at the photo (no training needed).
import { geminiHealth } from './gemini.js';

const HEALTH_FLAGS = new Set(['pest', 'damage', 'dying']);
// Below this, a health tag is not strong enough to raise even a "possible" flag.
export const HEALTH_FLAG_MIN_PROBABILITY = 0.6;
// Custom Vision only reads these formats.
const CV_TYPES = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/gif']);

async function classify(env, projectId, iteration, buffer, fetchImpl) {
  const base = env.CUSTOM_VISION_ENDPOINT.replace(/\/+$/, '');
  const url = `${base}/customvision/v3.0/Prediction/${projectId}/classify/iterations/${encodeURIComponent(iteration)}/image`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Prediction-Key': env.CUSTOM_VISION_KEY, 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Custom Vision ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return [...(json.predictions ?? [])].sort((a, b) => b.probability - a.probability);
}

async function plantnet(env, buffer, mime, fetchImpl) {
  const form = new FormData();
  form.append('images', new Blob([buffer], { type: mime }), 'tree.jpg');
  form.append('organs', 'auto');
  const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(env.PLANTNET_API_KEY)}&lang=en&nb-results=3`;
  const res = await fetchImpl(url, { method: 'POST', body: form });
  if (res.status === 404) return []; // Pl@ntNet's answer for "no plant recognised"
  if (!res.ok) throw new Error(`Pl@ntNet ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.results ?? []).map((r) => {
    const sci = r.species?.scientificNameWithoutAuthor ?? 'Unknown';
    const common = r.species?.commonNames?.[0];
    return { tagName: common ? `${common} (${sci})` : sci, probability: r.score };
  });
}

const cvSpecies = (env) => Boolean(env.CUSTOM_VISION_ENDPOINT && env.CUSTOM_VISION_KEY && env.CUSTOM_VISION_SPECIES_PROJECT_ID);
const cvHealth = (env) => Boolean(env.CUSTOM_VISION_ENDPOINT && env.CUSTOM_VISION_KEY && env.CUSTOM_VISION_HEALTH_PROJECT_ID);

export function healthProvider(env = process.env) {
  if (cvHealth(env)) return 'Azure Custom Vision';
  if (env.GEMINI_API_KEY) return 'Gemini';
  return null;
}

export function visionConfigured(env = process.env) {
  return Boolean(env.PLANTNET_API_KEY) || cvSpecies(env);
}

export function speciesProvider(env = process.env) {
  if (env.PLANTNET_API_KEY) return 'Pl@ntNet';
  if (cvSpecies(env)) return 'Azure Custom Vision';
  return null;
}

export async function analyzePhoto(buffer, env = process.env, fetchImpl = fetch, mime = 'image/jpeg') {
  const provider = speciesProvider(env);
  const health = healthProvider(env);
  if (!provider && !health) {
    return { available: false, speciesGuess: null, confidence: null, suggestedFlag: null };
  }
  if (!CV_TYPES.has(mime) && mime !== 'image/webp') {
    return { available: false, error: 'this photo format (like iPhone HEIC) can\'t be read, try a JPEG' };
  }

  let species = [];
  if (provider === 'Pl@ntNet') species = await plantnet(env, buffer, mime, fetchImpl);
  else if (provider) species = await classify(env, env.CUSTOM_VISION_SPECIES_PROJECT_ID, env.CUSTOM_VISION_SPECIES_ITERATION, buffer, fetchImpl);

  let suggestedFlag = null;
  let flagConfidence = null;
  let flagReason = null;
  try {
    if (health === 'Azure Custom Vision' && CV_TYPES.has(mime)) {
      const tags = await classify(env, env.CUSTOM_VISION_HEALTH_PROJECT_ID, env.CUSTOM_VISION_HEALTH_ITERATION, buffer, fetchImpl);
      const top = tags.find((p) => HEALTH_FLAGS.has(p.tagName.toLowerCase()));
      if (top && top.probability >= HEALTH_FLAG_MIN_PROBABILITY) {
        suggestedFlag = top.tagName.toLowerCase();
        flagConfidence = top.probability;
      }
    } else if (health === 'Gemini') {
      const g = await geminiHealth(env, buffer, mime, fetchImpl);
      if (HEALTH_FLAGS.has(g.label) && g.confidence >= HEALTH_FLAG_MIN_PROBABILITY) {
        suggestedFlag = g.label;
        flagConfidence = g.confidence;
        flagReason = g.reason;
      }
    }
  } catch (e) {
    // A failed health check never loses the species guess or the report.
    console.warn('health check failed:', e.message);
  }
  return {
    available: Boolean(provider),
    provider,
    speciesGuess: species[0]?.tagName ?? null,
    confidence: species[0]?.probability ?? null,
    alternatives: species.slice(1, 3).map((p) => ({ name: p.tagName, confidence: p.probability })),
    suggestedFlag,
    flagConfidence,
    flagReason,
    healthProvider: health,
    error: provider && !species.length ? 'no tree recognised in this photo' : undefined,
  };
}
