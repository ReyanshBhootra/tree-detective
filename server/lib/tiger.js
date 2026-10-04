// TigerData (Postgres + TimescaleDB + pgvector/pgvectorscale).
//   - events: a hypertable of every visit, report and season sighting, so the
//     grounds dashboard can ask "what changed week by week" in one query
//   - facts: sourced history snippets with embeddings, so "Ask me something"
//     can pull the most relevant sourced facts for each question
// Everything here is optional: without TIGER_DATABASE_URL the app falls back
// to the same numbers computed in JS, and Ask uses the tree's own fact file.

export const EMBEDDING_DIMS = 1536; // text-embedding-3-small

export const SCHEMA = [
  'CREATE EXTENSION IF NOT EXISTS timescaledb',
  'CREATE EXTENSION IF NOT EXISTS vector',
  `CREATE TABLE IF NOT EXISTS events (
     time timestamptz NOT NULL,
     tree_code text NOT NULL,
     kind text NOT NULL,          -- visit | report | season
     flag_type text,
     season text,
     has_photo boolean DEFAULT false
   )`,
  "SELECT create_hypertable('events', by_range('time'), if_not_exists => TRUE)",
  'CREATE INDEX IF NOT EXISTS events_tree_time ON events (tree_code, time DESC)',
  `CREATE TABLE IF NOT EXISTS facts (
     id text PRIMARY KEY,
     tree_code text,              -- NULL = about campus in general, any tree may use it
     text text NOT NULL,
     label text NOT NULL,
     source_url text NOT NULL,
     source_note text,
     embedding vector(${EMBEDDING_DIMS}) NOT NULL
   )`,
];

// pgvectorscale's DiskANN index when the extension is there, plain pgvector otherwise.
export const VECTOR_INDEX = [
  ['CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE', 'CREATE INDEX IF NOT EXISTS facts_embedding ON facts USING diskann (embedding vector_cosine_ops)'],
  [null, 'CREATE INDEX IF NOT EXISTS facts_embedding ON facts USING hnsw (embedding vector_cosine_ops)'],
];

export const SQL = {
  insertEvent: 'INSERT INTO events (time, tree_code, kind, flag_type, season, has_photo) VALUES ($1, $2, $3, $4, $5, $6)',
  trends: `SELECT time_bucket('1 week', time)::date AS week,
                  count(*) FILTER (WHERE kind = 'visit') AS visits,
                  count(*) FILTER (WHERE kind = 'report') AS reports,
                  count(*) FILTER (WHERE season IS NOT NULL AND season <> '') AS seasons,
                  count(*) FILTER (WHERE flag_type = 'pest') AS pest,
                  count(*) FILTER (WHERE flag_type = 'damage') AS damage,
                  count(*) FILTER (WHERE flag_type = 'dying') AS dying
             FROM events
            WHERE time > now() - make_interval(weeks => $1)
            GROUP BY week ORDER BY week`,
  seasonTimeline: `SELECT tree_code, season, extract(year FROM time)::int AS year, min(time) AS first_seen
                     FROM events WHERE season IS NOT NULL AND season <> ''
                    GROUP BY tree_code, season, year ORDER BY first_seen`,
  searchFacts: `SELECT text, label, source_url, source_note, tree_code, embedding <=> $2::vector AS distance
                  FROM facts WHERE tree_code = $1 OR tree_code IS NULL
                 ORDER BY embedding <=> $2::vector LIMIT $3`,
  upsertFact: `INSERT INTO facts (id, tree_code, text, label, source_url, source_note, embedding)
               VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
               ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, label = EXCLUDED.label,
                 source_url = EXCLUDED.source_url, source_note = EXCLUDED.source_note, embedding = EXCLUDED.embedding`,
};

export const toVector = (arr) => `[${arr.join(',')}]`;

export function createTiger(env = process.env, { pool } = {}) {
  if (!env.TIGER_DATABASE_URL && !pool) return null;
  let db = pool;
  let ready;

  async function getPool() {
    if (!db) {
      const { default: pg } = await import('pg');
      db = new pg.Pool({ connectionString: env.TIGER_DATABASE_URL, max: 4 });
    }
    return db;
  }

  async function init() {
    ready ??= (async () => {
      const p = await getPool();
      for (const sql of SCHEMA) await p.query(sql);
      for (const [ext, index] of VECTOR_INDEX) {
        try {
          if (ext) await p.query(ext);
          await p.query(index);
          break;
        } catch { /* try the next option */ }
      }
    })().catch((e) => {
      ready = undefined;
      throw e;
    });
    return ready;
  }

  return {
    init,
    async logEvent({ time = new Date().toISOString(), treeCode, kind, flagType = null, season = null, hasPhoto = false }) {
      await init();
      await (await getPool()).query(SQL.insertEvent, [time, treeCode, kind, flagType, season, hasPhoto]);
    },
    async trends(weeks = 8) {
      await init();
      const { rows } = await (await getPool()).query(SQL.trends, [weeks]);
      return rows.map((r) => ({
        week: new Date(r.week).toISOString().slice(0, 10),
        visits: Number(r.visits), reports: Number(r.reports), seasons: Number(r.seasons),
        flags: { pest: Number(r.pest), damage: Number(r.damage), dying: Number(r.dying) },
      }));
    },
    async seasonTimeline() {
      await init();
      const { rows } = await (await getPool()).query(SQL.seasonTimeline);
      return rows.map((r) => ({ treeCode: r.tree_code, season: r.season, year: r.year, firstSeen: new Date(r.first_seen).toISOString() }));
    },
    async searchFacts(treeCode, embedding, k = 5) {
      await init();
      const { rows } = await (await getPool()).query(SQL.searchFacts, [treeCode, toVector(embedding), k]);
      return rows;
    },
    async upsertFact(f) {
      await init();
      await (await getPool()).query(SQL.upsertFact, [f.id, f.treeCode ?? null, f.text, f.label, f.sourceUrl, f.sourceNote ?? '', toVector(f.embedding)]);
    },
    async close() {
      await db?.end();
    },
  };
}
