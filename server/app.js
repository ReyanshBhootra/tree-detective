import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import {
  ROOT, CONFIRM_THRESHOLD, FLAG_TYPES, LOCATION_RADIUS_METERS, POINTS_PER_TREE,
  REPORT_LIMIT_PER_HOUR, ASK_LIMIT_PER_HOUR, SEASONS, PEST_REPORT_URL, PEST_HOTLINE,
  RESCUE_BONUS, NOTE_LIMIT_PER_HOUR,
} from './config.js';
import { loadTrees, loadPersonas } from './lib/trees.js';
import { createStore } from './lib/store.js';
import { createPhotoStore } from './lib/blob.js';
import { analyzePhoto, visionConfigured, speciesProvider } from './lib/vision.js';
import { flagStatus, treeHealth } from './lib/vouch.js';
import { totalPoints, visitPoints } from './lib/points.js';
import { planRoute } from './lib/geo.js';
import { verifyTreeKey } from './lib/qr.js';
import { rateLimiter } from './lib/ratelimit.js';
import { loadFacts, buildAskMessages } from './lib/ask.js';
import { createAI } from './lib/ai.js';
import { createVoice } from './lib/voice.js';
import { translate } from './lib/azure.js';
import { LANGUAGES, isLanguage } from './lib/languages.js';
import { createTiger } from './lib/tiger.js';
import { computeTrends, computeSeasonTimeline } from './lib/trends.js';
import { createWeather, weatherLine } from './lib/weather.js';
import { checkNote, cleanName, HIDE_AFTER_FLAGS } from './lib/notes.js';

const PLAYER_ID = /^[A-Za-z0-9-]{8,64}$/;
const LINK_CODE_TTL_MS = 30 * 60 * 1000;
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I mix-ups
const DEFAULT_HISTORIC_WMS = 'https://img.nj.gov/imagerywms/BlackWhite1930';

