// One place that turns text into a tree's voice.
// ElevenLabs when ELEVENLABS_API_KEY is set (more expressive), otherwise Azure Speech.
import { speak as azureSpeak } from './azure.js';
import { voiceFor } from './languages.js';

// eleven_multilingual_v2 covers English, Spanish, Chinese and Hindi;
// Gujarati needs the newer eleven_v3.
const ELEVEN_MODEL_FOR = { gu: 'eleven_v3' };

export async function elevenSpeak(env, text, voiceId, { lang = 'en', fetchImpl = fetch } = {}) {
  const model = ELEVEN_MODEL_FOR[lang] ?? env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: model,
      language_code: lang,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns null when no voice service is configured.
export function createVoice(env = process.env, { fetchImpl = fetch } = {}) {
  const eleven = Boolean(env.ELEVENLABS_API_KEY);
  const azure = Boolean(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);
  if (!eleven && !azure) return null;
  return {
    provider: eleven ? 'ElevenLabs' : 'Azure Speech',
    // Can this persona be voiced in this language at all?
    canSpeak(persona, lang = 'en') {
      if (eleven) return Boolean(persona?.elevenVoiceId);
      return Boolean(persona && voiceFor(persona, lang));
    },
    voiceName(persona, lang = 'en') {
      return eleven ? `ElevenLabs ${persona.elevenVoiceId}` : voiceFor(persona, lang);
    },
    async speak(text, persona, lang = 'en') {
      if (eleven) {
        const id = env[`ELEVENLABS_VOICE_${persona.id.toUpperCase()}`] || persona.elevenVoiceId;
        return elevenSpeak(env, text, id, { lang, fetchImpl });
      }
      return azureSpeak(env, text, persona, voiceFor(persona, lang));
    },
  };
}
