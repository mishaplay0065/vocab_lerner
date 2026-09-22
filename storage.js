/**
 * storage.js
 * -----------------------------------------------------------------------
 * Two layers:
 *
 *   1. A low-level key/value backend (Promise-based get/set/remove) —
 *      either Telegram.WebApp.CloudStorage (for cross-device sync) or
 *      localStorage (fallback for local browser testing / when the app
 *      is opened outside Telegram).
 *
 *   2. VocabStore — the domain API app.js actually talks to: manage
 *      multiple vocabulary sets, load/save a set's terms, track the
 *      active set, read/write settings.
 *
 * Telegram CloudStorage has hard limits (Bot API 6.9+):
 *   - up to 1024 keys total
 *   - each key: 1-128 chars, only [A-Za-z0-9_-]
 *   - each value: 0-4096 characters
 * A vocabulary set can easily outgrow a single 4096-char value, so each
 * set's terms are split into small JSON chunks stored under their own
 * keys (see CHUNK_CHAR_LIMIT below), and the set's index keeps track of
 * how many chunks it has. The same chunking is used for the localStorage
 * backend too, so behaviour is identical in both environments.
 * -----------------------------------------------------------------------
 */
(function (global) {

  const KEY_PREFIX = 'vocabapp_v2_';
  const CHUNK_CHAR_LIMIT = 3500; // safety margin under Telegram's 4096 limit

  // ---------------------------------------------------------------------
  // Low-level backends
  // ---------------------------------------------------------------------
  class LocalStorageBackend {
    constructor() { this.name = 'local'; }

    async getItem(key) {
      try { return window.localStorage.getItem(KEY_PREFIX + key); }
      catch (e) { console.error('localStorage getItem failed', e); return null; }
    }

    async getItems(keys) {
      const out = {};
      for (const k of keys) out[k] = await this.getItem(k);
      return out;
    }

    async setItem(key, value) {
      try { window.localStorage.setItem(KEY_PREFIX + key, value); return true; }
      catch (e) { console.error('localStorage setItem failed', e); return false; }
    }

    async removeItems(keys) {
      try { keys.forEach((k) => window.localStorage.removeItem(KEY_PREFIX + k)); return true; }
      catch (e) { console.error('localStorage removeItems failed', e); return false; }
    }
  }

  class CloudStorageBackend {
    constructor(cloudStorage) {
      this.name = 'cloud';
      this.cloud = cloudStorage;
    }

    getItem(key) {
      return new Promise((resolve) => {
        try {
          this.cloud.getItem(key, (err, value) => {
            if (err) { console.error('CloudStorage getItem error', err); resolve(null); return; }
            resolve(value || null);
          });
        } catch (e) { console.error('CloudStorage getItem threw', e); resolve(null); }
      });
    }

    getItems(keys) {
      if (keys.length === 0) return Promise.resolve({});
      return new Promise((resolve) => {
        try {
          this.cloud.getItems(keys, (err, values) => {
            if (err) { console.error('CloudStorage getItems error', err); resolve({}); return; }
            // Official API returns {key: value}; be defensive in case a
            // client implementation returns a parallel array instead.
            if (Array.isArray(values)) {
              const out = {};
              keys.forEach((k, i) => { out[k] = values[i] || null; });
              resolve(out);
            } else {
              resolve(values || {});
            }
          });
        } catch (e) { console.error('CloudStorage getItems threw', e); resolve({}); }
      });
    }

    setItem(key, value) {
      return new Promise((resolve) => {
        try {
          this.cloud.setItem(key, value, (err, ok) => {
            if (err) console.error('CloudStorage setItem error', err);
            resolve(!err && ok !== false);
          });
        } catch (e) { console.error('CloudStorage setItem threw', e); resolve(false); }
      });
    }

    removeItems(keys) {
      if (keys.length === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        try {
          this.cloud.removeItems(keys, (err, ok) => {
            if (err) console.error('CloudStorage removeItems error', err);
            resolve(!err && ok !== false);
          });
        } catch (e) { console.error('CloudStorage removeItems threw', e); resolve(false); }
      });
    }
  }

  function detectBackend() {
    try {
      const tg = global.Telegram && global.Telegram.WebApp;
      const cs = tg && tg.CloudStorage;
      if (cs && typeof cs.setItem === 'function' && typeof cs.getItem === 'function') {
        return new CloudStorageBackend(cs);
      }
    } catch (e) { /* fall through to localStorage */ }
    return new LocalStorageBackend();
  }

  // ---------------------------------------------------------------------
  // Chunking helpers
  // ---------------------------------------------------------------------
  function packIntoChunks(terms) {
    const chunks = [];
    let current = [];
    let currentLen = 2; // "[]"
    for (const term of terms) {
      const piece = JSON.stringify(term);
      const addedLen = piece.length + 1; // + comma/bracket overhead
      if (current.length > 0 && currentLen + addedLen > CHUNK_CHAR_LIMIT) {
        chunks.push(current);
        current = [];
        currentLen = 2;
      }
      current.push(term);
      currentLen += addedLen;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  // ---------------------------------------------------------------------
  // Domain store
  // ---------------------------------------------------------------------
  class VocabStore {
    constructor(backend) {
      this.backend = backend;
    }

    static async create() {
      return new VocabStore(detectBackend());
    }

    get backendName() { return this.backend.name; }

    // ---- settings ----
    async getSettings() {
      const raw = await this.backend.getItem('settings');
      if (!raw) return { intervalsDays: [1, 2, 4, 7, 14, 21, 30, 45, 60, 90], masteryToLearn: 10 };
      try { return JSON.parse(raw); } catch { return { intervalsDays: [1, 2, 4, 7, 14, 21, 30, 45, 60, 90], masteryToLearn: 10 }; }
    }
    async setSettings(settings) { return this.backend.setItem('settings', JSON.stringify(settings)); }

    // ---- sets index ----
    async listSets() {
      const raw = await this.backend.getItem('sets_index');
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return []; }
    }
    async _saveSetsIndex(list) { return this.backend.setItem('sets_index', JSON.stringify(list)); }

    async getActiveSetId() {
      const raw = await this.backend.getItem('active_set');
      return raw || null;
    }
    async setActiveSetId(id) { return this.backend.setItem('active_set', id); }

    _newId() {
      return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2))
        .replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    /** Creates a new set from already-built term objects (see srs.makeTerm). */
    async createSet(name, terms) {
      const id = this._newId();
      const chunks = packIntoChunks(terms);
      await Promise.all(chunks.map((chunk, idx) =>
        this.backend.setItem(`s_${id}_${idx}`, JSON.stringify(chunk))
      ));
      const sets = await this.listSets();
      sets.push({ id, name, createdAt: Date.now(), termCount: terms.length, chunkCount: Math.max(chunks.length, 1) });
      await this._saveSetsIndex(sets);
      await this.setActiveSetId(id);
      return id;
    }

    async renameSet(id, name) {
      const sets = await this.listSets();
      const entry = sets.find((s) => s.id === id);
      if (!entry) return false;
      entry.name = name;
      await this._saveSetsIndex(sets);
      return true;
    }

    async deleteSet(id) {
      const sets = await this.listSets();
      const entry = sets.find((s) => s.id === id);
      if (!entry) return false;
      const keys = Array.from({ length: entry.chunkCount }, (_, i) => `s_${id}_${i}`);
      await this.backend.removeItems(keys);
      const remaining = sets.filter((s) => s.id !== id);
      await this._saveSetsIndex(remaining);
      const active = await this.getActiveSetId();
      if (active === id) {
        await this.setActiveSetId(remaining.length ? remaining[0].id : '');
      }
      return true;
    }

    /**
     * Loads every term in a set, plus a map of termId -> chunk index so
     * app.js can persist a single changed term by rewriting only its own
     * chunk instead of the whole set.
     */
    async loadSetTerms(id) {
      const sets = await this.listSets();
      const entry = sets.find((s) => s.id === id);
      if (!entry) return { terms: [], chunkMap: new Map(), chunkCount: 0 };

      const keys = Array.from({ length: entry.chunkCount }, (_, i) => `s_${id}_${i}`);
      const values = await this.backend.getItems(keys);
      const terms = [];
      const chunkMap = new Map();

      keys.forEach((key, idx) => {
        const raw = values[key];
        if (!raw) return;
        let chunk = [];
        try { chunk = JSON.parse(raw); } catch { chunk = []; }
        chunk.forEach((t) => { terms.push(t); chunkMap.set(t.id, idx); });
      });

      return { terms, chunkMap, chunkCount: entry.chunkCount };
    }

    /** Rewrites a single chunk of a set (used after scoring one term). */
    async saveChunk(setId, chunkIndex, chunkTerms) {
      return this.backend.setItem(`s_${setId}_${chunkIndex}`, JSON.stringify(chunkTerms));
    }

    /** Updates termCount stat on the set index (cosmetic, best-effort). */
    async touchSetStats(id, termCount) {
      const sets = await this.listSets();
      const entry = sets.find((s) => s.id === id);
      if (!entry) return;
      entry.termCount = termCount;
      await this._saveSetsIndex(sets);
    }
  }

  global.VocabStorage = { VocabStore };
})(window);
