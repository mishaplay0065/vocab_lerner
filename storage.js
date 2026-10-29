/** Copy-on-write storage with bounded operations; legacy v2 sets stay readable. */
(function (global) {
  const PREFIX = 'vocabapp_v2_', PART_SIZE = 3500, MAX_PARTS = 900;
  const INTERVALS = [1,3,7,14,30];
  class StorageError extends Error {
    constructor(message, code = 'storage') { super(message); this.name = 'StorageError'; this.code = code; }
  }
  class LocalStorageBackend {
    constructor() { this.name = 'local'; }
    async getItem(key) { try { return global.localStorage.getItem(PREFIX + key); } catch { throw new StorageError('Хранилище браузера недоступно.'); } }
    async getItems(keys) { return Object.fromEntries(await Promise.all(keys.map(async key => [key, await this.getItem(key)]))); }
    async setItem(key, value) { try { global.localStorage.setItem(PREFIX + key, value); return true; } catch { return false; } }
    async removeItems(keys) { try { keys.forEach(key => global.localStorage.removeItem(PREFIX + key)); return true; } catch { return false; } }
    async getKeys() {
      try { return Array.from({length:global.localStorage.length},(_,i)=>global.localStorage.key(i)).filter(key=>key?.startsWith(PREFIX)).map(key=>key.slice(PREFIX.length)); }
      catch { throw new StorageError('Хранилище браузера недоступно.'); }
    }
  }
  class CloudStorageBackend {
    constructor(cloud, timeoutMs = 8000) { this.name = 'cloud'; this.cloud = cloud; this.timeoutMs = timeoutMs; }
    _call(method, args) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { settled = true; reject(new StorageError('Telegram не ответил вовремя. Проверь соединение и обнови страницу перед повторной попыткой.', 'timeout')); }, this.timeoutMs);
        const done = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (error) reject(new StorageError('Не удалось обратиться к хранилищу Telegram.'));
          else resolve(value);
        };
        try { this.cloud[method](...args, done); } catch (error) { done(error); }
      });
    }
    async getItem(key) { return await this._call('getItem', [key]) || null; }
    async getKeys() { return await this._call('getKeys', []); }
    async getItems(keys) {
      const out = {};
      for (let i = 0; i < keys.length; i += 50) {
        const batch = keys.slice(i, i + 50), values = await this._call('getItems', [batch]);
        if (Array.isArray(values)) batch.forEach((key, j) => { out[key] = values[j]; });
        else Object.assign(out, values || {});
      }
      return out;
    }
    async setItem(key, value) {
      if (value.length > 4096) throw new StorageError('Запись слишком большая для Telegram.', 'limit');
      return await this._call('setItem', [key, value]) !== false;
    }
    async removeItems(keys) {
      for (let i = 0; i < keys.length; i += 50) if (await this._call('removeItems', [keys.slice(i, i + 50)]) === false) return false;
      return true;
    }
  }
  function detectBackend() {
    const tg = global.Telegram?.WebApp;
    const telegramLaunch = /(?:^|[&#?])tgWebAppData=/.test((global.location?.hash || '') + (global.location?.search || ''));
    if (tg?.initData || telegramLaunch) {
      if (!(tg?.initData && tg.isVersionAtLeast?.('6.9') && tg.CloudStorage?.getKeys && tg.CloudStorage?.setItem && tg.CloudStorage?.getItems))
        throw new StorageError('Хранилище Telegram ещё недоступно. Обнови Telegram или повтори загрузку. Локальные данные не подменяют облачные.', 'telegram_unavailable');
      return new CloudStorageBackend(tg.CloudStorage);
    }
    return new LocalStorageBackend();
  }
  function parse(raw, fallback) { try { return JSON.parse(raw); } catch { return fallback; } }
  function split(text) {
    const parts = [];
    for (let i = 0; i < text.length; i += PART_SIZE) parts.push(text.slice(i, i + PART_SIZE));
    if (parts.length > MAX_PARTS) throw new StorageError('Слишком много данных. Раздели словарь на меньшие наборы.', 'limit');
    return parts;
  }
  function validEntry(set) {
    return set && typeof set.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(set.id) && typeof set.name === 'string' &&
      Number.isInteger(set.chunkCount) && set.chunkCount > 0 && set.chunkCount <= MAX_PARTS &&
      Number.isInteger(set.termCount) && set.termCount >= 0 && (!set.dataId || /^[A-Za-z0-9_-]{1,80}$/.test(set.dataId));
  }
  class VocabStore {
    constructor(backend, options = {}) {
      this.backend = backend; this._tail = Promise.resolve(); this._indexKeys = []; this._baseCache = new Map();
      const account=global.Telegram?.WebApp?.initDataUnsafe?.user?.id || 'browser';
      this._activityBackupKey=`vocab_activity_backup_${backend.name}_${account}`;
      const deviceKey=`vocab_activity_device_${backend.name}_${account}`;
      let device=options.deviceId;
      try { device ||= global.localStorage?.getItem(deviceKey); } catch { /* private mode */ }
      this._deviceId=/^[a-zA-Z0-9_-]{1,80}$/.test(device || '') ? device : this._newId();
      try { global.localStorage?.setItem(deviceKey,this._deviceId); } catch { /* session-only identity */ }
      this._activityWritten=new Map();
    }
    static async create() { return new VocabStore(detectBackend()); }
    get backendName() { return this.backend.name; }
    _newId() { return (global.crypto.randomUUID ? global.crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2)).replace(/[^a-zA-Z0-9_-]/g, '-'); }
    _mutate(operation) {
      const guarded = async () => {
        if (this._uncertain) throw new StorageError('Результат предыдущего сохранения неизвестен. Обнови страницу перед следующей записью.', 'timeout');
        return operation();
      };
      const run = () => global.navigator?.locks?.request
        ? global.navigator.locks.request('vocab-storage-write', guarded) : guarded();
      const result = this._tail.catch(() => {}).then(run);
      this._tail = result.catch(() => {});
      return result;
    }
    async _write(key, value) {
      try {
        if (!await this.backend.setItem(key, value)) throw new StorageError('Не удалось сохранить данные. Возможно, хранилище заполнено.', 'write');
      } catch (error) { if (error.code === 'timeout') this._uncertain = true; throw error; }
    }
    async _cleanup(keys) { try { if (keys.length && !await this.backend.removeItems(keys)) console.warn('Unused storage parts remain', keys.length); else if(this._keyList) this._keyList=this._keyList.filter(key=>!keys.includes(key)); } catch (error) { console.warn('Storage cleanup failed', error); } }
    async _keys(force=false) {
      if(force || !this._keyList || Date.now()-(this._keyReadAt || 0)>5000) {this._keyList=await this.backend.getKeys();this._keyReadAt=Date.now();}
      return this._keyList;
    }
    async getSettings() {
      const value = parse(await this.backend.getItem('settings'), null), intervals = value?.intervalsDays;
      return { intervalsDays:Array.isArray(intervals) && intervals.length === INTERVALS.length &&
        intervals.every((day, i) => Number.isFinite(day) && day > 0 && (!i || day >= intervals[i - 1])) ? intervals : INTERVALS.slice(), masteryToLearn:INTERVALS.length };
    }
    async setSettings(value) { return this._mutate(async () => { await this._write('settings', JSON.stringify(value)); return true; }); }
    async getActivity() {
      const Srs=global.VocabSrs;
      const keys=(await this._keys(true)).filter(key=>/^act_[a-zA-Z0-9_-]+_\d{6}$/.test(key));
      const values=await this.backend.getItems(['activity','activity_goal',...keys]);
      const sources={}, legacyDays={}, inferredDays=[];let legacyLongest=0;
      keys.forEach(key=>{
        const match=key.match(/^act_(.+)_(\d{4})(\d{2})$/), value=parse(values[key],null);
        if (!value || value.version!==3) throw new StorageError('История занятий повреждена. Резервная копия сохранена.', 'damaged');
        const expand=days=>Object.fromEntries(Object.entries(days || {}).map(([day,count])=>[`${match[2]}-${match[3]}-${day}`,count]));
        sources[match[1]]={...(sources[match[1]] || {}),...expand(value.days)};
        Object.entries(expand(value.legacy)).forEach(([day,count])=>{legacyDays[day]=Math.max(legacyDays[day] || 0,count);});
        (Array.isArray(value.inferred) ? value.inferred : []).forEach(day=>inferredDays.push(`${match[2]}-${match[3]}-${day}`));
        legacyLongest=Math.max(legacyLongest,Number(value.legacyLongest) || 0);
        if(match[1]===this._deviceId) this._activityWritten.set(key,values[key]);
      });
      let backup=null;
      try { backup=parse(global.localStorage?.getItem(this._activityBackupKey),null); } catch { /* unavailable */ }
      const result=Srs.mergeActivity(parse(values.activity,null), {version:3,sources,legacyDays,inferredDays,legacyLongest},parse(values.activity_goal,null),backup,this._activityCache);
      this._activityCache={...result,sourceId:this._deviceId};
      this._backupActivity();
      return this._activityCache;
    }
    _backupActivity() {
      try { global.localStorage?.setItem(this._activityBackupKey,JSON.stringify(this._activityCache)); } catch { /* pending journal is a second backup */ }
    }
    async _writeIdempotent(key,value) {
      try {
        if (!await this.backend.setItem(key,value)) throw new StorageError('Не удалось сохранить прогресс.', 'write');
      } catch(error) {
        // A lost callback isn't a lost write. Verify before showing a failure.
        if (error.code!=='timeout' || await this.backend.getItem(key).catch(()=>null)!==value) throw error;
      }
      if(this._keyList && !this._keyList.includes(key)) this._keyList.push(key);
    }
    async setActivity(value) {
      // Separate queue: a failed dictionary write must not prevent the streak from saving.
      const save=async()=>{
        this._activityCache={...global.VocabSrs.mergeActivity(this._activityCache,value),sourceId:this._deviceId};
        this._backupActivity();
        const activity=this._activityCache, own=activity.sources[this._deviceId] || {}, months=new Map();
        for(const day of new Set([...Object.keys(own),...Object.keys(activity.legacyDays)])) {
          const month=day.slice(0,7).replace('-',''), entry=months.get(month) || {version:3,days:{},legacy:{},inferred:[],legacyLongest:activity.legacyLongest};
          if(own[day]) entry.days[day.slice(8)]=own[day];
          if(activity.legacyDays[day]) entry.legacy[day.slice(8)]=activity.legacyDays[day];
          if(activity.inferredDays.includes(day)) entry.inferred.push(day.slice(8));
          months.set(month,entry);
        }
        for(const [month,entry] of months) {
          const key=`act_${this._deviceId}_${month}`;
          if(this._activityWritten.get(key)===JSON.stringify(entry)) continue;
          // A second tab on this device may already have saved another day.
          const raw=await this.backend.getItem(key), existing=raw ? parse(raw,null) : null;
          if(raw && (!existing || existing.version!==3)) throw new StorageError('История занятий повреждена. Данные не перезаписаны.', 'damaged');
          for(const field of ['days','legacy']) Object.entries(existing?.[field] || {}).forEach(([day,count])=>{entry[field][day]=Math.max(entry[field][day] || 0,count);});
          entry.inferred=[...new Set([...entry.inferred,...(existing?.inferred || [])])].sort();
          entry.legacyLongest=Math.max(entry.legacyLongest,existing?.legacyLongest || 0);
          const serialized=JSON.stringify(entry);
          await this._writeIdempotent(key,serialized);this._activityWritten.set(key,serialized);
        }
        if(activity.goalUpdatedAt) {
          const goal=JSON.stringify({version:3,dailyGoal:activity.dailyGoal,goalUpdatedAt:activity.goalUpdatedAt});
          if(this._activityWritten.get('activity_goal')!==goal) {await this._writeIdempotent('activity_goal',goal);this._activityWritten.set('activity_goal',goal);}
        }
        return true;
      };
      const run=()=>global.navigator?.locks?.request ? global.navigator.locks.request('vocab-activity-'+this._deviceId,save) : save();
      const result=(this._activityTail || Promise.resolve()).catch(()=>{}).then(run);
      this._activityTail=result.catch(()=>{});return result;
    }
    async listSets() {
      const raw = await this.backend.getItem('sets_index');
      if (!raw) { this._indexKeys = []; return []; }
      let list = parse(raw, null);
      if (list?.version === 3 && /^[A-Za-z0-9_-]{1,80}$/.test(list.generation) && Number.isInteger(list.pageCount) && list.pageCount > 0 && list.pageCount <= MAX_PARTS) {
        const keys = Array.from({length:list.pageCount}, (_, i) => 'index_' + list.generation + '_' + i);
        const values = await this.backend.getItems(keys);
        if (keys.some(key => typeof values[key] !== 'string')) throw new StorageError('Часть списка наборов отсутствует. Данные не будут перезаписаны.', 'damaged');
        list = parse(keys.map(key => values[key]).join(''), null); this._indexKeys = keys;
      } else this._indexKeys = [];
      if (!Array.isArray(list) || !list.every(validEntry) || new Set(list.map(set => set.id)).size !== list.length)
        throw new StorageError('Список наборов повреждён. Данные сохранены без изменений.', 'damaged');
      return list;
    }
    async _saveSetsIndex(list) {
      const generation = this._newId(), pages = split(JSON.stringify(list));
      const keys = pages.map((_, i) => 'index_' + generation + '_' + i), previous = this._indexKeys.slice();
      try {
        for (let i = 0; i < pages.length; i++) await this._write(keys[i], pages[i]);
        // Root pointer is the commit point. Old generations stay intact until it succeeds.
        await this._write('sets_index', JSON.stringify({version:3,generation,pageCount:pages.length}));
      } catch (error) {
        // A timeout may complete remotely later: never delete potentially referenced data.
        if (error.code !== 'timeout') await this._cleanup(keys);
        throw error;
      }
      this._indexKeys = keys; await this._cleanup(previous); return true;
    }
    async getActiveSetId() { return await this.backend.getItem('active_set') || null; }
    async setActiveSetId(id) { await this._write('active_set', id || ''); return true; }
    _dataKeys(entry) { return Array.from({length:entry.chunkCount}, (_, i) => 's_' + (entry.dataId || entry.id) + '_' + i); }
    _progressKey(entry,index) {return 'p_'+(entry.dataId || entry.id)+'_'+this._deviceId+'_'+Math.floor(index/8);}
    async _progressKeys(entry) {const prefix='p_'+(entry.dataId || entry.id)+'_';return (await this._keys()).filter(key=>key.startsWith(prefix));}
    async _replaceTerms(sets, entry, terms) {
      const parts = split(JSON.stringify(terms)), dataId = this._newId(), keys = parts.map((_, i) => 's_' + dataId + '_' + i);
      const next = {...entry,dataId,format:'json-parts',termCount:terms.length,chunkCount:parts.length};
      const updated = sets.some(set => set.id === entry.id) ? sets.map(set => set.id === entry.id ? next : set) : [...sets,next];
      const required = sets.reduce((sum, set) => sum + set.chunkCount, 0) + parts.length + this._indexKeys.length + Math.ceil(JSON.stringify(updated).length / PART_SIZE) + 8;
      if (this.backendName === 'cloud' && required > 950) throw new StorageError('Недостаточно места в Telegram для безопасного сохранения. Уменьши объём словаря.', 'limit');
      try {
        for (let i = 0; i < parts.length; i++) await this._write(keys[i], parts[i]);
        await this._saveSetsIndex(updated);
      } catch (error) {
        if (error.code !== 'timeout') await this._cleanup(keys);
        throw error;
      }
      if (sets.some(set => set.id === entry.id)) {this._baseCache.delete(entry.dataId || entry.id);await this._cleanup([...this._dataKeys(entry),...await this._progressKeys(entry)]);}
      return next;
    }
    async createSet(name, terms, language) {
      return this._mutate(async () => {
        if (!terms.length) throw new StorageError('Набор не содержит слов.');
        const sets = await this.listSets(), id = this._newId();
        await this._replaceTerms(sets, {id,name,language:language || 'mixed',createdAt:Date.now()}, terms);
        try { await this.setActiveSetId(id); } catch (error) { console.warn('Set saved; active preference unavailable', error); }
        return id;
      });
    }
    async renameSet(id, name) { return this._updateMetadata(id, {name}); }
    async updateSetLanguage(id, language) { return this._updateMetadata(id, {language:language || 'mixed'}); }
    _updateMetadata(id, patch) {
      return this._mutate(async () => {
        const sets = await this.listSets(); if (!sets.some(set => set.id === id)) return false;
        await this._saveSetsIndex(sets.map(set => set.id === id ? {...set,...patch} : set)); return true;
      });
    }
    async deleteSet(id) {
      return this._mutate(async () => {
        const sets = await this.listSets(), entry = sets.find(set => set.id === id); if (!entry) return false;
        const active = await this.getActiveSetId();
        const remaining = sets.filter(set => set.id !== id); await this._saveSetsIndex(remaining);
        if (active === id) { try { await this.setActiveSetId(remaining[0]?.id || ''); } catch (error) { console.warn('Active preference unavailable', error); } }
        this._baseCache.delete(entry.dataId || entry.id);
        await this._cleanup([...this._dataKeys(entry),...await this._progressKeys(entry)]); return true;
      });
    }
    async loadSetTerms(id, knownEntry) {
      const entry = knownEntry || (await this.listSets()).find(set => set.id === id); if (!entry) return {terms:[],chunkMap:new Map(),chunkCount:0};
      const generation=entry.dataId || entry.id, cached=this._baseCache.get(generation);
      const keys = this._dataKeys(entry), progressKeys=await this._progressKeys(entry);
      const values = await this.backend.getItems([...(cached ? [] : keys),...progressKeys]), chunkMap = new Map();
      if (!cached && keys.some(key => typeof values[key] !== 'string')) throw new StorageError('Не все слова удалось прочитать. Набор не изменён.', 'damaged');
      let terms = cached ? JSON.parse(JSON.stringify(cached)) : [];
      if (!cached && entry.format === 'json-parts') {
        terms = parse(keys.map(key => values[key]).join(''), null);
        if (!Array.isArray(terms)) throw new StorageError('Данные набора повреждены.', 'damaged');
        terms.forEach(term => chunkMap.set(term?.id, 0));
      } else if(!cached) {
        keys.forEach((key, idx) => {
          const chunk = parse(values[key], null);
          if (!Array.isArray(chunk)) throw new StorageError('Данные набора повреждены.', 'damaged');
          chunk.forEach(term => { terms.push(term); chunkMap.set(term?.id, idx); });
        });
      }
      if (terms.length !== entry.termCount || terms.some(term => !term || typeof term.id !== 'string' || typeof term.term !== 'string' || typeof term.translation !== 'string') || new Set(terms.map(term => term.id)).size !== terms.length)
        throw new StorageError('В наборе есть повреждённые записи. Оригинал сохранён.', 'damaged');
      if(!cached) this._baseCache.set(generation,JSON.parse(JSON.stringify(terms)));
      const latest=new Map();
      progressKeys.sort().forEach(key=>{
        const progress=parse(values[key],null);
        if(!progress || typeof progress!=='object' || Array.isArray(progress)) throw new StorageError('Прогресс набора повреждён. Оригинал сохранён.', 'damaged');
        Object.entries(progress).forEach(([id,value])=>{
          if(value && typeof value==='object' && (value.progress_updated_at || 0)>=(latest.get(id)?.progress_updated_at || 0)) latest.set(id,value);
        });
      });
      terms.forEach((term,index)=>{
        chunkMap.set(term.id,Math.floor(index/8));
        if(latest.has(term.id)) Object.assign(term,this._progressFields(latest.get(term.id)));
      });
      return {terms,chunkMap,chunkCount:entry.chunkCount};
    }
    async addTerm(id, term) { return this._editTerms(id, term, false); }
    async updateTerm(id, term) { return this._editTerms(id, term, true); }
    _progressFields(term) {
      const fields=['attempts','correct_count','practice_points','srs_version','mastery_level','last_mastery_at','last_lapse_at','due_date','last_seen','status','last_review_failed','translationAliases','progress_updated_at'];
      return Object.fromEntries(fields.filter(key=>Object.hasOwn(term,key)).map(key=>[key,term[key]]));
    }
    async saveTerm(id, term) {
      const snapshot=JSON.parse(JSON.stringify(term));
      snapshot.progress_updated_at ||= Date.now();
      return this._mutate(async()=>{
        const sets=await this.listSets(), entry=sets.find(set=>set.id===id);
        if(!entry) return {ok:false,reason:'missing_set'};
        const generation=entry.dataId || entry.id;
        if(!this._baseCache.has(generation)) await this.loadSetTerms(id,entry);
        const base=this._baseCache.get(generation), index=base.findIndex(item=>item.id===snapshot.id);
        if(index<0) return {ok:false,reason:'missing_term'};
        const key=this._progressKey(entry,index), raw=await this.backend.getItem(key), progress=raw ? parse(raw,null) : {};
        if(!progress || typeof progress!=='object' || Array.isArray(progress)) throw new StorageError('Прогресс повреждён. Оригинал сохранён.', 'damaged');
        if((progress[snapshot.id]?.progress_updated_at || 0)>(snapshot.progress_updated_at || Date.now())) return {ok:true};
        progress[snapshot.id]=this._progressFields(snapshot);
        const serialized=JSON.stringify(progress);
        const projectedKeys=sets.reduce((count,set)=>count+set.chunkCount+Math.ceil(set.termCount/8)*2,0)+this._indexKeys.length+64;
        if(serialized.length<=4096 && (this.backendName!=='cloud' || projectedKeys<950)) await this._writeIdempotent(key,serialized);
        else {
          // Oversized aliases / near-full accounts keep the safe legacy path.
          const {terms}=await this.loadSetTerms(id,entry);
          Object.assign(terms[index],this._progressFields(snapshot));
          await this._replaceTerms(sets,entry,terms);
        }
        return {ok:true};
      });
    }
    _editTerms(id, term, editing, progressOnly = false) {
      const snapshot = JSON.parse(JSON.stringify(term));
      return this._mutate(async () => {
        const sets = await this.listSets(), entry = sets.find(set => set.id === id); if (!entry) return {ok:false,reason:'missing_set'};
        const {terms} = await this.loadSetTerms(id,entry), index = terms.findIndex(item => item.id === snapshot.id);
        if (editing && index < 0) return {ok:false,reason:'missing_term'};
        const norm = value => value.trim().normalize('NFC').toLocaleLowerCase();
        if (!progressOnly && terms.some(item => item.id !== snapshot.id && norm(item.term) === norm(snapshot.term))) return {ok:false,reason:'duplicate'};
        if (editing) terms[index] = progressOnly
          ? {...terms[index], ...snapshot, term:terms[index].term, translation:terms[index].translation, context:terms[index].context}
          : snapshot;
        else terms.push(snapshot);
        await this._replaceTerms(sets, entry, terms); return {ok:true};
      });
    }
    async saveChunk(id, index, records) { for (const term of records) if (!(await this.saveTerm(id, term)).ok) return false; return true; }
    async touchSetStats() { /* Counts commit with data, never separately. */ }
  }
  global.VocabStorage = {VocabStore, StorageError, CloudStorageBackend, LocalStorageBackend};
})(window);
