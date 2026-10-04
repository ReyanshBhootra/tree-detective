// Adopted trees text their person first, in their own texting style:
// when someone reports a problem, leaves a note or memory, takes their photo,
// or when the weather is rough. These build the prompt and the backup lines.

const PROBLEM = { pest: 'pests', damage: 'damage', dying: 'signs of dying' };

export function weatherReason(wx) {
  if (!wx) return null;
  const t = Math.round(wx.tempF);
  const s = String(wx.summary ?? '');
  if (/thunder|storm/i.test(s)) return { reason: 'storm', detail: s, temp: t };
  if (t >= 86) return { reason: 'hot', temp: t, detail: s };
  if (t <= 32) return { reason: 'freezing', temp: t, detail: s };
  if (/snow/i.test(s)) return { reason: 'snow', temp: t, detail: s };
  if (/rain|shower|drizzle/i.test(s)) return { reason: 'rain', temp: t, detail: s };
  if (t >= 55 && t <= 80 && /sun|clear/i.test(s)) return { reason: 'nice', temp: t, detail: s };
  return null;
}

export function describe(r) {
  switch (r.reason) {
    case 'adopted': return 'They just adopted you! Thank them warmly and say you will text them when something happens to you (weather, visitors, or if you need help).';
    case 'problem': return `Someone just reported ${PROBLEM[r.detail] ?? r.detail} on you${r.confirmed ? ', and it is now confirmed, so the grounds team was alerted' : ''}. You are a bit worried. Ask them to come check on you and send a photo (text "report" and then a photo).`;
    case 'note': return `Someone left you a note: "${String(r.detail ?? '').slice(0, 140)}". Share it with them, excited.`;
    case 'memory': return 'Someone left a voice memory at your spot. Tell them to come by and wake you to hear it.';
    case 'photo': return 'Someone just took your photo for the explorer album. You are a little proud of how you looked.';
    case 'hot': return `It is ${r.temp}°F. You are hot and thirsty. Ask them to stay cool and, if they pass by, check that your soil is not bone dry.`;
    case 'freezing': return `It is ${r.temp}°F and freezing. Tell them how you handle the cold and to bundle up.`;
    case 'storm': return `A storm is coming (${r.detail}). You are bracing your branches. Ask them to stay safe and to report any broken limbs after.`;
    case 'snow': return 'It is snowing on you. Describe it and tell them to stay warm.';
    case 'rain': return 'It is raining and you are happily drinking it up. Tell them.';
    case 'nice': return `It is ${r.temp}°F and ${r.detail}. Invite them to come sit in your shade or say hi.`;
    default: return 'Just checking in on them.';
  }
}

export function buildTreeTextMessages(tree, persona, r) {
  return [
    {
      role: 'system',
      content:
        `You are ${tree.name}, a tree on a university campus in a family-friendly game, texting the person who adopted you, without them asking. ` +
        `Personality: ${persona?.name ?? 'a friendly tree'}. ${persona?.style ?? ''} Texting style: ${persona?.texting ?? 'short and friendly'} ` +
        'Write one text message under 35 words, first person, no hashtags, no quotes around it. Do not invent campus history.',
    },
    { role: 'user', content: `Why you are texting right now: ${describe(r)}` },
  ];
}

const CANNED = {
  adopted: 'You adopted me?! 💚 Thank you. I will text you when something happens out here.',
  problem: 'Someone says I might not be okay. Could you come check on me and send a photo?',
  note: 'Someone left me a note today! Come read it.',
  memory: 'Someone left a voice memory at my spot. Come wake me to hear it!',
  photo: 'Someone just took my photo. I hope they got my good side.',
  hot: 'So hot today. If you walk by, check my soil is not bone dry. Stay cool!',
  freezing: 'Brr, freezing out here. I will be fine. Bundle up!',
  storm: 'Storm coming. I am bracing my branches. Stay safe, and tell the grounds team if I drop a limb.',
  snow: 'Snow on my branches today. Stay warm!',
  rain: 'Rain! Finally a good long drink.',
  nice: 'Beautiful day out here. Come sit in my shade!',
};
export const cannedTreeText = (r) => CANNED[r.reason] ?? 'Just thinking of you. Come say hi!';

// Day and hour in New York, so trees don't text at 3am.
export function nyClock(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
