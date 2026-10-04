// Picks who does the AI writing, fact search and images.
// Azure OpenAI first (when its deployment is set), Google Gemini as the backup.
// Each job is decided on its own, so e.g. Azure chat + Gemini images works too.
import { chat as azureChat, embed as azureEmbed, image as azureImage, imageFromPhoto as azureImageFromPhoto } from './azure.js';
import { geminiChat, geminiEmbed, geminiImage } from './gemini.js';

export function createAI(env = process.env, { fetchImpl = fetch } = {}) {
  const azureBase = Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_KEY);
  const gemini = Boolean(env.GEMINI_API_KEY);
  const pick = (deployment) => (azureBase && env[deployment] ? 'Azure OpenAI' : gemini ? 'Gemini' : null);
  const providers = {
    chat: pick('AZURE_OPENAI_CHAT_DEPLOYMENT'),
    embed: pick('AZURE_OPENAI_EMBEDDING_DEPLOYMENT'),
    image: pick('AZURE_OPENAI_IMAGE_DEPLOYMENT'),
  };
  const need = (job) => {
    if (!providers[job]) throw new Error(`No AI set up for ${job}: add AZURE_OPENAI_* or GEMINI_API_KEY to .env`);
    return providers[job];
  };
  return {
    providers,
    can: (job) => Boolean(providers[job]),
    chat: async (messages, opts) => (need('chat') === 'Gemini' ? geminiChat(env, messages, opts, fetchImpl) : azureChat(env, messages, opts)),
    embed: async (input) => (need('embed') === 'Gemini' ? geminiEmbed(env, input, fetchImpl) : azureEmbed(env, input)),
    image: async (prompt) => (need('image') === 'Gemini' ? geminiImage(env, prompt, null, fetchImpl) : azureImage(env, prompt)),
    imageFromPhoto: async (prompt, photo) => (need('image') === 'Gemini' ? geminiImage(env, prompt, photo, fetchImpl) : azureImageFromPhoto(env, prompt, photo)),
  };
}

// For scripts: stop early with a plain message if a job has no provider.
export function requireAI(ai, job, what) {
  if (ai.can(job)) {
    console.log(`${what} with ${ai.providers[job]}`);
    return;
  }
  console.error(`${what} needs either GEMINI_API_KEY (aistudio.google.com) or Azure OpenAI keys in .env.`);
  process.exit(1);
}
