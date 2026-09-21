/**
 * storage.js
 * -----------------------------------------------------------------------
 * Storage abstraction for the app. Everything the app persists goes
 * through this service. For the MVP it wraps localStorage, but the
 * public API is deliberately small and Promise-based so the backing
 * store can later be swapped for Telegram CloudStorage or a real
 * backend/database without touching any other file.
 *
 * Swap points:
 *   - Telegram CloudStorage: window.Telegram.WebApp.CloudStorage
 *     (getItem/setItem/removeItem/getKeys are all async with callbacks,
 *     which is why this service already returns Promises).
 *   - A backend/database: replace the three methods below with fetch()
 *     calls to your API, keeping the same method signatures.
 * -----------------------------------------------------------------------
 */
(function (global) {
  const NAMESPACE = 'vocabapp:v1:';

  class LocalStorageBackend {
    async get(key) {
      try {
        const raw = window.localStorage.getItem(NAMESPACE + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.error('StorageService.get failed', key, e);
        return null;
      }
    }

    async set(key, value) {
      try {
        window.localStorage.setItem(NAMESPACE + key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.error('StorageService.set failed', key, e);
        return false;
      }
    }

    async remove(key) {
      try {
        window.localStorage.removeItem(NAMESPACE + key);
        return true;
      } catch (e) {
        console.error('StorageService.remove failed', key, e);
        return false;
      }
    }
  }

  // Placeholder for a future Telegram CloudStorage-backed implementation.
  // Left unused for the MVP, kept here so the swap is a one-line change
  // in StorageService.create() below.
  class TelegramCloudStorageBackend {
    constructor(cloudStorage) {
      this.cloud = cloudStorage;
    }
    get(key) {
      return new Promise((resolve) => {
        this.cloud.getItem(NAMESPACE + key, (err, value) => {
          if (err || !value) return resolve(null);
          try { resolve(JSON.parse(value)); } catch { resolve(null); }
        });
      });
    }
    set(key, value) {
      return new Promise((resolve) => {
        this.cloud.setItem(NAMESPACE + key, JSON.stringify(value), (err, ok) => {
          resolve(!err && ok);
        });
      });
    }
    remove(key) {
      return new Promise((resolve) => {
        this.cloud.removeItem(NAMESPACE + key, (err, ok) => resolve(!err && ok));
      });
    }
  }

  class StorageService {
    constructor(backend) {
      this.backend = backend;
    }

    static create() {
      // MVP: always localStorage. To try Telegram CloudStorage instead:
      //   const tg = window.Telegram && window.Telegram.WebApp;
      //   if (tg && tg.CloudStorage) return new StorageService(new TelegramCloudStorageBackend(tg.CloudStorage));
      return new StorageService(new LocalStorageBackend());
    }

    getTerms() { return this.backend.get('terms').then((v) => v || []); }
    setTerms(terms) { return this.backend.set('terms', terms); }

    getMeta() { return this.backend.get('meta').then((v) => v || null); }
    setMeta(meta) { return this.backend.set('meta', meta); }

    getSettings() {
      return this.backend.get('settings').then((v) => v || {
        intervalsDays: [1, 2, 4, 7, 14, 21, 30, 45, 60, 90],
        masteryToLearn: 10
      });
    }
    setSettings(settings) { return this.backend.set('settings', settings); }

    async clearAll() {
      await this.backend.remove('terms');
      await this.backend.remove('meta');
      // settings are intentionally kept across resets
    }
  }

  global.VocabStorage = { StorageService };
})(window);
