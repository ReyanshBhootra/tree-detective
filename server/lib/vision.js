// Azure Custom Vision prediction calls.
// Species model: tags are species names ("Pin Oak", "London Plane", ...).
// Health model (optional): tags "healthy", "pest", "damage", "dying".

const HEALTH_FLAGS = new Set(['pest', 'damage', 'dying']);
// Below this, a health tag is not strong enough to raise even a "possible" flag.
export const HEALTH_FLAG_MIN_PROBABILITY = 0.6;

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

export function visionConfigured(env = process.env) {
  return Boolean(env.CUSTOM_VISION_ENDPOINT && env.CUSTOM_VISION_KEY && env.CUSTOM_VISION_SPECIES_PROJECT_ID);
}

export async function analyzePhoto(buffer, env = process.env, fetchImpl = fetch) {
  if (!visionConfigured(env)) {
    return { available: false, speciesGuess: null, confidence: null, suggestedFlag: null };
  }
  const species = await classify(
    env, env.CUSTOM_VISION_SPECIES_PROJECT_ID, env.CUSTOM_VISION_SPECIES_ITERATION, buffer, fetchImpl,
  );
  let suggestedFlag = null;
  let flagConfidence = null;
  if (env.CUSTOM_VISION_HEALTH_PROJECT_ID) {
    const health = await classify(
      env, env.CUSTOM_VISION_HEALTH_PROJECT_ID, env.CUSTOM_VISION_HEALTH_ITERATION, buffer, fetchImpl,
    );
    const top = health.find((p) => HEALTH_FLAGS.has(p.tagName.toLowerCase()));
    if (top && top.probability >= HEALTH_FLAG_MIN_PROBABILITY) {
      suggestedFlag = top.tagName.toLowerCase();
      flagConfidence = top.probability;
    }
  }
  return {
    available: true,
    speciesGuess: species[0]?.tagName ?? null,
    confidence: species[0]?.probability ?? null,
    alternatives: species.slice(1, 3).map((p) => ({ name: p.tagName, confidence: p.probability })),
    suggestedFlag,
    flagConfidence,
  };
}
