import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { ROOT, CONFIRM_THRESHOLD, FLAG_TYPES, LOCATION_RADIUS_METERS, POINTS_PER_TREE } from './config.js';
import { loadTrees, loadPersonas } from './lib/trees.js';
import { createStore } from './lib/store.js';
import { createPhotoStore } from './lib/blob.js';
import { analyzePhoto, visionConfigured } from './lib/vision.js';
import { flagStatus, treeHealth } from './lib/vouch.js';
import { totalPoints, visitPoints } from './lib/points.js';
import { planRoute } from './lib/geo.js';

const PLAYER_ID = /^[A-Za-z0-9-]{8,64}$/;
const LINK_CODE_TTL_MS = 30 * 60 * 1000;
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I mix-ups

export function createApp({
  env = process.env,
  store = createStore(env),
  photos = createPhotoStore(env),
  trees = loadTrees(),
  personas = loadPersonas(),
  vision = (buf) => analyzePhoto(buf, env),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const byCode = new Map(trees.map((t) => [t.code, t]));
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const hashPlayer = (id) =>
    crypto.createHash('sha256').update(`${env.REPORT_SALT || 'tree-detective'}:${id}`).digest('hex').slice(0, 32);

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

  async function playerSummary(playerId) {
    const visits = await store.list('visits', playerId);
    const visited = new Set(visits.map((v) => v.rowKey));
    const last = [...visits].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    const from = (last && byCode.get(last.rowKey)) || centroid();
    const unvisited = trees.filter((t) => !visited.has(t.code));
    const route = planRoute(from, unvisited);
    return {
      playerId,
      totalPoints: totalPoints(visits),
      visited: visits
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
        .map((v) => ({ code: v.rowKey, name: byCode.get(v.rowKey)?.name ?? v.rowKey, timestamp: v.timestamp, points: v.points })),
      remaining: unvisited.length,
      totalTrees: trees.length,
      next: route[0] ? { code: route[0].code, name: route[0].name } : null,
      routeUrl: `${publicUrl}/?route=1`,
    };
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
      photonNumber: env.PHOTON_PHONE_NUMBER || null,
      features: {
        speciesVision: visionConfigured(env),
        photon: Boolean(env.PHOTON_PROJECT_ID),
        photoStorage: photos.kind,
      },
    });
  });

  app.get('/api/trees', (_req, res) => res.json(trees));

  app.get('/api/trees/:code', (req, res) => {
    const t = byCode.get(req.params.code.toUpperCase());
    return t ? res.json(t) : bad(res, 'unknown tree', 404);
  });

  app.get('/api/personas', (_req, res) => res.json(personas));

  // ---------- visits and points ----------

  app.post('/api/visits', wrap(async (req, res) => {
    const { playerId, treeCode, locationVerified } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    const tree = byCode.get(String(treeCode ?? '').toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);

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
    }
    const summary = await playerSummary(playerId);
    res.status(existing ? 200 : 201).json({
      firstVisit: !existing,
      pointsEarned: existing ? 0 : POINTS_PER_TREE,
      ...summary,
    });
  }));

  app.get('/api/players/:playerId', wrap(async (req, res) => {
    if (!requirePlayer(req.params.playerId, res)) return;
    res.json(await playerSummary(req.params.playerId));
  }));

  // ---------- photos, species and pest/damage flags ----------

  app.post('/api/trees/:code/reports', upload.single('photo'), wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    let flagType = String(req.body.flagType || 'none').toLowerCase();
    if (!FLAG_TYPES.includes(flagType)) return bad(res, `flagType must be one of ${FLAG_TYPES.join(', ')}`);
    if (!req.file && flagType === 'none') return bad(res, 'send a photo, a flag, or both');

    let analysis = { available: false };
    let photoUrl = '';
    if (req.file) {
      const ext = { 'image/png': 'png', 'image/webp': 'webp' }[req.file.mimetype] ?? 'jpg';
      photoUrl = await photos.save(`${tree.code}/${Date.now()}-${crypto.randomUUID()}.${ext}`, req.file.buffer, req.file.mimetype);
      try {
        analysis = await vision(req.file.buffer);
      } catch (e) {
        console.warn('species check failed:', e.message);
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

    const reporterHash = hashPlayer(playerId);
    const report = {
      partitionKey: tree.code,
      rowKey: crypto.randomUUID(),
      treeCode: tree.code,
      photoUrl,
      timestamp: new Date().toISOString(),
      flagType,
      flagSource,
      status: flagType === 'none' ? 'none' : 'possible',
      reporterHash,
      speciesGuess: analysis.speciesGuess ?? '',
      confidence: analysis.confidence ?? null,
      speciesFeedback: '',
    };
    await store.upsert('reports', report);

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
      }
    }

    const { reporterHash: _hidden, ...publicReport } = report;
    res.status(201).json({
      report: { id: report.rowKey, ...publicReport },
      species: analysis.available
        ? { guess: analysis.speciesGuess, confidence: analysis.confidence, alternatives: analysis.alternatives ?? [] }
        : null,
      speciesNote: analysis.available ? null : analysis.error ?? 'species check is not configured on this server',
      flag,
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

  // ---------- grounds team view ----------

  app.get('/api/health', wrap(async (_req, res) => {
    const reports = await store.list('reports');
    res.json({
      confirmThreshold: CONFIRM_THRESHOLD,
      generatedAt: new Date().toISOString(),
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
    const cols = ['treeCode', 'timestamp', 'flagType', 'flagSource', 'status', 'speciesGuess', 'confidence', 'speciesFeedback', 'photoUrl'];
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