export function createApp({
  env = process.env,
  store = createStore(env),
  photos = createPhotoStore(env),
  trees = loadTrees(),
  personas = loadPersonas(),
  vision = (buf, mime) => analyzePhoto(buf, env, fetch, mime),
  ai = createAI(env),
  askModel = (messages) => ai.chat(messages, { temperature: 0.6, maxTokens: 200 }),
  voice = createVoice(env),
  facts = (code) => loadFacts(code),
  askEnabled = ai.can('chat'),
  tiger = createTiger(env),
  embedQuery = ai.can('embed') ? (q) => ai.embed(q) : null,
  weather = null,
  translator = env.AZURE_TRANSLATOR_KEY && env.AZURE_TRANSLATOR_REGION ? (text, langs, codeMap) => translate(env, text, langs, codeMap) : null,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // App Service sits behind one proxy; gives the real client address
  app.use(express.json({ limit: '100kb' }));

  // Suggested questions live in their own file so generated content in trees.json is never touched.
  const qFile = path.join(ROOT, 'data', 'questions.json');
  const suggested = fs.existsSync(qFile) ? JSON.parse(fs.readFileSync(qFile, 'utf8')) : {};
  trees = trees.map((t) => (t.questions || !suggested[t.code] ? t : { ...t, questions: suggested[t.code] }));
  const byCode = new Map(trees.map((t) => [t.code, t]));
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const salt = env.REPORT_SALT || 'tree-detective';
  const hash = (s) => crypto.createHash('sha256').update(`${salt}:${s}`).digest('hex').slice(0, 32);
  const hashPlayer = (id) => hash(id);
  const reportLimit = rateLimiter(REPORT_LIMIT_PER_HOUR);
  const askLimit = rateLimiter(ASK_LIMIT_PER_HOUR);

  const noteLimit = rateLimiter(NOTE_LIMIT_PER_HOUR);
  const currentWeather = weather ?? (trees.length ? createWeather(centroid()) : async () => null);
  // TigerData writes never block or break a request.
  const logEvent = (e) => tiger?.logEvent(e).catch((err) => console.warn('tigerdata:', err.message));

  const historicUrl = env.HISTORIC_WMS_URL === 'off' ? null : env.HISTORIC_WMS_URL || DEFAULT_HISTORIC_WMS;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)),
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

  function requirePlayer(id, res) {
    if (!PLAYER_ID.test(id ?? '')) {
      bad(res, 'playerId must be 8-64 letters, digits or dashes');
      return false;
    }
    return true;
  }

  async function playerSummary(playerId, { withReports = false } = {}) {
    const visits = await store.list('visits', playerId);
    const visited = new Set(visits.map((v) => v.rowKey));
    const last = [...visits].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    const from = (last && byCode.get(last.rowKey)) || centroid();
    const unvisited = trees.filter((t) => !visited.has(t.code));
    const route = planRoute(from, unvisited);
    const bonuses = await store.list('bonuses', playerId);
    const summary = {
      playerId,
      totalPoints: totalPoints(visits) + totalPoints(bonuses),
      bonusPoints: totalPoints(bonuses),
      visited: visits
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
        .map((v) => ({ code: v.rowKey, name: byCode.get(v.rowKey)?.name ?? v.rowKey, timestamp: v.timestamp, points: v.points })),
      remaining: unvisited.length,
      totalTrees: trees.length,
      next: route[0] ? { code: route[0].code, name: route[0].name } : null,
      routeUrl: `${publicUrl}/?route=1`,
    };
    if (withReports) {
      const me = hashPlayer(playerId);
      const mine = (await store.list('reports')).filter((r) => r.reporterHash === me);
      summary.reportsSent = mine.filter((r) => r.photoUrl || r.flagType !== 'none').length;
      summary.seasonsLogged = mine.filter((r) => r.season).length;
      summary.pestReports = mine.filter((r) => r.flagType === 'pest').length;
      summary.rescues = bonuses.length;
    }
    return summary;
  }

  function centroid() {
    const n = trees.length || 1;
    return { lat: trees.reduce((s, t) => s + t.lat, 0) / n, lng: trees.reduce((s, t) => s + t.lng, 0) / n };
  }

  // ---------- public read endpoints ----------

  app.get('/api/config', (_req, res) => {
    res.json({
      publicUrl,
      pointsPerTree: POINTS_PER_TREE,
      locationRadiusMeters: LOCATION_RADIUS_METERS,
      confirmThreshold: CONFIRM_THRESHOLD,
      flagTypes: FLAG_TYPES,
      seasons: SEASONS,
      photonNumber: env.PHOTON_PHONE_NUMBER || null,
      languages: Object.entries(LANGUAGES).map(([code, l]) => ({ code, name: l.name, label: l.label, locale: l.locale })),
      rescueBonus: RESCUE_BONUS,
      // Map background. OpenStreetMap's free tiles by default, no key needed.
      tiles: {
        url: env.MAP_TILES_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: env.MAP_TILES_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: Number(env.MAP_TILES_MAX_ZOOM || 19),
      },
      pestReport: { url: PEST_REPORT_URL, hotline: PEST_HOTLINE },
      historic: historicUrl
        ? {
            wmsUrl: historicUrl,
            layer: env.HISTORIC_WMS_LAYER || 'BlackWhite1930',
            year: 1930,
            attribution: '1930s aerial photography: NJ Office of GIS',
          }
        : null,
      features: {
        speciesVision: visionConfigured(env),
        speciesProvider: speciesProvider(env),
        photon: Boolean(env.PHOTON_PROJECT_ID),
        photoStorage: photos.kind,
        signedTags: Boolean(env.QR_SECRET),
        ask: askEnabled,
        aiProvider: ai.providers.chat,
        tigerData: Boolean(tiger),
        voice: voice?.provider ?? null,
        liveTranslation: translatorReady,
      },
    });
  });

  app.get('/api/trees', (_req, res) => res.json(trees));

  app.get('/api/trees/:code', (req, res) => {
    const t = byCode.get(req.params.code.toUpperCase());
    return t ? res.json(t) : bad(res, 'unknown tree', 404);
  });

  // Live community info shown inside the story: active flags and the latest season sighting.
  app.get('/api/trees/:code/status', wrap(async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!byCode.has(code)) return bad(res, 'unknown tree', 404);
    const h = treeHealth(await store.list('reports', code), code);
    res.json({ flags: h.flags, season: h.season, reportCount: h.reportCount });
  }));

  // One line per tree for the map: is anything wrong with it?
  app.get('/api/status', wrap(async (_req, res) => {
    const reports = await store.list('reports');
    const out = {};
    for (const t of trees) {
      const flags = Object.values(treeHealth(reports, t.code).flags);
      out[t.code] = flags.some((f) => f.status === 'confirmed') ? 'confirmed' : flags.length ? 'possible' : 'ok';
    }
    res.json(out);
  }));

  app.get('/api/weather', wrap(async (_req, res) => {
    const w = await currentWeather();
    res.json(w ? { ...w, line: weatherLine(w) } : null);
  }));

  // ---------- notes for the tree ----------

  app.get('/api/trees/:code/notes', wrap(async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!byCode.has(code)) return bad(res, 'unknown tree', 404);
    const notes = (await store.list('notes', code))
      .filter((n) => (n.flags ?? 0) < HIDE_AFTER_FLAGS)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 12)
      .map((n) => ({ id: n.rowKey, text: n.text, name: n.name, timestamp: n.timestamp }));
    res.json(notes);
  }));

  app.post('/api/trees/:code/notes', wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    if (!(await store.get('visits', playerId, tree.code))) return bad(res, 'Wake this tree first, then you can leave it a note.', 403);
    const check = checkNote(req.body.text);
    if (!check.ok) return bad(res, check.error);
    if (!noteLimit(hash(`note:${req.ip}`))) return bad(res, 'That\'s a lot of notes. Try again later.', 429);
    const timestamp = new Date().toISOString();
    const note = {
      partitionKey: tree.code, rowKey: `${timestamp}-${crypto.randomUUID().slice(0, 8)}`,
      text: check.text, name: cleanName(req.body.name), timestamp, authorHash: hashPlayer(playerId), flags: 0,
    };
    await store.upsert('notes', note);
    res.status(201).json({ id: note.rowKey, text: note.text, name: note.name, timestamp });
  }));

  app.post('/api/trees/:code/notes/:id/flag', wrap(async (req, res) => {
    const code = req.params.code.toUpperCase();
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    const note = await store.get('notes', code, req.params.id);
    if (!note) return bad(res, 'unknown note', 404);
    const flaggedBy = new Set(String(note.flaggedBy ?? '').split(',').filter(Boolean));
    flaggedBy.add(hashPlayer(playerId).slice(0, 12));
    await store.upsert('notes', { partitionKey: code, rowKey: note.rowKey, flags: flaggedBy.size, flaggedBy: [...flaggedBy].join(',') });
    res.json({ ok: true, hidden: flaggedBy.size >= HIDE_AFTER_FLAGS });
  }));

  // ---------- stories in other languages, and their voices ----------
  // Pre-made translations and recordings are used when they exist. Otherwise
  // the first request makes one (Azure Translator / ElevenLabs or Azure Speech),
  // saves it, and every later request reuses it.
  const translatorReady = Boolean(translator);
  const pending = new Map();
  const once = (key, fn) => {
    if (!pending.has(key)) pending.set(key, fn().finally(() => setTimeout(() => pending.delete(key), 1000)));
    return pending.get(key);
  };
  const storyHash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);

  async function storyIn(tree, lang) {
    if (lang === 'en') return { story: tree.story, machine: false };
    if (tree.translations?.[lang]?.story) return { story: tree.translations[lang].story, machine: Boolean(tree.translations[lang].machine) };
    const hashNow = storyHash(tree.story);
    const saved = await store.get('translations', tree.code, lang);
    if (saved?.source === hashNow) return { story: saved.story, machine: true };
    if (!translatorReady) return null;
    return once(`t:${tree.code}:${lang}`, async () => {
      const codeMap = Object.fromEntries(Object.entries(LANGUAGES).filter(([, l]) => l.translator).map(([c, l]) => [c, l.translator]));
      const story = (await translator(tree.story, [lang], codeMap))[lang];
      await store.upsert('translations', { partitionKey: tree.code, rowKey: lang, story, source: hashNow, at: new Date().toISOString() });
      return { story, machine: true };
    });
  }

  app.get('/api/trees/:code/story/:lang', wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    if (!isLanguage(req.params.lang)) return bad(res, 'unknown language');
    const out = await storyIn(tree, req.params.lang);
    return out ? res.json(out) : bad(res, 'Translation isn\'t set up on this server.', 404);
  }));

  const audioDir = path.join(env.DATA_DIR || path.join(ROOT, '.data'), 'audio');
  app.get('/api/trees/:code/audio/:lang', wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const lang = req.params.lang;
    if (!isLanguage(lang)) return bad(res, 'unknown language');
    const made = lang === 'en' ? tree.audio?.en ?? tree.audioUrl : tree.audio?.[lang];
    if (made) return res.redirect(made);
    const persona = personaById.get(tree.persona);
    if (!voice || !voice.canSpeak(persona, lang)) return bad(res, 'No voice for this language here.', 404);
    const text = (await storyIn(tree, lang))?.story;
    if (!text) return bad(res, 'Translation isn\'t set up on this server.', 404);
    const file = path.join(audioDir, `${tree.code}.${lang}.${storyHash(text)}.mp3`);
    if (!fs.existsSync(file)) {
      await once(`a:${file}`, async () => {
        const mp3 = await voice.speak(text, persona, lang);
        fs.mkdirSync(audioDir, { recursive: true });
        fs.writeFileSync(file, mp3);
      });
    }
    res.type('audio/mpeg').set('Cache-Control', 'public, max-age=86400').sendFile(file);
  }));

  app.get('/api/personas', (_req, res) => res.json(personas));

  // ---------- visits and points ----------

  app.post('/api/visits', wrap(async (req, res) => {
    const { playerId, treeCode, locationVerified, treeKey } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    const tree = byCode.get(String(treeCode ?? '').toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    if (!verifyTreeKey(tree.code, treeKey, env.QR_SECRET)) {
      return bad(res, 'That tag link isn\'t valid. Scan the tag on the tree itself.', 403);
    }

    const existing = await store.get('visits', playerId, tree.code);
    if (!existing) {
      await store.upsert('visits', {
        partitionKey: playerId,
        rowKey: tree.code,
        treeCode: tree.code,
        timestamp: new Date().toISOString(),
        points: visitPoints(false),
        // Only the outcome of the on-phone check is stored, never the phone's position.
        locationVerified: locationVerified === true ? 'yes' : locationVerified === false ? 'no' : 'unknown',
      });
      logEvent({ treeCode: tree.code, kind: 'visit' });
    }
    const summary = await playerSummary(playerId, { withReports: true });
    res.status(existing ? 200 : 201).json({
      firstVisit: !existing,
      pointsEarned: existing ? 0 : POINTS_PER_TREE,
      ...summary,
    });
  }));

  app.get('/api/players/:playerId', wrap(async (req, res) => {
    if (!requirePlayer(req.params.playerId, res)) return;
    res.json(await playerSummary(req.params.playerId, { withReports: true }));
  }));

  // ---------- photos, species, pest/damage flags and season sightings ----------

  app.post('/api/trees/:code/reports', upload.single('photo'), wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    let flagType = String(req.body.flagType || 'none').toLowerCase();
    if (!FLAG_TYPES.includes(flagType)) return bad(res, `flagType must be one of ${FLAG_TYPES.join(', ')}`);
    const season = String(req.body.season || '').toLowerCase();
    if (season && !SEASONS.includes(season)) return bad(res, `season must be one of ${SEASONS.join(', ')}`);
    if (!req.file && flagType === 'none' && !season) return bad(res, 'send a photo, a flag, a season sighting, or all three');
    if (!reportLimit(hash(`ip:${req.ip}`))) return bad(res, 'Lots of reports from this network. Try again in a bit.', 429);

    let analysis = { available: false };
    let photoUrl = '';
    if (req.file) {
      const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[req.file.mimetype] ?? 'jpg';
      photoUrl = await photos.save(`${tree.code}/${Date.now()}-${crypto.randomUUID()}.${ext}`, req.file.buffer, req.file.mimetype);
      try {
        analysis = await vision(req.file.buffer, req.file.mimetype);
      } catch (e) {
        console.warn('photo check failed:', e.message);
        analysis = { available: false, error: 'species check is unavailable right now' };
      }
    }
    // The person's own flag wins. If they didn't flag anything but the health
    // model saw something, it still only ever starts as "possible".
    let flagSource = flagType === 'none' ? 'none' : 'person';
    if (flagType === 'none' && analysis.suggestedFlag) {
      flagType = analysis.suggestedFlag;
      flagSource = 'vision';
    }

    // Rescue bonus: a photo of a tree that already has an open problem helps
    // confirm or clear it, so it's worth extra points (once per tree per person).
    let rescue = 0;
    if (photoUrl) {
      const before = await store.list('reports', tree.code);
      const open = Object.values(treeHealth(before, tree.code).flags).some((f) => f.status === 'possible');
      if (open && !(await store.get('bonuses', playerId, `${tree.code}-rescue`))) {
        await store.upsert('bonuses', {
          partitionKey: playerId, rowKey: `${tree.code}-rescue`, treeCode: tree.code,
          points: RESCUE_BONUS, timestamp: new Date().toISOString(),
        });
        rescue = RESCUE_BONUS;
      }
    }

    const report = {
      partitionKey: tree.code,
      rowKey: crypto.randomUUID(),
      treeCode: tree.code,
      photoUrl,
      timestamp: new Date().toISOString(),
      flagType,
      flagSource,
      status: flagType === 'none' ? 'none' : 'possible',
      season,
      reporterHash: hashPlayer(playerId),
      speciesGuess: analysis.speciesGuess ?? '',
      confidence: analysis.confidence ?? null,
      speciesFeedback: '',
    };
    await store.upsert('reports', report);
    logEvent({ time: report.timestamp, treeCode: tree.code, kind: 'report', flagType: flagType === 'none' ? null : flagType, season: season || null, hasPhoto: Boolean(photoUrl) });

    let flag = null;
    if (flagType !== 'none') {
      const all = await store.list('reports', tree.code);
      flag = flagStatus(all, tree.code, flagType);
      if (flag.status === 'confirmed') {
        for (const r of all) {
          if (r.flagType === flagType && r.status !== 'confirmed') {
            await store.upsert('reports', { partitionKey: r.partitionKey, rowKey: r.rowKey, status: 'confirmed' });
          }
        }
        report.status = 'confirmed';
        // Queue one alert per tree + problem. The Photon service texts it to the grounds team.
        const alertId = `${tree.code}-${flagType}`;
        if (!(await store.get('alerts', 'alert', alertId))) {
          await store.upsert('alerts', {
            partitionKey: 'alert', rowKey: alertId, treeCode: tree.code, treeName: tree.name,
            flagType, reporters: flag.reporters, lat: tree.lat, lng: tree.lng,
            createdAt: new Date().toISOString(), sentAt: '',
          });
        }
      }
    }

    const { reporterHash: _hidden, ...publicReport } = report;
    res.status(201).json({
      report: { id: report.rowKey, ...publicReport },
      species: analysis.speciesGuess
        ? { guess: analysis.speciesGuess, confidence: analysis.confidence, alternatives: analysis.alternatives ?? [], provider: analysis.provider }
        : null,
      speciesNote: analysis.speciesGuess ? null : analysis.error ?? 'species check is not configured on this server',
      flag,
      photoCheck: analysis.suggestedFlag ? { flag: analysis.suggestedFlag, confidence: analysis.flagConfidence, reason: analysis.flagReason, by: analysis.healthProvider } : null,
      pestReport: flagType === 'pest' ? { url: PEST_REPORT_URL, hotline: PEST_HOTLINE } : null,
      rescueBonus: rescue,
    });
  }));

  app.post('/api/trees/:code/reports/:id/feedback', wrap(async (req, res) => {
    const { playerId, feedback } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    if (!['agree', 'disagree'].includes(feedback)) return bad(res, 'feedback must be agree or disagree');
    const code = req.params.code.toUpperCase();
    const r = await store.get('reports', code, req.params.id);
    if (!r) return bad(res, 'unknown report', 404);
    if (r.reporterHash !== hashPlayer(playerId)) return bad(res, 'only the person who sent the photo can rate its guess', 403);
    await store.upsert('reports', { partitionKey: code, rowKey: r.rowKey, speciesFeedback: feedback });
    res.json({ ok: true });
  }));

  // ---------- ask the tree ----------

  app.post('/api/trees/:code/ask', wrap(async (req, res) => {
    if (!askEnabled) return bad(res, 'Asking trees questions isn\'t switched on here.', 503);
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    const question = String(req.body.question ?? '').trim().slice(0, 200);
    if (question.length < 3) return bad(res, 'ask a question first');
    if (!(await store.get('visits', playerId, tree.code))) return bad(res, 'Wake this tree first, then you can ask it things.', 403);
    if (!askLimit(hash(`ask:${req.ip}`))) return bad(res, 'The trees need a short rest. Try again soon.', 429);

    const lang = isLanguage(req.body.lang) ? req.body.lang : 'en';

    const persona = personaById.get(tree.persona);
    let retrieved = [];
    if (tiger && embedQuery) {
      try {
        retrieved = await tiger.searchFacts(tree.code, await embedQuery(question), 5);
      } catch (e) {
        console.warn('fact search failed:', e.message);
      }
    }
    const history = Array.isArray(req.body.history) ? req.body.history.filter((h) => h && h.q && h.a).slice(-3) : [];
    const answer = (await askModel(buildAskMessages(tree, persona, facts(tree.code), question, { retrieved, lang, history }))).slice(0, 700);
    let audio = null;
    if (voice && voice.canSpeak(persona, lang)) {
      try {
        audio = `data:audio/mpeg;base64,${(await voice.speak(answer, persona, lang)).toString('base64')}`;
      } catch (e) {
        console.warn('speech failed:', e.message);
      }
    }
    res.json({ answer, audio, sources: retrieved.map((r) => ({ url: r.source_url, label: r.label })) });
  }));

  // ---------- grounds team view ----------

  app.get('/api/trends', wrap(async (req, res) => {
    const weeks = Math.min(52, Math.max(2, Number(req.query.weeks) || 8));
    if (tiger) {
      try {
        return res.json({ source: 'TigerData', weeks: await tiger.trends(weeks), seasonTimeline: await tiger.seasonTimeline() });
      } catch (e) {
        console.warn('tigerdata trends failed, using app data:', e.message);
      }
    }
    const reports = await store.list('reports');
    res.json({ source: 'app', weeks: computeTrends(await store.list('visits'), reports, { weeks }), seasonTimeline: computeSeasonTimeline(reports) });
  }));

  app.get('/api/health', wrap(async (_req, res) => {
    const reports = await store.list('reports');
    res.json({
      confirmThreshold: CONFIRM_THRESHOLD,
      generatedAt: new Date().toISOString(),
      pestReport: { url: PEST_REPORT_URL, hotline: PEST_HOTLINE },
      trees: trees.map((t) => ({
        code: t.code, name: t.name, lat: t.lat, lng: t.lng, curatedSpecies: t.species,
        ...treeHealth(reports, t.code),
        photos: reports
          .filter((r) => r.treeCode === t.code && r.photoUrl)
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
          .slice(0, 6)
          .map((r) => ({ url: r.photoUrl, timestamp: r.timestamp, flagType: r.flagType, status: r.status })),
      })),
    });
  }));

  app.get('/api/reports.csv', wrap(async (_req, res) => {
    const reports = await store.list('reports');
    const cols = ['treeCode', 'timestamp', 'flagType', 'flagSource', 'status', 'season', 'speciesGuess', 'confidence', 'speciesFeedback', 'photoUrl'];
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = reports
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
      .map((r) => cols.map((c) => esc(c === 'photoUrl' && r.photoUrl?.startsWith('/') ? publicUrl + r.photoUrl : r[c])).join(','));
    res.type('text/csv').attachment('tree-reports.csv').send([cols.join(','), ...rows].join('\n') + '\n');
  }));

  // ---------- Photon linking ----------

  app.post('/api/link-codes', wrap(async (req, res) => {
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    let code = '';
    for (let i = 0; i < 6; i++) code += LINK_ALPHABET[crypto.randomInt(LINK_ALPHABET.length)];
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
    await store.upsert('linkcodes', { partitionKey: 'code', rowKey: code, playerId, expiresAt });
    res.status(201).json({ code, expiresAt });
  }));

  const photon = express.Router();
  photon.use((req, res, next) => {
    const key = env.PHOTON_API_KEY;
    const given = req.get('x-photon-key') ?? '';
    if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
      return bad(res, 'not allowed', 401);
    }
    next();
  });

  photon.post('/link', wrap(async (req, res) => {
    const code = String(req.body?.code ?? '').toUpperCase();
    const { senderId, spaceId } = req.body ?? {};
    if (!senderId) return bad(res, 'senderId required');
    const row = await store.get('linkcodes', 'code', code);
    if (!row || row.expiresAt < new Date().toISOString()) return bad(res, 'that code is unknown or expired', 404);
    await store.remove('linkcodes', 'code', code);
    await store.upsert('links', {
      partitionKey: 'link', rowKey: senderId, playerId: row.playerId, spaceId: spaceId ?? '',
      linkedAt: new Date().toISOString(), lastNudgedAt: '', nudges: 'on',
    });
    res.json(await playerSummary(row.playerId));
  }));

  photon.get('/players/:senderId', wrap(async (req, res) => {
    const link = await store.get('links', 'link', req.params.senderId);
    if (!link) return bad(res, 'not linked', 404);
    res.json(await playerSummary(link.playerId));
  }));

  photon.get('/links', wrap(async (_req, res) => {
    const links = await store.list('links', 'link');
    res.json(await Promise.all(links.map(async (l) => ({
      senderId: l.rowKey, spaceId: l.spaceId, lastNudgedAt: l.lastNudgedAt, nudges: l.nudges !== 'off',
      summary: await playerSummary(l.playerId),
    }))));
  }));

  photon.post('/links/:senderId/nudged', wrap(async (req, res) => {
    const link = await store.get('links', 'link', req.params.senderId);
    if (!link) return bad(res, 'not linked', 404);
    await store.upsert('links', { partitionKey: 'link', rowKey: req.params.senderId, lastNudgedAt: new Date().toISOString() });
    res.json({ ok: true });
  }));

  photon.post('/links/:senderId/prefs', wrap(async (req, res) => {
    const link = await store.get('links', 'link', req.params.senderId);
    if (!link) return bad(res, 'not linked', 404);
    const nudges = req.body?.nudges === false ? 'off' : 'on';
    await store.upsert('links', { partitionKey: 'link', rowKey: req.params.senderId, nudges });
    res.json({ ok: true, nudges: nudges === 'on' });
  }));

  // Confirmed problems waiting to be texted to the grounds team.
  photon.get('/alerts', wrap(async (_req, res) => {
    const alerts = (await store.list('alerts', 'alert')).filter((a) => !a.sentAt);
    res.json(alerts.map((a) => ({ id: a.rowKey, ...a, mapUrl: `${publicUrl}/grounds.html` })));
  }));

  photon.post('/alerts/:id/sent', wrap(async (req, res) => {
    if (!(await store.get('alerts', 'alert', req.params.id))) return bad(res, 'unknown alert', 404);
    await store.upsert('alerts', { partitionKey: 'alert', rowKey: req.params.id, sentAt: new Date().toISOString() });
    res.json({ ok: true });
  }));

  app.use('/api/photon', photon);

  // ---------- static site ----------

  if (photos.kind === 'local') app.use('/uploads', express.static(photos.dir, { maxAge: '1h' }));
  app.use(express.static(path.join(ROOT, 'web'), { extensions: ['html'] }));

  app.use('/api', (_req, res) => bad(res, 'not found', 404));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) return bad(res, err.message);
    console.error(err);
    bad(res, 'something went wrong', 500);
  });

  return app;
}
