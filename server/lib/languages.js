// Languages a tree can speak. Newark is one of the most multilingual cities in
// New Jersey, so stories come in Spanish, Portuguese and Haitian Creole too.
// `voices` are Azure neural voices; Kreyòl has no Azure voice, so it is text
// only and the browser reads it if it can.
export const LANGUAGES = {
  en: { name: 'English', label: 'EN', locale: 'en-US', voices: null },
  es: { name: 'Español', label: 'ES', locale: 'es-US', voices: { female: 'es-US-PalomaNeural', male: 'es-US-AlonsoNeural' } },
  pt: { name: 'Português', label: 'PT', locale: 'pt-BR', voices: { female: 'pt-BR-FranciscaNeural', male: 'pt-BR-AntonioNeural' } },
  ht: { name: 'Kreyòl', label: 'KREYÒL', locale: 'ht-HT', voices: null },
};

export const isLanguage = (code) => Object.hasOwn(LANGUAGES, code);

// Picks the voice for a persona in another language, matching its gender.
export function voiceFor(persona, lang) {
  if (lang === 'en' || !LANGUAGES[lang]?.voices) return lang === 'en' ? persona.voice : null;
  return LANGUAGES[lang].voices[persona.gender === 'male' ? 'male' : 'female'];
}
