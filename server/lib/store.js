import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

// One tiny key/value-ish interface over two backends:
//   - local JSON files (default, zero setup, good for dev and the demo laptop)
//   - Azure Table Storage (when AZURE_STORAGE_CONNECTION_STRING is set)
// Every entity has partitionKey + rowKey and only flat primitive fields.
//
// Tables used:
//   visits    pk = playerId,  rk = treeCode
//   reports   pk = treeCode,  rk = reportId
//   linkcodes pk = 'code',    rk = short code shown on the website
//   links     pk = 'link',    rk = Photon sender id

export class JsonStore {
  constructor(dir = path.join(ROOT, '.data')) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  #file(table) {
    return path.join(this.dir, `${table}.json`);
  }

  #load(table) {
    if (!this.cache.has(table)) {
      const f = this.#file(table);
      this.cache.set(table, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
    }
    return this.cache.get(table);
  }

  #save(table) {
    const f = this.#file(table);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.#load(table), null, 2));
    fs.renameSync(`${f}.tmp`, f);
  }

  async upsert(table, entity) {
    const rows = this.#load(table);
    const key = `${entity.partitionKey}\u0000${entity.rowKey}`;
    rows[key] = { ...rows[key], ...entity };
    this.#save(table);
    return rows[key];
  }

  async get(table, partitionKey, rowKey) {
    return this.#load(table)[`${partitionKey}\u0000${rowKey}`] ?? null;
  }

  async list(table, partitionKey) {
    const all = Object.values(this.#load(table));
    return partitionKey === undefined ? all : all.filter((e) => e.partitionKey === partitionKey);
  }

  async remove(table, partitionKey, rowKey) {
    delete this.#load(table)[`${partitionKey}\u0000${rowKey}`];
    this.#save(table);
  }
}

export class AzureTableStore {
  constructor(connectionString, prefix = 'treedetective') {
    this.connectionString = connectionString;
    this.prefix = prefix.replace(/[^A-Za-z0-9]/g, '');
    this.clients = new Map();
  }

  async #client(table) {
    if (!this.clients.has(table)) {
      const { TableClient } = await import('@azure/data-tables');
      const client = TableClient.fromConnectionString(this.connectionString, `${this.prefix}${table}`);
      await client.createTable().catch((e) => {
        if (e.statusCode !== 409) throw e;
      });
      this.clients.set(table, client);
    }
    return this.clients.get(table);
  }

  #clean(e) {
    if (!e) return null;
    const { etag, timestamp, 'odata.metadata': _m, ...rest } = e;
    return rest;
  }

  async upsert(table, entity) {
    const c = await this.#client(table);
    // Table Storage has no null type; leave empty fields out instead.
    const clean = Object.fromEntries(Object.entries(entity).filter(([, v]) => v !== null && v !== undefined));
    await c.upsertEntity(clean, 'Merge');
    return this.get(table, entity.partitionKey, entity.rowKey);
  }

  async get(table, partitionKey, rowKey) {
    const c = await this.#client(table);
    try {
      return this.#clean(await c.getEntity(partitionKey, rowKey));
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  async list(table, partitionKey) {
    const c = await this.#client(table);
    const { odata } = await import('@azure/data-tables');
    const opts = partitionKey === undefined ? {} : { queryOptions: { filter: odata`PartitionKey eq ${partitionKey}` } };
    const out = [];
    for await (const e of c.listEntities(opts)) out.push(this.#clean(e));
    return out;
  }

  async remove(table, partitionKey, rowKey) {
    const c = await this.#client(table);
    await c.deleteEntity(partitionKey, rowKey).catch((e) => {
      if (e.statusCode !== 404) throw e;
    });
  }
}

export function createStore(env = process.env) {
  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    return new AzureTableStore(env.AZURE_STORAGE_CONNECTION_STRING, env.AZURE_TABLE_PREFIX);
  }
  return new JsonStore(env.DATA_DIR || undefined);
}
