// The social side of Tree Detective: log in with iMessage, adopt a tree (and
// have it text you first), seasonal photo quests, the explorer photo album,
// and voice memories left at trees.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { ROOT } from './config.js';
import { normalizePhone, samePhone, maskPhone } from './lib/phone.js';
import { toM4a, toMp3 } from './lib/audio.js';
import { rateLimiter } from './lib/ratelimit.js';
import { buildTreeTextMessages, cannedTreeText, weatherReason, nyClock } from './lib/treetexts.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const TREE_TEXTS_PER_DAY = 4;

export function loadQuests(file = path.join(ROOT, 'data', 'quests.json')) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

export function addSocial({
  app, photon, env, store, trees, byCode, personaById, wrap, bad, requirePlayer, playerSummary,
  photos, upload, askModel, currentWeather, hashPlayer, logEvent, questCheck, listen,
  quests = loadQuests(), now = () => new Date(), convert = { toM4a, toMp3 },
}) {
  const iso = () => now().toISOString();
  const loginLimit = rateLimiter(10);
  const memoryLimit = rateLimiter(10);
  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, /^(audio\/|video\/webm|video\/mp4|application\/octet-stream)/.test(file.mimetype)),
  });

  const links = () => store.list('links', 'link');
  const linkForPlayer = async (playerId) => (await links()).find((l) => l.playerId === playerId) ?? null;
  const visited = async (playerId, code) => Boolean(await store.get('visits', playerId, code));

  // ---------- log in with iMessage ----------

  // Moves visits, bonuses and quests from one player to another (no double counting).
  async function mergePlayers(from, to) {
    if (from === to) return;
    for (const table of ['visits', 'bonuses', 'quests']) {
      for (const row of await store.list(table, from)) {
        if (await store.get(table, to, row.rowKey)) continue;
        const { partitionKey: _p, ...rest } = row;
        await store.upsert(table, { ...rest, partitionKey: to });
      }
    }
  }

  app.post('/api/login', wrap(async (req, res) => {
    if (!env.PHOTON_PROJECT_ID) return bad(res, 'Phone login needs the iMessage bot, which isn\'t set up on this server.', 503);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return bad(res, 'Type your phone number, like 201-555-0123.');
    if (!loginLimit(`login:${req.ip}`)) return bad(res, 'Too many tries. Wait a bit and try again.', 429);
    const id = crypto.randomUUID();
    await store.upsert('logins', {
      partitionKey: 'login', rowKey: id, phone, playerId, status: 'pending',
      createdAt: iso(), expiresAt: new Date(now().getTime() + LOGIN_TTL_MS).toISOString(), sentAt: '',
    });
    res.status(201).json({ loginId: id, phone: maskPhone(phone) });
  }));

  app.get('/api/login/:id', wrap(async (req, res) => {
    const row = await store.get('logins', 'login', req.params.id);
    if (!row) return bad(res, 'unknown login', 404);
    const status = row.status === 'pending' && row.expiresAt < iso() ? 'expired' : row.status;
    res.json({ status, phone: maskPhone(row.phone), playerId: status === 'done' ? row.resultPlayerId : undefined });
  }));

  // Who is this browser? (phone and adopted tree, if logged in)
  app.get('/api/players/:playerId/account', wrap(async (req, res) => {
    if (!requirePlayer(req.params.playerId, res)) return;
    const link = await linkForPlayer(req.params.playerId);
    res.json({ loggedIn: Boolean(link), phone: link ? maskPhone(normalizePhone(link.rowKey) ?? link.rowKey) : null, adopted: link?.adopted || null });
  }));

  photon.get('/logins', wrap(async (_req, res) => {
    const pending = (await store.list('logins', 'login')).filter((l) => l.status === 'pending' && !l.sentAt && l.expiresAt > iso());
    res.json(pending.map((l) => ({ id: l.rowKey, phone: l.phone })));
  }));

  photon.post('/logins/:id/sent', wrap(async (req, res) => {
    await store.upsert('logins', { partitionKey: 'login', rowKey: req.params.id, sentAt: iso() });
    res.json({ ok: true });
  }));

  // The person replied YES from their phone.
  photon.post('/logins/confirm', wrap(async (req, res) => {
    const { senderId, spaceId } = req.body ?? {};
    const login = (await store.list('logins', 'login'))
      .filter((l) => l.status === 'pending' && l.sentAt && l.expiresAt > iso() && samePhone(l.phone, senderId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!login) return bad(res, 'no login waiting', 404);
    const link = await store.get('links', 'link', senderId);
    let playerId;
    if (!link) {
      // First time with this number: the browser's progress becomes this phone's.
      playerId = login.playerId;
      await store.upsert('links', {
        partitionKey: 'link', rowKey: senderId, playerId, spaceId: spaceId ?? '', linkedAt: iso(),
        lastNudgedAt: '', nudges: 'on', lang: 'en', currentTree: '',
      });
    } else {
      playerId = link.playerId;
      await mergePlayers(login.playerId, playerId); // keep what they did in the browser
    }
    await store.upsert('logins', { partitionKey: 'login', rowKey: login.rowKey, status: 'done', resultPlayerId: playerId, doneAt: iso() });
    res.json({ ok: true, playerId, ...(await playerSummary(playerId)) });
  }));

  // ---------- adopt a tree ----------

  const adopterCount = async (code) => (await links()).filter((l) => l.adopted === code).length;

  async function adopt(link, tree, { hello }) {
    await store.upsert('links', {
      partitionKey: 'link', rowKey: link.rowKey, adopted: tree.code, adoptedAt: iso(), lastNewsAt: iso(),
      pendingHello: hello ? 'yes' : '',
    });
    logEvent?.({ treeCode: tree.code, kind: 'adopt' });
  }

  async function composeTreeText(tree, r) {
    const persona = personaById.get(tree.persona);
    try {
      const timeout = new Promise((_, no) => setTimeout(() => no(new Error('slow')), 12000));
      const text = String(await Promise.race([askModel(buildTreeTextMessages(tree, persona, r)), timeout])).trim().replace(/^["']|["']$/g, '');
      if (text) return text.slice(0, 320);
    } catch (e) {
      console.warn('tree text fell back to a stock line:', e.message);
    }
    return cannedTreeText(r);
  }

  app.post('/api/trees/:code/adopt', wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    if (!(await visited(playerId, tree.code))) return bad(res, 'Wake this tree first, then you can adopt it.', 403);
    const link = await linkForPlayer(playerId);
    if (!link) return res.status(409).json({ error: 'Log in with your phone first, so the tree can text you.', needLogin: true });
    await adopt(link, tree, { hello: true }); // the tree says hi over iMessage within a minute
    res.json({ ok: true, adopted: tree.code, adopters: await adopterCount(tree.code) });
  }));

  photon.post('/links/:senderId/adopt', wrap(async (req, res) => {
    const link = await store.get('links', 'link', req.params.senderId);
    const tree = byCode.get(String(req.body?.code ?? '').toUpperCase());
    if (!link || !tree) return bad(res, 'unknown player or tree', 404);
    if (!(await visited(link.playerId, tree.code))) return bad(res, 'not awake', 403);
    await adopt(link, tree, { hello: false });
    res.json({ ok: true, text: await composeTreeText(tree, { reason: 'adopted' }), adopters: await adopterCount(tree.code) });
  }));

  // Texts trees want to send their adopters right now. Marked as sent before
  // they're returned, so nobody gets the same text twice.
  photon.get('/tree-texts', wrap(async (_req, res) => {
    const { day, hour } = nyClock(now());
    const out = [];
    let wx;
    for (const l of (await links()).filter((x) => x.adopted && byCode.has(x.adopted))) {
      const tree = byCode.get(l.adopted);
      const since = l.lastNewsAt || l.adoptedAt || '';
      const me = hashPlayer(l.playerId);
      const reasons = [];
      if (l.pendingHello === 'yes') reasons.push({ reason: 'adopted' });
      const reports = (await store.list('reports', tree.code))
        .filter((r) => r.timestamp > since && r.reporterHash !== me)
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      const problem = reports.filter((r) => r.flagType && r.flagType !== 'none').at(-1);
      if (problem) reasons.push({ reason: 'problem', detail: problem.flagType, confirmed: problem.status === 'confirmed' });
      const notes = (await store.list('notes', tree.code)).filter((n) => n.timestamp > since && n.authorHash !== me);
      if (notes.length) {
        const latest = notes.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)).at(-1);
        reasons.push(latest.audioUrl ? { reason: 'memory' } : { reason: 'note', detail: latest.text });
      }
      if (reports.some((r) => r.photoUrl)) reasons.push({ reason: 'photo' });
      // Remember the newest thing seen, so it's never mentioned twice.
      const seen = [iso(), ...reports.map((r) => r.timestamp), ...notes.map((n) => n.timestamp)].sort().at(-1);
      if (!reasons.length && l.weatherDay !== day && hour >= 9 && hour <= 20) {
        if (wx === undefined) wx = await currentWeather().catch(() => null);
        const w = weatherReason(wx);
        if (w) reasons.push(w);
      }
      if (!reasons.length) continue;
      const r = reasons[0]; // one text at a time, most important first
      const sentToday = l.textDay === day ? Number(l.textsToday || 0) : 0;
      const isWeather = !['adopted', 'problem', 'note', 'memory', 'photo'].includes(r.reason);
      const row = { partitionKey: 'link', rowKey: l.rowKey, lastNewsAt: seen, pendingHello: '' };
      if (isWeather) row.weatherDay = day;
      if (sentToday >= TREE_TEXTS_PER_DAY && r.reason !== 'adopted') {
        await store.upsert('links', row); // quiet for the rest of the day
        continue;
      }
      Object.assign(row, { textDay: day, textsToday: sentToday + 1 });
      await store.upsert('links', row);
      out.push({ senderId: l.rowKey, spaceId: l.spaceId, code: tree.code, reason: r.reason, text: await composeTreeText(tree, r) });
    }
    res.json(out);
  }));

  // ---------- photo quests and the explorer album ----------

  const activeQuests = () => {
    const m = now().getMonth() + 1;
    return quests.filter((q) => q.months.includes(m));
  };

  app.get('/api/quests', wrap(async (req, res) => {
    const playerId = String(req.query.playerId ?? '');
    const done = playerId ? new Set((await store.list('quests', playerId)).map((q) => q.rowKey)) : new Set();
    res.json(activeQuests().map((q) => ({ id: q.id, emoji: q.emoji, title: q.title, hint: q.hint, points: q.points, done: done.has(q.id) })));
  }));

  app.post('/api/quests/:id', upload.single('photo'), wrap(async (req, res) => {
    const quest = activeQuests().find((q) => q.id === req.params.id);
    if (!quest) return bad(res, 'That quest isn\'t running right now.', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    if (!req.file) return bad(res, 'Send a photo for the quest.');
    if (await store.get('quests', playerId, quest.id)) return bad(res, `You already finished "${quest.title}". Try another quest!`, 409);
    let check = null;
    if (questCheck) {
      try {
        check = await questCheck(req.file.buffer, req.file.mimetype, quest.check);
      } catch (e) {
        console.warn('quest check failed, accepting the photo:', e.message);
      }
    }
    if (check && (!check.match || check.confidence < 0.5)) return res.json({ ok: false, reason: check.reason || `That doesn't look like ${quest.check}.` });

    // The photo also goes to the tree's album and the grounds team's records.
    const visits = await store.list('visits', playerId);
    const lastVisit = [...visits].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    const tree = byCode.get(String(req.body.treeCode ?? '').toUpperCase()) ?? (lastVisit && byCode.get(lastVisit.rowKey)) ?? null;
    const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[req.file.mimetype] ?? 'jpg';
    const photoUrl = await photos.save(`${tree?.code ?? 'quests'}/${Date.now()}-${crypto.randomUUID()}.${ext}`, req.file.buffer, req.file.mimetype);
    const timestamp = iso();
    if (tree) {
      await store.upsert('reports', {
        partitionKey: tree.code, rowKey: crypto.randomUUID(), treeCode: tree.code, photoUrl, timestamp,
        flagType: 'none', flagSource: 'none', status: 'none', season: quest.season ?? '', quest: quest.id,
        reporterHash: hashPlayer(playerId), speciesGuess: '', confidence: null, speciesFeedback: '',
      });
      logEvent?.({ time: timestamp, treeCode: tree.code, kind: 'report', season: quest.season ?? null, hasPhoto: true });
    }
    await store.upsert('quests', { partitionKey: playerId, rowKey: quest.id, timestamp, photoUrl, treeCode: tree?.code ?? '' });
    await store.upsert('bonuses', { partitionKey: playerId, rowKey: `quest-${quest.id}`, treeCode: tree?.code ?? '', points: quest.points, timestamp });
    const summary = await playerSummary(playerId);
    res.status(201).json({ ok: true, quest: quest.id, points: quest.points, reason: check?.reason || 'Great shot!', treeName: tree?.name ?? null, totalPoints: summary.totalPoints });
  }));

  // Everything about a tree beyond its story: adopters, explorer photos, memories.
  app.get('/api/trees/:code/social', wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const playerId = String(req.query.playerId ?? '');
    const all = await links();
    const album = (await store.list('reports', tree.code))
      .filter((r) => r.photoUrl && !/\.hei[cf]$/i.test(r.photoUrl))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 12)
      .map((r) => ({ url: r.photoUrl, timestamp: r.timestamp, quest: r.quest || null }));
    res.json({
      adopters: all.filter((l) => l.adopted === tree.code).length,
      adoptedByMe: Boolean(playerId) && all.some((l) => l.playerId === playerId && l.adopted === tree.code),
      album,
    });
  }));

  // ---------- voice memories ----------

  app.post('/api/trees/:code/memories', audioUpload.single('audio'), wrap(async (req, res) => {
    const tree = byCode.get(req.params.code.toUpperCase());
    if (!tree) return bad(res, 'unknown tree', 404);
    const { playerId } = req.body ?? {};
    if (!requirePlayer(playerId, res)) return;
    if (!req.file) return bad(res, 'Record a memory first.');
    if (!(await visited(playerId, tree.code))) return bad(res, 'Wake this tree first, then you can leave it a memory.', 403);
    if (!memoryLimit(`mem:${playerId}`)) return bad(res, 'That\'s a lot of memories. Try again later.', 429);

    let audio = req.file.buffer;
    let type = req.file.mimetype;
    try {
      audio = await convert.toM4a(req.file.buffer); // plays everywhere, iMessage included
      type = 'audio/mp4';
    } catch (e) {
      console.warn('could not convert the memory, keeping the original:', e.message);
    }
    let heard = null;
    if (listen) {
      try {
        heard = await listen(await convert.toMp3(req.file.buffer), 'audio/mp3');
      } catch (e) {
        console.warn('could not listen to the memory:', e.message);
      }
    }
    if (heard && !heard.safe) return bad(res, 'That memory can\'t be shared with everyone. Try another one?', 422);
    const ext = type === 'audio/mp4' ? 'm4a' : (type.split('/')[1] || 'audio').replace(/[^a-z0-9]/gi, '');
    const timestamp = iso();
    const audioUrl = await photos.save(`memories/${tree.code}/${Date.now()}-${crypto.randomUUID()}.${ext}`, audio, type);
    const note = {
      partitionKey: tree.code, rowKey: `${timestamp}-${crypto.randomUUID().slice(0, 8)}`,
      text: heard?.transcript || 'A voice memory', name: String(req.body.name ?? '').trim().slice(0, 24),
      timestamp, authorHash: hashPlayer(playerId), flags: 0, audioUrl,
    };
    await store.upsert('notes', note);
    res.status(201).json({ id: note.rowKey, text: note.text, audioUrl, timestamp });
  }));

  // The newest memory someone else left at a tree (played when you wake it).
  photon.get('/trees/:code/memory', wrap(async (req, res) => {
    const code = req.params.code.toUpperCase();
    const link = await store.get('links', 'link', String(req.query.senderId ?? ''));
    const me = link ? hashPlayer(link.playerId) : '';
    const memory = (await store.list('notes', code))
      .filter((n) => n.audioUrl && n.authorHash !== me && (n.flags ?? 0) < 3)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    if (!memory) return bad(res, 'no memories', 404);
    res.json({ text: memory.text, audioUrl: memory.audioUrl, name: memory.name });
  }));
}
