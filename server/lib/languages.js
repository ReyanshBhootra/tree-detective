// Languages a tree can speak. Spanish, Portuguese and Haitian Creole are big
// in Newark itself; Chinese, Hindi and Gujarati are New Jersey's next most
// spoken languages and common on the NJIT campus.
// `voices` are Azure neural voices (the backup to ElevenLabs). Azure has no
// Kreyòl voice, so with Azure only, Kreyòl is text the browser reads if it can.
// `translator` is the Azure Translator code when it differs from ours.
export const LANGUAGES = {
  en: { name: 'English', label: 'EN', locale: 'en-US', voices: null },
  es: { name: 'Español', label: 'ES', locale: 'es-US', voices: { female: 'es-US-PalomaNeural', male: 'es-US-AlonsoNeural' } },
  pt: { name: 'Português', label: 'PT', locale: 'pt-BR', voices: { female: 'pt-BR-FranciscaNeural', male: 'pt-BR-AntonioNeural' } },
  ht: { name: 'Kreyòl', label: 'KREYÒL', locale: 'ht-HT', voices: null },
  zh: { name: '中文', label: '中文', locale: 'zh-CN', translator: 'zh-Hans', voices: { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' } },
  hi: { name: 'हिन्दी', label: 'हिन्दी', locale: 'hi-IN', voices: { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' } },
  gu: { name: 'ગુજરાતી', label: 'ગુજરાતી', locale: 'gu-IN', voices: { female: 'gu-IN-DhwaniNeural', male: 'gu-IN-NiranjanNeural' } },
};

// For prompts, so the model knows exactly which language we mean.
export const ENGLISH_NAMES = { en: 'English', es: 'Spanish', pt: 'Portuguese', ht: 'Haitian Creole', zh: 'Simplified Chinese', hi: 'Hindi', gu: 'Gujarati' };

export const isLanguage = (code) => Object.hasOwn(LANGUAGES, code);

// Picks the voice for a persona in another language, matching its gender.
export function voiceFor(persona, lang) {
  if (lang === 'en' || !LANGUAGES[lang]?.voices) return lang === 'en' ? persona.voice : null;
  return LANGUAGES[lang].voices[persona.gender === 'male' ? 'male' : 'female'];
}
