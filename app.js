/**
 * app.js
 * -----------------------------------------------------------------------
 * Main controller: multi-set vocabulary management, screens (Learn /
 * Review / Progress / Import), the two-phase Study→Test learning flow,
 * and rendering. Persistence goes through VocabStorage.VocabStore
 * (Telegram CloudStorage with a localStorage fallback); scheduling math
 * through VocabSrs; exercise data through VocabExercises; CSV parsing
 * through VocabCsv.
 *
 * All DOM lookups and event wiring happen inside the DOMContentLoaded
 * handler at the bottom of this file, so navigation never silently fails
 * because a listener was attached before its element existed.
 * -----------------------------------------------------------------------
 */
(function () {
  'use strict';

  const Srs = window.VocabSrs;
  const Ex = window.VocabExercises;
  const Csv = window.VocabCsv;

  // Embedded fallback demo set so the "Загрузить демо-набор" button works
  // even when the app is opened straight from disk (file://), where
  // fetching an external sample.csv would be blocked by the browser.
  const DEMO_CSV = [
    'term;translation;context',
    'achieve;достигать;She worked hard to achieve her goals.',
    'stubborn;упрямый;My little brother is so stubborn.',
    'die Erfahrung;опыт;Er hat viel Erfahrung in diesem Bereich.',
    'reliable;надёжный;This car is old but very reliable.',
    'die Gelegenheit;возможность;Das war eine gute Gelegenheit.',
    'to postpone;откладывать;Let\'s postpone the meeting until Friday.',
    'die Rücksicht;внимательность, тактичность;Nimm Rücksicht auf andere.',
    'generous;щедрый;He is generous with his time and money.',
    'die Ausdauer;выносливость;Marathon runners need a lot of Ausdauer.',
    'to overwhelm;переполнять, ошеломлять;The amount of work overwhelmed her.'
  ].join('\n');

  const SESSION_SIZE = 10;
  const ALL_SETS_ID = '__all__';
  const LANGUAGE_SCOPE_PREFIX = '__language__:';
  const LANGUAGE_LABELS = { en: 'Английский', de: 'Немецкий', es: 'Испанский', fr: 'Французский', it: 'Итальянский', pt: 'Португальский', zh: 'Китайский', ja: 'Японский', ko: 'Корейский', ar: 'Арабский', hi: 'Хинди', ru: 'Русский', mixed: 'Смешанные' };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    store: null,
    sets: [],                 // [{id, name, createdAt, termCount, chunkCount}]
    languageGroups: [],       // aggregate scopes; words stay in their original sets
    activeSetId: null,
    loadedScope: null,
    terms: [],                 // terms of the active set
    chunkMap: new Map(),       // termId -> {setId, chunkIdx}, for cheap partial saves
    termMeta: new Map(),       // termId -> {setId, setName, language}
    settings: null,
    activity: { lastDay: null, streak: 0, longest: 0, dailyCount: 0, dailyGoal: 5 },
    screen: 'loading',       // loading | import | home | learn | review | progress
    importMode: 'first',    // 'first' (no sets yet) | 'add' (adding another set)
    session: {
      queue: [],
      initialLength: 0,
      answered: false,
      pendingStudyTermId: null // set while Phase 1 (study) is showing, before Phase 2 test
    },
    reviewFilter: 'due',
    extraPractice: false,
    reviewSize: 5,
    flashcards: { items: [], index: 0, revealed: false },
    editingTermId: null
  };

  let el = {}; // populated on DOMContentLoaded
  let importBusy = false;
  let switchingSet = false;
  let saveQueue = Promise.resolve();
  let pendingWrites = [];
  let pendingBackupAvailable = true;
  let saveFailure = false;
  let retryTimer = null, retryCount = 0;
  let lastActivityRefresh = 0, activityRefreshing = false;
  let modalFocus = null;
  function journalKey(kind) {
    const user = window.Telegram?.WebApp?.initDataUnsafe?.user?.id || 'browser';
    return `vocab_${kind}_${state.store?.backendName || 'local'}_${user}`;
  }
  function writeJournal(kind, value) {
    try { localStorage.setItem(journalKey(kind), JSON.stringify(value)); return true; }
    catch { showToast('Не удалось создать резервную копию в браузере. Не закрывай занятие до сохранения.', 6000); return false; }
  }
  function readJournal(kind) {
    try { return JSON.parse(localStorage.getItem(journalKey(kind)) || 'null'); } catch { return null; }
  }
  function hasSessionTasks(saved,scope=state.activeSetId) {
    if(saved?.version!==1 || saved.progressModel!==4 || saved.setId!==scope || !Array.isArray(saved.queue) || Date.now()-saved.updatedAt>=7*86400000) return false;
    const queue=saved.queue.slice();
    (Array.isArray(saved.pendingNext?.ids) ? saved.pendingNext.ids : []).forEach(id=>{const index=queue.indexOf(id);if(index>=0)queue.splice(index,1);});
    return queue.length>0;
  }
  function saveSession(pendingNext = null) {
    if (!state.session.queue.length) { writeJournal('session', null); return; }
    writeJournal('session', { version: 1, progressModel:4, setId: state.activeSetId, updatedAt: Date.now(),
      queue: state.session.queue, initialLength: state.session.initialLength,
      reviewKinds: state.session.reviewKinds ? [...state.session.reviewKinds] : null,
      reviewResults: [...(state.session.reviewResults || [])], studied: [...(state.session.studied || [])], pendingNext });
  }
  function updateSaveNotice(message) {
    let notice = $('#saveNotice');
    if (!notice) {
      notice = document.createElement('div'); notice.id = 'saveNotice'; notice.className = 'save-notice';
      notice.setAttribute('role', 'status'); $('#app').prepend(notice);
    }
    notice.hidden = !message;
    notice.replaceChildren();
    if (message) {
      const text = document.createElement('span'); text.textContent = message; notice.append(text);
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-ghost';
      retry.textContent = state.store?._uncertain ? 'Перезагрузить' : 'Повторить сохранение';
      retry.onclick = () => { if(state.store?._uncertain) location.reload(); else {retryCount=0;flushPendingWrites();} }; notice.append(retry);
    }
  }
  function flushPendingWrites() {
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        const savedActivity=readJournal('activity');
        if(savedActivity) {
          await state.store.setActivity(savedActivity);
          if(JSON.stringify(readJournal('activity'))===JSON.stringify(savedActivity)) writeJournal('activity',null);
        }
        while (pendingWrites.length) {
          const batch=pendingWrites.slice(), latest=new Map();
          // Save the calendar even if a word/set was edited or deleted meanwhile.
          await state.store.setActivity(Srs.mergeActivity(...batch.map(job=>job.activity)));
          batch.forEach(job=>latest.set(job.setId+'\0'+job.term.id,job));
          for(const job of latest.values()) {
            if (!state.sets.some(set => set.id === job.setId)) continue;
            const result = await state.store.saveTerm(job.setId, job.term);
            if (!result.ok && !['missing_set','missing_term'].includes(result.reason)) throw new Error('Не удалось сохранить слово');
          }
          pendingWrites.splice(0,batch.length); pendingBackupAvailable = writeJournal('pending', pendingWrites);
        }
        saveFailure = false; retryCount=0; clearTimeout(retryTimer); updateSaveNotice(''); updateSyncBadge();
      } catch (error) {
        console.error('Progress write failed', error); saveFailure = true;
        updateSaveNotice(pendingBackupAvailable
          ? (state.store?._uncertain ? 'Нужно переподключиться к Telegram. После перезагрузки восстановим ответы из резервной копии.' : 'Изменения пока на этом устройстве. Повторим синхронизацию при восстановлении связи.')
          : 'Не удалось сохранить прогресс и резервную копию. Не закрывай страницу.');
        updateSyncBadge();
        if(!state.store?._uncertain && retryCount<3 && navigator.onLine!==false) {
          clearTimeout(retryTimer);retryTimer=setTimeout(()=>flushPendingWrites(),[5000,15000,45000][retryCount++]);
        }
      }
    });
    return saveQueue;
  }
  const $ = (sel) => document.querySelector(sel);
  const SCREEN_TITLES = { home: 'Vocab', learn: 'Учить', review: 'Повторение', progress: 'Прогресс', import: 'Vocab', loading: 'Vocab' };
  let navigationVersion=0;

  async function openScopedScreen(name,customQueue,forceNew,taskBudget=20) {
    showScreen('loading');const token=++navigationVersion;
    try {
      await loadActiveSetTerms();
      if(token!==navigationVersion) return;
      renderSetSwitcher();showScreen(name,customQueue,forceNew,taskBudget);
    } catch(error) {
      if(token!==navigationVersion) return;
      showScreen('home');showToast('Не удалось загрузить слова. Попробуй ещё раз — данные не удалены.',5000);
    }
  }

  function updateSyncBadge() {
    if(!el.syncBadge || !state.store) return;
    el.syncBadge.className='sync-badge '+state.store.backendName;
    el.syncBadge.textContent=state.store.backendName==='cloud'
      ? saveFailure ? 'Telegram · есть несохранённые изменения' : pendingWrites.length || readJournal('activity') ? 'Telegram · сохраняем изменения…' : 'Telegram · все изменения сохранены'
      : 'На этом устройстве · без синхронизации';
  }

  async function refreshActivity() {
    if(activityRefreshing || !state.store || Date.now()-lastActivityRefresh<10000) return;
    activityRefreshing=true;lastActivityRefresh=Date.now();
    try {
      const remote=await state.store.getActivity();
      state.activity={...Srs.mergeActivity(remote,state.activity),sourceId:remote.sourceId};
      renderDailyGoal();
      if(state.screen==='review') renderStreak();
      if(state.screen==='progress') renderProgress();
      if(!el.calendarBackdrop.hidden) renderCalendar();
    } catch(error) { console.warn('Activity refresh deferred',error); }
    finally {activityRefreshing=false;}
  }

  // ---------------------------------------------------------------------
  // Telegram WebApp integration
  // ---------------------------------------------------------------------
  function updateTelegramSafeArea(tg) {
    const root = document.documentElement;
    const device = tg.safeAreaInset || {};
    const content = tg.contentSafeAreaInset || {};
    ['top', 'right', 'bottom', 'left'].forEach((side) => {
      const deviceValue = Number(device[side]);
      const contentValue = Number(content[side]);
      if (Number.isFinite(deviceValue)) root.style.setProperty(`--telegram-safe-${side}`, `${deviceValue}px`);
      else root.style.removeProperty(`--telegram-safe-${side}`);
      if (Number.isFinite(contentValue)) root.style.setProperty(`--telegram-content-safe-${side}`, `${contentValue}px`);
      else root.style.removeProperty(`--telegram-content-safe-${side}`);
    });
  }

  function initTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) return;
    try {
      tg.ready();
      tg.expand();
      updateTelegramSafeArea(tg);
      if (typeof tg.onEvent === 'function') {
        tg.onEvent('safeAreaChanged', () => updateTelegramSafeArea(tg));
        tg.onEvent('contentSafeAreaChanged', () => updateTelegramSafeArea(tg));
        tg.onEvent('fullscreenChanged', () => requestAnimationFrame(() => updateTelegramSafeArea(tg)));
      }
      if (tg.setHeaderColor && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1')) {
        tg.setHeaderColor('secondary_bg_color');
      }
    } catch (e) { /* not fatal outside Telegram */ }
  }

  function registerOfflineApp() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Offline app registration failed', error);
    });
  }

  let confirmResolve = null;
  function confirmDialog(message, options = {}) {
    modalFocus = document.activeElement;
    $('#confirmTitle').textContent = options.title || 'Удалить набор?';
    el.btnConfirmDelete.textContent = options.action || 'Удалить';
    el.confirmMessage.textContent = message;
    el.confirmBackdrop.hidden = false;
    $('#app').inert = true;
    el.btnConfirmCancel.focus();
    return new Promise((resolve) => { confirmResolve = resolve; });
  }

  function closeConfirm(ok) {
    if (!confirmResolve) return;
    el.confirmBackdrop.hidden = true;
    $('#app').inert = false;
    const resolve = confirmResolve;
    confirmResolve = null;
    if (modalFocus?.isConnected && modalFocus.getClientRects().length) modalFocus.focus();
    else if (!el.btnSetMenu.hidden) el.btnSetMenu.focus();
    resolve(ok);
  }

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms || 2200);
  }

  function applyTheme(theme) {
    const chosen = theme === 'dark' ? 'dark' : 'light';
    const guard=document.createElement('style');guard.textContent='*,*::before,*::after{transition:none!important}';document.head.append(guard);
    document.documentElement.dataset.theme = chosen;
    void document.body.offsetHeight;
    requestAnimationFrame(()=>requestAnimationFrame(()=>guard.remove()));
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', chosen === 'dark' ? '#0f151e' : '#f4f6f8');
    if (el.btnTheme) {
      el.btnTheme.dataset.theme = chosen;
      el.btnTheme.setAttribute('aria-label', chosen === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
    }
    try { localStorage.setItem('vocab_theme', chosen); } catch (e) { /* optional preference */ }
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('vocab_theme'); } catch (e) { /* ignore */ }
    const preferred = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(saved || preferred);
  }

  function initReviewSize() {
    let saved = 5;
    try { saved = Number(localStorage.getItem('vocab_review_size')) || 5; } catch (e) { /* optional preference */ }
    state.reviewSize = Math.max(1, Math.round(saved));
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function detectTermLanguage(text, context) {
    const value = `${text || ''} ${context || ''}`.trim();
    const hasGermanMarker = /[äöüß]/i.test(value) ||
      /\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|nicht|sich|zu|von|vom|auf|mit|für|über|unter|bei|nach|aus|um|gegen|ohne|durch|werden|haben|sein)\b/i.test(value) ||
      /(?:ung|keit|heit|schaft|chen|lein|lich|isch|bar|los)$/i.test(value);
    return hasGermanMarker
      ? 'de'
      : 'en';
  }

  function isLikelyGermanNounWithoutArticle(text) {
    const value = (text || '').trim();
    const hasArticle = /^(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer)\s+/i.test(value);
    return !hasArticle && /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]*(?:\s|$)/.test(value);
  }

  function inferSetLanguage(terms) {
    const languages = new Set(terms.map((term) => detectTermLanguage(term.term, term.context)));
    if (languages.size === 1) return [...languages][0];
    return 'mixed';
  }

  function languageLabel(language) {
    return LANGUAGE_LABELS[language] || language || LANGUAGE_LABELS.mixed;
  }

  function languageScopeId(language) {
    return LANGUAGE_SCOPE_PREFIX + Ex.canonicalLanguage(language);
  }

  function scopeLanguage(id = state.activeSetId) {
    return typeof id === 'string' && id.startsWith(LANGUAGE_SCOPE_PREFIX)
      ? Ex.canonicalLanguage(id.slice(LANGUAGE_SCOPE_PREFIX.length)) : null;
  }

  function isAggregateScope(id = state.activeSetId) {
    return id === ALL_SETS_ID || scopeLanguage(id) !== null;
  }

  function isValidScope(id) {
    const language = scopeLanguage(id);
    return language !== null
      ? state.languageGroups.some(group => group.language === language)
      : state.sets.some(set => set.id === id);
  }

  function defaultManualSetId() {
    if (!isAggregateScope()) return state.activeSetId;
    return state.termMeta.values().next().value?.setId || state.sets[0]?.id || '';
  }

  function setCreationTime(set) {
    const date = new Date(set.createdAt);
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
  }

  function termSourceLabel(term) {
    const meta = state.termMeta.get(term.id);
    if (!meta) return '';
    return `${languageLabel(meta.language)} · ${meta.setName}`;
  }

  function normalizeStoredTerm(term) {
    // Older/imported records can have missing SRS fields; keep their id and
    // progress, but make every render path safe to use.
    term.term = String(term.term ?? term.word ?? term.front ?? '');
    term.translation = String(term.translation ?? term.definition ?? term.back ?? '');
    term.context = String(term.context ?? '');
    term.attempts = Number.isFinite(Number(term.attempts)) ? Math.max(0, Math.floor(Number(term.attempts))) : 0;
    term.correct_count = Number.isFinite(Number(term.correct_count)) ? Math.min(term.attempts, Math.max(0, Math.floor(Number(term.correct_count)))) : 0;
    term.practice_points = Number.isFinite(Number(term.practice_points)) ? Math.max(0, Math.floor(Number(term.practice_points))) : term.correct_count;
    term.translationAliases = Array.isArray(term.translationAliases) ? term.translationAliases.filter(value => typeof value === 'string' && value.trim()).slice(0, 30) : [];
    const storedLevel = Number.isFinite(Number(term.mastery_level)) ? Math.max(0, Math.floor(Number(term.mastery_level))) : 0;
    // Map the old ten-step scale proportionally once, without discarding progress.
    term.mastery_level = Number(term.srs_version) >= 2
      ? Math.min(state.settings.intervalsDays.length, storedLevel)
      : Math.min(state.settings.intervalsDays.length, Math.round(storedLevel * state.settings.intervalsDays.length / 10));
    if(!(Number(term.srs_version)>=4)) {
      // Recover all recorded correct answers, including those previously held
      // behind daily gates. Preserve earned legacy progress when history is partial.
      term.correct_count=Math.max(term.correct_count,term.practice_points,term.mastery_level);
      term.attempts=Math.max(term.attempts,term.correct_count);
      term.mastery_level=Math.min(state.settings.intervalsDays.length,term.correct_count);
    }
    term.srs_version = 4;
    term.due_date = Number.isFinite(Number(term.due_date)) ? Number(term.due_date) : Date.now();
    term.created_at = Number.isFinite(Number(term.created_at)) ? Number(term.created_at) : Date.now();
    term.status = term.attempts === 0 && term.last_review_failed ? 'learning' : Srs.statusFor(term, state.settings.intervalsDays);
    return term;
  }

  // ---------------------------------------------------------------------
  // Screen navigation
  // ---------------------------------------------------------------------
  function showScreen(name, customQueue, forceNew = false,taskBudget=20) {
    if(['learn','review','progress'].includes(name) && state.activeSetId && state.loadedScope!==state.activeSetId) {
      openScopedScreen(name,customQueue,forceNew,taskBudget);return;
    }
    navigationVersion++;
    console.log('renderScreen:', name);
    state.screen = name;
    document.title=`${SCREEN_TITLES[name]} — Vocab`;
    window.scrollTo(0, 0);
    if (el.setMenu) {
      el.setMenu.hidden = true;
      el.btnSetMenu.setAttribute('aria-expanded', 'false');
    }

    // Explicit, unconditional: whatever screen we're going to, every other
    // screen — loading included — is hidden. This is what guarantees the
    // loading screen can never stay on top of another screen.
    Object.keys(el.screens).forEach((key) => {
      el.screens[key].hidden = key !== name;
      if(key===name) el.screens[key].setAttribute('role','main');else el.screens[key].removeAttribute('role');
    });
    if(name!=='loading') {el.screens[name].classList.toggle('enter-once',!el.screens[name].dataset.visited);el.screens[name].dataset.visited='true';}
    // Belt-and-braces in case a new screen is ever added to the DOM but
    // forgotten in el.screens: loading is never allowed to stay visible
    // once we've decided to render anything else.
    if (name !== 'loading' && el.screens.loading) el.screens.loading.hidden = true;

    el.mainHeader.hidden = name === 'loading';
    el.mainHeader.dataset.screen = name;
    el.topbarTitle.hidden = !['home', 'import', 'learn'].includes(name);
    el.topbarTitle.textContent = SCREEN_TITLES[name];
    el.btnBackHome.hidden = name !== 'learn';
    el.btnTheme.hidden = name === 'learn';
    el.setSwitch.hidden = name === 'loading' || name === 'import' || name === 'home' || name === 'learn' || state.sets.length === 0;
    el.bottomnav.hidden = name === 'loading' || name === 'import' || name === 'learn';
    el.syncBadge.hidden = name === 'loading' || name === 'learn';

    document.querySelectorAll('.nav-btn').forEach((btn, index) => {
      const active = btn.dataset.screen === name;
      btn.classList.toggle('active', active);
      if (active) {
        btn.setAttribute('aria-current', 'page');
        el.bottomnav.style.setProperty('--nav-index', index);
      } else btn.removeAttribute('aria-current');
    });

    if (name === 'home') renderHome();
    if (name === 'learn') startLearnSession(customQueue, forceNew,taskBudget);
    if (name === 'review') renderReview();
    if (name === 'progress') renderProgress();
    if(el.skipContent) el.skipContent.href='#screen-'+name;
    if(name!=='loading') {
      const focus=el.screens[name].querySelector('h1') || el.screens[name];focus.tabIndex=-1;focus.focus({preventScroll:true});
      requestAnimationFrame(()=>{if(state.screen===name) window.scrollTo(0,0);});
    }
  }

  // ---------------------------------------------------------------------
  // Set switcher (header dropdown + add/delete)
  // ---------------------------------------------------------------------
  function renderSetSwitcher() {
    const groups = {};
    [...state.sets].sort((a, b) => setCreationTime(b) - setCreationTime(a))
      .forEach((set) => (groups[Ex.canonicalLanguage(set.language) || 'mixed'] ||= []).push(set));
    let html = state.languageGroups.map(group => {
      const id = languageScopeId(group.language);
      return `<option value="${escapeHtml(id)}" ${state.activeSetId === id ? 'selected' : ''}>Все наборы · ${escapeHtml(languageLabel(group.language))} (${group.termCount})</option>`;
    }).join('');
    Object.keys(groups).forEach((language) => {
      if (groups[language].length === 0) return;
      html += `<optgroup label="${escapeHtml(languageLabel(language))}">` + groups[language].map((set) =>
        `<option value="${escapeHtml(set.id)}" ${set.id === state.activeSetId ? 'selected' : ''}>${escapeHtml(set.name)} (${set.termCount})</option>`
      ).join('') + '</optgroup>';
    });
    el.setSelect.innerHTML = html;
    el.btnDeleteSet.hidden = isAggregateScope();
    el.btnEditLanguage.disabled = isAggregateScope();
    el.manualSetSelect.innerHTML = state.sets.map((set) =>
      `<option value="${escapeHtml(set.id)}">${escapeHtml(set.name)} · ${escapeHtml(languageLabel(set.language))}</option>`
    ).join('');
    el.manualSetSelect.value = defaultManualSetId();
  }

  async function switchActiveSet(setId) {
    if (switchingSet || !isValidScope(setId)) return false;
    switchingSet = true;
    const previous = state.activeSetId;
    const previousData = {terms:state.terms,chunkMap:state.chunkMap,termMeta:state.termMeta,loadedScope:state.loadedScope};
    try {
    state.activeSetId = setId;
    await loadActiveSetTerms();
    await state.store.setActiveSetId(setId);
    renderSetSwitcher();
    if (state.screen === 'home' || state.screen === 'learn' || state.screen === 'review' || state.screen === 'progress') {
      showScreen(state.screen);
    }
    return true;
    } catch (error) {
      state.activeSetId = previous;
      Object.assign(state, previousData);
      renderSetSwitcher(); showToast('Набор не удалось открыть. Проверь соединение и попробуй снова.', 5000);
      return false;
    } finally { switchingSet = false; }
  }

  async function loadActiveSetTerms() {
    const scopeId=state.activeSetId;
    if (!state.activeSetId) {
      state.terms = [];
      state.chunkMap = new Map();
      state.termMeta = new Map();
      return;
    }
    const selectedLanguage = scopeLanguage(scopeId);
    const selectedSets = selectedLanguage !== null
      ? state.sets.filter(set => {
        const language = Ex.canonicalLanguage(set.language);
        return !language || language === 'mixed' || language === selectedLanguage;
      })
      : state.sets.filter((set) => set.id === scopeId);
    const bundles = await Promise.all(selectedSets.map(async (set) => ({
      set,
      data: await state.store.loadSetTerms(set.id,set)
    })));
    if(state.activeSetId!==scopeId) return false;
    const terms = [], chunkMap = new Map(), termMeta = new Map();
    bundles.forEach(({ set, data }) => {
      const setLanguage = Ex.canonicalLanguage(set.language || inferSetLanguage(data.terms));
      set.language = setLanguage;
      data.terms.forEach((rawTerm) => {
        const term = normalizeStoredTerm(rawTerm);
        const language = setLanguage === 'mixed' ? detectTermLanguage(term.term, term.context) : setLanguage;
        if (selectedLanguage !== null && language !== selectedLanguage) return;
        terms.push(term);
        chunkMap.set(term.id, { setId: set.id, chunkIdx: data.chunkMap.get(term.id) });
        termMeta.set(term.id, { setId: set.id, setName: set.name, language });
      });
    });
    Object.assign(state, { terms, chunkMap, termMeta });
    pendingWrites.forEach(job=>{
      const term=terms.find(term=>term.id===job.term.id);
      if(term && termMeta.get(term.id)?.setId===job.setId && (job.term.progress_updated_at || 0)>=(term.progress_updated_at || 0)) Object.assign(term,normalizeStoredTerm(job.term));
    });
    state.loadedScope=scopeId;
  }

  async function refreshSetsList() {
    const sets = await state.store.listSets();
    const memberships = await Promise.all(sets.map(async set => {
      const language = Ex.canonicalLanguage(set.language);
      if (language && language !== 'mixed') {
        set.language = language;
        return [{ language, count: Number(set.termCount) || 0 }];
      }
      // Only legacy/mixed sets need reading; declared languages use metadata.
      const { terms } = await state.store.loadSetTerms(set.id,set);
      set.language = language || inferSetLanguage(terms);
      const counts = new Map();
      terms.forEach(term => {
        const detected = detectTermLanguage(term.term, term.context);
        counts.set(detected, (counts.get(detected) || 0) + 1);
      });
      return [...counts].map(([language, count]) => ({ language, count }));
    }));
    const groups = new Map();
    memberships.forEach(entries => entries.forEach(({ language, count }) => {
      if (!count) return;
      const group = groups.get(language) || { language, termCount: 0, setCount: 0 };
      group.termCount += count;
      group.setCount += 1;
      groups.set(language, group);
    }));
    state.sets = sets;
    state.languageGroups = [...groups.values()].sort((a, b) => languageLabel(a.language).localeCompare(languageLabel(b.language), 'ru'));
  }

  function renderHome() {
    renderDailyGoal();
    const saved = readJournal('session');
    const sessionLabel = id => hasSessionTasks(saved,id) ? 'Продолжить занятие' : 'Начать занятие';
    const canResume=hasSessionTasks(saved);
    const resting=state.loadedScope===state.activeSetId && !Srs.reviewPool(state.terms).length;
    el.btnHomeContinue.textContent=canResume ? 'Продолжить занятие' : resting
      ? Srs.currentDailyCount(state.activity)<dailyGoal() ? 'Продолжить практику' : 'Открыть повторение'
      : 'Начать занятие';
    el.homeScopeLabel.textContent=scopeLanguage() ? `Все наборы · ${languageLabel(scopeLanguage())}` : state.sets.find(set=>set.id===state.activeSetId)?.name || '';
    const sortedSets = [...state.sets].sort((a, b) => setCreationTime(b) - setCreationTime(a));
    const allSets = state.languageGroups.map(group => `
      <div class="home-set-card home-language-card">
        <button class="home-set-open" type="button" data-open-set="${escapeHtml(languageScopeId(group.language))}">
          <strong>${escapeHtml(languageLabel(group.language))}</strong>
          <span>${wordCountLabel(group.termCount)} · ${sessionLabel(languageScopeId(group.language))}</span>
        </button>
      </div>
    `).join('');
    el.homeSetList.innerHTML = (allSets ? `<section class="home-language-section" aria-label="Занятия по языкам"><h3>Занятия по языкам</h3><div class="home-language-panel">${allSets}</div></section>` : '') + sortedSets.map((set) => `
      <div class="home-set-card">
        <button class="home-set-open" type="button" data-open-set="${escapeHtml(set.id)}">
          <span class="home-set-language">${escapeHtml(languageLabel(set.language))}</span>
          <strong>${escapeHtml(set.name)}</strong>
          <span>${Number(set.termCount) || 0} слов · ${sessionLabel(set.id)}</span>
          <span class="home-set-created">${setCreationTime(set) ? `Добавлен ${escapeHtml(new Date(set.createdAt).toLocaleDateString('ru-RU'))}` : 'Дата добавления неизвестна'}</span>
        </button>
        <button class="home-set-delete" type="button" data-delete-set="${escapeHtml(set.id)}" aria-label="Удалить набор ${escapeHtml(set.name)}">Удалить</button>
      </div>
    `).join('');
  }

  async function openHomeSession() {
    const button=el.btnHomeContinue, previous=button.textContent, scope=state.activeSetId;
    const token=++navigationVersion;button.disabled=true;button.textContent='Загружаем слова…';
    try {
      if(state.loadedScope!==scope) await loadActiveSetTerms();
      if(token!==navigationVersion || state.activeSetId!==scope) return;
      renderSetSwitcher();
      const saved=readJournal('session'),resume=hasSessionTasks(saved,scope);
      if(!resume && !Srs.reviewPool(state.terms).length) {
        const remaining=Math.max(0,dailyGoal()-Srs.currentDailyCount(state.activity));
        if(remaining && state.terms.length) {
          const count=Math.min(remaining,state.terms.length,5);
          const ids=chooseReviewTerms(state.terms,count).map(term=>term.id);
          showScreen('learn',ids,true,count);
        } else {state.extraPractice=false;showScreen('review');}
      } else showScreen('learn',undefined,!resume);
    } catch(error) {showToast('Не удалось открыть занятие. Проверь соединение и попробуй ещё раз.',5000);}
    finally {button.disabled=false;button.textContent=previous;}
  }

  function updateOtherLanguage(select, input) {
    input.hidden = select.value !== 'other';
    input.required = select.value === 'other';
    if (!input.hidden) input.focus();
  }

  function selectedLanguage(select, input) {
    return Ex.canonicalLanguage(select.value === 'other' ? input.value.trim() : select.value);
  }

  function openImportScreen(mode) {
    state.importMode = mode;
    el.importTitle.textContent = mode === 'add' ? 'Новый набор слов' : 'Учить слова стало проще';
    el.importSubtitle.textContent = mode === 'add'
      ? 'Загрузи CSV-файл для ещё одного набора — он появится в списке рядом с остальными.'
      : 'Загрузи CSV-файл со словами и фразами — приложение построит для тебя карточки и расписание повторений.';
    el.btnCancelImport.hidden = mode !== 'add';
    el.setNameInput.value = '';
    el.setLanguageSelect.value = 'auto';
    el.setLanguageOther.value = '';
    updateOtherLanguage(el.setLanguageSelect, el.setLanguageOther);
    el.importErrors.hidden = true;
    el.importErrors.innerHTML = '';
    showScreen('import');
  }

  // ---------------------------------------------------------------------
  // Import flow (creates a new set; never overwrites existing ones)
  // ---------------------------------------------------------------------
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'UTF-8');
    });
  }

  function renderImportErrors(errors, warnings) {
    if (!errors.length && !warnings.length) {
      el.importErrors.hidden = true;
      el.importErrors.innerHTML = '';
      return;
    }
    el.importErrors.hidden = false;
    let html = '';
    if (errors.length) {
      html += `<strong>Не удалось загрузить файл:</strong><ul>${errors.slice(0, 10).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
      if (errors.length > 10) html += `<p>...и ещё ${errors.length - 10} ошибок.</p>`;
    }
    if (warnings.length) {
      html += `<p><strong>Предупреждения:</strong></p><ul>${warnings.slice(0, 10).map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`;
    }
    el.importErrors.innerHTML = html;
  }

  function baseName(fileName) {
    return (fileName || '').replace(/\.[^/.]+$/, '') || 'Мой набор';
  }

  async function handleCsvText(text, defaultName) {
    if (importBusy) return;
    importBusy = true;
    el.btnLoadDemo.disabled = true; el.fileInput.disabled = true; el.btnCancelImport.disabled = true;
    try {
    const { items, errors, warnings } = Csv.parseCsv(text);
    renderImportErrors(errors, warnings);
    if (errors.length || items.length === 0) return;

    const name = (el.setNameInput.value || '').trim() || defaultName;
    const terms = items.map((it) => Srs.makeTerm(it));
    const chosenLanguage = selectedLanguage(el.setLanguageSelect, el.setLanguageOther);
    if (!chosenLanguage) { el.setLanguageOther.reportValidity(); return; }
    const language = chosenLanguage === 'auto' ? inferSetLanguage(terms) : chosenLanguage;
    const newId = await state.store.createSet(name, terms, language);

    await refreshSetsList();
    state.activeSetId = newId;
    await loadActiveSetTerms();
    renderSetSwitcher();

    showScreen('home');
    const missingArticles = language === 'de'
      ? terms.filter((term) => isLikelyGermanNounWithoutArticle(term.term)).length
      : 0;
    showToast(missingArticles
      ? `Набор создан. Проверь артикли у ${missingArticles} немецких слов в «Прогрессе».`
      : `Набор «${name}» создан: ${terms.length} слов`, missingArticles ? 5200 : 2200);
    } catch (error) {
      console.error('Import failed', error);
      renderImportErrors(['Не удалось сохранить набор. Старые наборы не изменены. Проверь соединение и попробуй снова.'], []);
    } finally {
      importBusy = false;
      el.btnLoadDemo.disabled = false; el.fileInput.disabled = false; el.btnCancelImport.disabled = false;
    }
  }

  function updateManualLanguageHint() {
    const set = state.sets.find((item) => item.id === el.manualSetSelect.value);
    el.manualGermanHint.hidden = !set || set.language !== 'de';
    el.manualTerm.placeholder = set && set.language === 'de' ? 'Например: die Erfahrung' : '';
  }

  function openSurface(mode, termId) {
    modalFocus = document.activeElement;
    $('#app').inert = true;
    el.setMenu.hidden = true;
    el.btnSetMenu.setAttribute('aria-expanded', 'false');
    el.surfaceBackdrop.hidden = false;
    el.addWordForm.hidden = mode !== 'word' && mode !== 'edit-word';
    el.setLanguageForm.hidden = mode !== 'language';

    if (mode === 'word') {
      state.editingTermId = null;
      el.surfaceTitle.textContent = 'Добавить слово';
      el.btnSaveWord.textContent = 'Добавить в набор';
      el.manualSetSelect.disabled = false;
      el.addWordForm.reset();
      el.manualAliasesDetails.open = false;
      el.manualSetSelect.value = defaultManualSetId();
      updateManualLanguageHint();
      setTimeout(() => el.manualTerm.focus(), 60);
      return;
    }

    if (mode === 'edit-word') {
      const term = getTermById(termId);
      const meta = term && state.termMeta.get(term.id);
      if (!term || !meta) return closeSurface();
      state.editingTermId = term.id;
      el.surfaceTitle.textContent = 'Изменить слово';
      el.btnSaveWord.textContent = 'Сохранить изменения';
      el.manualSetSelect.value = meta.setId;
      el.manualSetSelect.disabled = true;
      el.manualTerm.value = term.term;
      el.manualTranslation.value = term.translation;
      el.manualContext.value = term.context || '';
      el.manualAliases.value = (term.translationAliases || []).join('\n');
      el.manualAliasesDetails.open = Boolean(term.translationAliases?.length);
      updateManualLanguageHint();
      el.manualGermanHint.hidden = meta.language !== 'de';
      setTimeout(() => el.manualTerm.focus(), 60);
      return;
    }

    const set = state.sets.find((item) => item.id === state.activeSetId);
    if (!set) return closeSurface();
    el.surfaceTitle.textContent = 'Язык набора';
    el.setLanguageHint.textContent = `Выбери язык для набора «${set.name}». Слова автоматически переместятся в соответствующую группу.`;
    const language = set.language || 'mixed';
    const known = [...el.editLanguageSelect.options].some((option) => option.value === language);
    el.editLanguageSelect.value = known ? language : 'other';
    el.editLanguageOther.value = known ? '' : language;
    updateOtherLanguage(el.editLanguageSelect, el.editLanguageOther);
    setTimeout(() => el.editLanguageSelect.focus(), 60);
  }

  function closeSurface() {
    if (el.surfaceBackdrop.hidden) return;
    el.surfaceBackdrop.hidden = true;
    el.manualSetSelect.disabled = false;
    state.editingTermId = null;
    $('#app').inert = false;
    if (modalFocus?.isConnected && modalFocus.getClientRects().length) modalFocus.focus();
    else el.btnSetMenu.focus();
  }

  async function addWordManually(event) {
    event.preventDefault();
    if (el.btnSaveWord.disabled) return;
    el.btnSaveWord.disabled = true;
    try {
    const setId = el.manualSetSelect.value;
    const term = el.manualTerm.value.trim();
    const translation = el.manualTranslation.value.trim();
    const context = el.manualContext.value.trim();
    const translationAliases = [...new Map(el.manualAliases.value.split(/\r?\n/)
      .map(value => value.trim()).filter(Boolean)
      .filter(value => Ex.normalize(value) !== Ex.normalize(translation))
      .map(value => [Ex.normalize(value), value])).values()].slice(0, 30);
    if (!setId || !term || !translation) return;

    const editingTerm = state.editingTermId ? getTermById(state.editingTermId) : null;
    const termObject = editingTerm
      ? { ...editingTerm, term, translation, context, translationAliases }
      : Srs.makeTerm({ term, translation, context, translationAliases });
    const result = editingTerm
      ? await state.store.updateTerm(setId, termObject)
      : await state.store.addTerm(setId, termObject);
    if (!result.ok) {
      showToast(result.reason === 'duplicate' ? 'Такое слово уже есть в наборе' : 'Не удалось добавить слово');
      return;
    }

    await refreshSetsList();
    if (state.activeSetId === setId || isAggregateScope()) await loadActiveSetTerms();
    renderSetSwitcher();
    el.addWordForm.reset();
    el.manualSetSelect.value = setId;
    closeSurface();
    state.editingTermId = null;
    const set = state.sets.find((item) => item.id === setId);
    const articleWarning = set && set.language === 'de' && isLikelyGermanNounWithoutArticle(term);
    showToast(articleWarning
      ? `Сохранено. Проверь артикль у «${term}».`
      : editingTerm ? 'Слово обновлено' : `«${term}» добавлено в набор`, articleWarning ? 4200 : 2200);
    if (state.screen === 'learn') startLearnSession();
    if (state.screen === 'review') renderReview();
    if (state.screen === 'progress') renderProgress();
    } catch (error) { console.error(error); showToast('Слово не сохранено. Проверь соединение и попробуй ещё раз.', 5000); }
    finally { el.btnSaveWord.disabled = false; }
  }

  async function changeSetLanguage(event) {
    event.preventDefault();
    try {
    if (!state.activeSetId || isAggregateScope()) return;
    const language = selectedLanguage(el.editLanguageSelect, el.editLanguageOther);
    if (!language) { el.editLanguageOther.reportValidity(); return; }
    await state.store.updateSetLanguage(state.activeSetId, language);
    await refreshSetsList();
    await loadActiveSetTerms();
    renderSetSwitcher();
    if (state.screen === 'home') renderHome();
    closeSurface();
    showToast('Язык набора изменён');
    } catch (error) { console.error(error); showToast('Язык не сохранён. Попробуй ещё раз.', 5000); }
  }

  // ---------------------------------------------------------------------
  // Stats helpers
  // ---------------------------------------------------------------------
  function computeStats(terms) {
    const now = Date.now();
    const total = terms.length;
    const learned = terms.filter((t) => t.status === 'learned').length;
    const brandNew = terms.filter((t) => t.status === 'new').length;
    const learning = total - learned - brandNew;
    const dueToday = terms.filter((t) => t.status !== 'new' && Srs.isDue(t, now)).length;
    const totalAttempts = terms.reduce((s, t) => s + t.attempts, 0);
    const totalCorrect = terms.reduce((s, t) => s + t.correct_count, 0);
    const successRate = totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : 0;
    return { total, learned, new: brandNew, learning, dueToday, successRate };
  }

  function isDifficult(t) {
    return t.last_review_failed || (t.attempts >= 2 && t.status !== 'learned' && (t.correct_count / t.attempts) < 0.6);
  }

  // ---------------------------------------------------------------------
  // Learn session
  // ---------------------------------------------------------------------
  function buildLearnQueue(terms) {
    const now = Date.now();
    return Srs.selectSessionTerms(Srs.reviewPool(Ex.shuffle(terms),false,now),SESSION_SIZE,now).map(term=>term.id);
  }

  function getTermById(id) { return state.terms.find((t) => t.id === id); }

  function dailyGoal() {
    return [5, 10, 20].includes(Number(state.activity.dailyGoal)) ? Number(state.activity.dailyGoal) : 5;
  }

  function answerWord(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    return lastTwo >= 11 && lastTwo <= 14 ? 'ответов' : last === 1 ? 'ответ' : last >= 2 && last <= 4 ? 'ответа' : 'ответов';
  }

  function wordCountLabel(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? 'слов' : last === 1 ? 'слово' : last >= 2 && last <= 4 ? 'слова' : 'слов'}`;
  }

  function pointCountLabel(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? 'баллов' : last === 1 ? 'балл' : last >= 2 && last <= 4 ? 'балла' : 'баллов'}`;
  }

  function renderDailyGoal() {
    const goal = dailyGoal();
    const count = Srs.currentDailyCount(state.activity);
    const done = count >= goal;
    const streak = Srs.currentStreak(state.activity);
    el.dailyGoalCard.classList.toggle('completed', done);
    el.dailyGoalCount.textContent = `${count} / ${goal}`;
    el.dailyGoalMessage.textContent = done ? 'Цель выполнена. Отличная работа!' : `Осталось дать ${goal - count} ${answerWord(goal - count)}`;
    el.dailyGoalFill.style.width = `${Math.min(100, count / goal * 100)}%`;
    el.dailyGoalTrack.setAttribute('aria-valuemax', String(goal));
    el.dailyGoalTrack.setAttribute('aria-valuenow', String(Math.min(count, goal)));
    el.dailyStreakText.textContent = `${streak} дн.`;
    el.dailyStreak?.setAttribute('aria-label',`Серия: ${streak} дней. Открыть календарь`);
    el.dailyGoalSelect.value = String(goal);
    el.dailyGoalSelectLabel.textContent = el.dailyGoalSelect.selectedOptions[0]?.textContent || '';
    if(el.todayDate) el.todayDate.textContent=new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
    renderWeek();
  }

  function saveActivity() {
    const snapshot = { ...state.activity };
    writeJournal('activity',snapshot);
    updateSyncBadge();
    return flushPendingWrites();
  }

  function startLearnSession(customQueue, forceNew = false,taskBudget=20) {
    state.session.scoredPendingIds=new Set();
    const saved = forceNew ? null : readJournal('session');
    if (saved?.version === 1 && saved.progressModel === 4 && saved.setId === state.activeSetId && Date.now() - saved.updatedAt < 7 * 86400000 &&
        Array.isArray(saved.queue) && saved.queue.length && saved.queue.every(id => getTermById(id)) &&
        Number.isInteger(saved.initialLength) && saved.initialLength >= saved.queue.length &&
        Array.isArray(saved.reviewResults) && Array.isArray(saved.studied) &&
        (saved.reviewKinds === null || (Array.isArray(saved.reviewKinds) && saved.reviewKinds.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && Array.isArray(pair[1]) && pair[1].every(kind => ['multiple_choice','type_answer','spelling','flashcard'].includes(kind))))) &&
        saved.reviewResults.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && Number.isInteger(pair[1]?.count) && pair[1].count >= 0 && pair[1].count <= 3 && typeof pair[1].correct === 'boolean')) {
      try {
        state.session.reviewKinds = saved.reviewKinds ? new Map(saved.reviewKinds) : null;
        state.session.reviewResults = new Map(saved.reviewResults);
        state.session.studied = new Set(saved.studied);
        state.session.queue = saved.queue; state.session.initialLength = saved.initialLength;
        state.session.answered = false; state.session.pendingStudyTermId = null;
        if (saved.pendingNext) {
          const completed = saved.pendingNext.ids;
          if (!Array.isArray(completed)) throw new Error('Invalid session');
          completed.forEach(id => {
            const index = state.session.queue.indexOf(id);
            if (index >= 0) state.session.queue.splice(index, 1);
            if (state.session.reviewKinds) state.session.reviewKinds.get(id)?.shift();
          });
        }
        saveSession(); renderDailyGoal(); renderLearnStep(); showToast('Продолжаем незавершённое занятие'); return;
      } catch { writeJournal('session', null); }
    }
    const plan = customQueue ? Ex.buildReviewPlan(customQueue, state.terms,taskBudget) : null;
    const queue = plan ? plan.map((task) => task.termId) : buildLearnQueue(state.terms);
    state.session.reviewKinds = plan ? new Map() : null;
    plan?.forEach(task => {
      if (!state.session.reviewKinds.has(task.termId)) state.session.reviewKinds.set(task.termId, []);
      state.session.reviewKinds.get(task.termId).push(task.kind);
    });
    state.session.reviewResults = new Map();
    state.session.studied = new Set();
    state.session.queue = queue;
    state.session.initialLength = Math.max(queue.length, 1);
    state.session.answered = false;
    state.session.pendingStudyTermId = null;
    saveSession();
    renderDailyGoal();
    renderLearnStep();
  }

  function updateLearnProgress() {
    if(!el.learnProgressFill) return;
    const done = Math.min(state.session.initialLength,state.session.initialLength - state.session.queue.length + (state.session.scoredPendingIds?.size || 0));
    const pct = Math.max(0, Math.min(100, Math.round((done / state.session.initialLength) * 100)));
    el.learnProgressFill.style.width = pct + '%';
    const track = el.learnProgressFill.parentElement;
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Прогресс занятия');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(state.session.initialLength));
    track.setAttribute('aria-valuenow', String(done));
    el.learnCounter.textContent = state.session.queue.length
      ? `${done} / ${state.session.initialLength} заданий${state.session.reviewKinds ? ` · ${wordCountLabel(state.session.reviewKinds.size)}` : ''}`
      : 'Готово';
  }

  function renderLearnStep() {
    updateLearnProgress();

    if (state.session.queue.length === 0) {
      el.exerciseCard.hidden = true;
      el.learnEmpty.hidden = false;
      el.learnEmpty.querySelector('h2').textContent = state.session.reviewKinds ? 'Повторение завершено' : 'Занятие завершено';
      const failed = [...state.session.reviewResults.values()].filter((result) => !result.correct).length;
      const nextReviewAt = state.session.reviewKinds ? [...state.session.reviewKinds.keys()]
        .map(getTermById).filter(Boolean).map(term => Number(term.due_date))
        .filter(date => Number.isFinite(date) && date > Date.now())
        .reduce((earliest, date) => Math.min(earliest, date), Infinity) : Infinity;
      const nextReviewNote = Number.isFinite(nextReviewAt)
        ? ` Следующее напоминание — ${new Date(nextReviewAt).toLocaleString('ru-RU', {day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}.`
        : '';
      el.learnEmpty.querySelector('p').textContent = state.session.reviewKinds
        ? `Готово: ${wordCountLabel(state.session.reviewKinds.size)}, ${state.session.initialLength} заданий. ${failed ? `Стоит закрепить ещё ${wordCountLabel(failed)} во вкладке «Сложные».` : 'Все слова успешно повторены.'}${nextReviewNote}`
        : 'Результаты занятия учтены. В «Повторении» можно начать следующий подход или выбрать дополнительную практику.';
      const remaining=Math.max(0,dailyGoal()-Srs.currentDailyCount(state.activity));
      el.btnLearnEmptyToReview.textContent=remaining ? 'Продолжить практику' : 'Перейти к повторению';
      if(remaining) el.learnEmpty.querySelector('p').textContent+=` До ежедневной цели осталось дать ${remaining} ${answerWord(remaining)}.`;
      return;
    }
    el.exerciseCard.hidden = false;
    el.learnEmpty.hidden = true;

    const termId = state.session.queue[0];
    const term = getTermById(termId);
    if (!term) { // stale id (e.g. set switched mid-session) - just drop it
      state.session.queue.shift();
      renderLearnStep();
      return;
    }
    if (!String(term.term || '').trim() || !String(term.translation || '').trim()) {
      renderUnavailableCard(el.exerciseCard, 'У этого слова не хватает текста или перевода. Проверь его в разделе «Прогресс».');
      return;
    }

    // Phase 1: never-attempted words get a Study card before any test.
    if (term.attempts === 0 && !state.session.studied.has(term.id)) {
      state.session.studied.add(term.id);
      state.session.answered = false;
      renderStudyCard(term);
      return;
    }

    // Bonus "find the pair" round — only among words already past Study,
    // so it never collides with the Study->Test flow of brand-new words.
    const frontIds = state.session.queue.slice(0, 4);
    const frontTerms = frontIds.map(getTermById).filter(Boolean);
    const matchingLanguages = new Set(frontTerms.map((term) => (state.termMeta.get(term.id) || {}).language));
    if (!state.session.reviewKinds && frontTerms.length === 4 && Ex.buildMatching(frontTerms).termIds.length === 4 && matchingLanguages.size === 1 && frontTerms.every((t) => t.attempts > 0) && Math.random() < 0.2) {
      renderMatching(frontTerms);
      return;
    }

    state.session.answered = false;
    try {
      const kind = state.session.reviewKinds?.get(term.id)?.[0];
      const exercise = prepareExercise(kind ? Ex.buildExercise(kind, term, state.terms) : Ex.pickExerciseType(term, state.terms), term);
      renderExercise(exercise);
    } catch (error) {
      console.error('Could not render exercise', error, term.id);
      renderUnavailableCard(el.exerciseCard, 'Не удалось показать это задание. Можно пропустить карточку и проверить слово в «Прогрессе».');
    }
  }

  function renderUnavailableCard(card, message) {
    card.innerHTML = '';
    const heading = document.createElement('h2');
    heading.className = 'unavailable-heading';
    heading.textContent = 'Не удалось показать карточку';
    const details = document.createElement('p');
    details.className = 'muted';
    details.textContent = message;
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn btn-ghost';
    skip.textContent = 'Пропустить';
    skip.addEventListener('click', () => {
      const id = state.session.queue.shift(); state.session.reviewKinds?.get(id)?.shift();
      state.session.reviewResults.set(id, { count: 0, correct: false }); saveSession(); renderLearnStep();
    });
    card.append(heading, details, skip);
  }

  function advanceAfterAnswer(isCorrect) {
    state.session.scoredPendingIds?.clear();
    const id = state.session.queue.shift();
    if (state.session.reviewKinds) state.session.reviewKinds.get(id)?.shift();
    saveSession();
    setTimeout(() => { if (state.screen === 'learn') renderLearnStep(); }, 550);
  }

  async function scoreTerm(termId, isCorrect) {
    const term = getTermById(termId);
    if (!term) return;
    if (state.session.reviewKinds) {
      const result = state.session.reviewResults.get(termId) || { count: 0, correct: true };
      result.count++;
      result.correct = result.correct && isCorrect;
      state.session.reviewResults.set(termId, result);
    }
    // Each correct completed check earns a point, even in the same lesson.
    const previousLevel=term.mastery_level;
    Srs.applyAnswer(term, isCorrect, state.settings.intervalsDays);
    (state.session.scoredPendingIds ||= new Set()).add(termId);
    updateLearnProgress();
    term.practice_points = Math.max(0, (Number(term.practice_points) || 0) + (isCorrect ? 1 : -1));
    term.progress_updated_at=Date.now();
    state.activity = Srs.recordPractice(state.activity);
    renderDailyGoal();
    if(el.exerciseCard && !el.exerciseCard.querySelector('.matching-grid')) {
      el.exerciseCard.querySelector('.answer-progress')?.remove();
      const note=document.createElement('p');note.className='answer-progress';
      note.textContent=isCorrect
        ? `${term.mastery_level>previousLevel ? '+1 за правильный ответ.' : 'Ответ сохранён.'} Прогресс слова: ${term.mastery_level} / ${state.settings.intervalsDays.length}.${term.status==='learned' ? ' Слово изучено — иногда оно будет возвращаться для проверки.' : ''}`
        : `Прогресс слова: ${term.mastery_level} / ${state.settings.intervalsDays.length}. Заработанные ответы сохранены; слово отмечено для дополнительной практики.`;
      el.exerciseCard.append(note);
      if(el.answerStatus) el.answerStatus.textContent=note.textContent;
    }
    const location = state.chunkMap.get(termId);
    if (location) {
      pendingWrites.push({ setId: location.setId, term: JSON.parse(JSON.stringify(term)), activity: { ...state.activity } });
      pendingBackupAvailable = writeJournal('pending', pendingWrites);
      updateSyncBadge();
    }
    saveSession({ ids: [termId], correct: isCorrect });
    await flushPendingWrites();
  }

  function appendTermSource(card, term) {
    const label = termSourceLabel(term);
    if (!label) return;
    const source = document.createElement('div');
    source.className = 'term-source';
    source.textContent = label;
    card.appendChild(source);
  }

  // ---- Phase 1: Study card -------------------------------------------
  function renderStudyCard(term) {
    const card = el.exerciseCard;
    card.innerHTML = '';
    if (!String(term?.term || '').trim() || !String(term?.translation || '').trim()) {
      renderUnavailableCard(card, 'У этого слова не хватает текста или перевода.');
      return;
    }

    const badge = document.createElement('div');
    badge.className = 'phase-badge';
    badge.textContent = 'Изучение';
    card.appendChild(badge);
    appendTermSource(card, term);

    const termRow = document.createElement('div');
    termRow.className = 'term-heading-row';
    const t = document.createElement('div');
    t.className = 'study-term';
    t.textContent = term.term;
    termRow.appendChild(t);
    card.appendChild(termRow);

    const tr = document.createElement('div');
    tr.className = 'study-translation';
    tr.textContent = term.translation;
    card.appendChild(tr);

    if (term.context) {
      const ctx = document.createElement('div');
      ctx.className = 'exercise-context';
      ctx.textContent = '«' + term.context + '»';
      card.appendChild(ctx);
    }

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    card.appendChild(spacer);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Я запомнил';
    btn.addEventListener('click', () => renderPhase2Test(term));
    card.appendChild(btn);
  }

  // ---- Phase 2: immediate test on the same word -----------------------
  function renderPhase2Test(term) {
    if (state.session.reviewKinds) {
      state.session.answered = false;
      renderExercise(prepareExercise(Ex.buildExercise(state.session.reviewKinds.get(term.id)[0], term, state.terms), term));
      return;
    }
    const canMultipleChoice = state.terms.filter((t) => t.id !== term.id).length >= 3;
    const type = canMultipleChoice && Math.random() < 0.5 ? 'multiple_choice' : 'type_answer';
    const exercise = type === 'multiple_choice'
      ? Ex.buildMultipleChoice(term, state.terms)
      : Ex.buildTypeAnswer(term);
    exercise.kindLabel = 'Проверка';
    prepareExercise(exercise, term);
    state.session.answered = false;
    renderExercise(exercise);
  }

  function prepareExercise(exercise, term) {
    const meta = term && state.termMeta.get(term.id);
    exercise.answerLanguage = exercise.answerSide === 'term' && meta ? Ex.canonicalLanguage(meta.language) : 'ru';
    return exercise;
  }

  function maskedAnswer(answer) {
    const firstVariant = (answer || '').split(/\s*(?:[,;/|]|\s+или\s+)\s*/i)[0].trim();
    const germanArticles = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer']);
    return firstVariant.split(/\s+/).map((word, index) => {
      const clean = word.replace(/[^A-Za-zА-Яа-яЁёÄÖÜäöüß-]/g, '');
      if (!clean) return word;
      if (index === 0 && germanArticles.has(clean.toLocaleLowerCase())) return clean;
      const chars = Array.from(clean);
      return chars[0] + '•'.repeat(Math.max(1, Math.min(chars.length - 1, 8))) + ` (${chars.length})`;
    }).join(' ');
  }

  function revealTextHint(card, exercise, button) {
    if (button) button.disabled = true;
    let note = card.querySelector('.exercise-hint');
    if (!note) {
      note = document.createElement('div');
      note.className = 'exercise-hint';
      const anchor = card.querySelector('.feedback') || card.querySelector('.exercise-actions');
      card.insertBefore(note, anchor || null);
    }
    const answer = exercise.correctAnswer || exercise.answer || '';
    const escapedAnswer = answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safeContext = exercise.context && escapedAnswer
      ? exercise.context.replace(new RegExp(escapedAnswer, 'gi'), '_____')
      : exercise.context;
    note.textContent = safeContext
      ? `Контекст: «${safeContext}»`
      : `Подсказка: ${maskedAnswer(exercise.correctAnswer || exercise.answer)}`;
  }

  function makeHintButton(onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost hint-btn';
    button.textContent = 'Подсказка';
    button.addEventListener('click', () => onClick(button));
    return button;
  }

  // ---- Generic exercise rendering (multiple choice / type / spelling / flashcard) ----
  function renderExercise(exercise) {
    const card = el.exerciseCard;
    card.innerHTML = '';

    if (!exercise || !String(exercise.correctAnswer || exercise.answer || '').trim()) {
      renderUnavailableCard(card, 'У задания нет ответа. Проверь запись слова в «Прогрессе».');
      return;
    }

    const kindEl = document.createElement('div');
    kindEl.className = 'exercise-kind';
    kindEl.textContent = exercise.kindLabel;
    card.appendChild(kindEl);

    const exerciseTerm = exercise.termId ? getTermById(exercise.termId) : null;
    if (exerciseTerm) appendTermSource(card, exerciseTerm);

    if (exercise.kind === 'flashcard') {
      renderExerciseFlashcard(card, exercise);
      return;
    }

    const promptLabel = document.createElement('div');
    promptLabel.className = 'exercise-prompt-label';
    promptLabel.textContent = exercise.promptLabel;
    card.appendChild(promptLabel);

    if (exercise.prompt && exercise.kind !== 'spelling_missing') {
      const promptRow = document.createElement('div');
      promptRow.className = 'term-heading-row';
      const prompt = document.createElement('div');
      prompt.className = 'exercise-prompt';
      prompt.textContent = exercise.prompt;
      promptRow.appendChild(prompt);
      card.appendChild(promptRow);
    }

    const feedback = document.createElement('div');
    feedback.className = 'feedback';
    feedback.hidden = true;

    if (exercise.kind === 'multiple_choice') {
      const grid = document.createElement('div');
      grid.className = 'options-grid';
      exercise.options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.textContent = opt;
        btn.addEventListener('click', () => handleMultipleChoiceAnswer(opt, exercise, grid, feedback));
        grid.appendChild(btn);
      });
      card.appendChild(grid);
      card.appendChild(feedback);
      const hintRow = document.createElement('div');
      hintRow.className = 'exercise-actions hint-actions';
      hintRow.appendChild(makeHintButton((button) => {
        const wrong = Array.from(grid.children).find((item) => item.textContent !== exercise.correctAnswer && !item.disabled);
        if (wrong) {
          wrong.disabled = true;
          wrong.classList.add('hint-eliminated');
          button.disabled = true;
          button.textContent = 'Один вариант убран';
        }
      }));
      card.appendChild(hintRow);
      return;
    }

    if (exercise.kind === 'spelling_missing') {
      renderMissingLetters(card, exercise, feedback);
      return;
    }

    if (exercise.kind === 'type_answer') {
      const label=document.createElement('label');label.htmlFor='exerciseAnswer';label.className='exercise-answer-label';label.textContent='Твой ответ';
      const input = document.createElement('input');
      input.id='exerciseAnswer';input.name='answer';
      input.className = 'text-input';
      input.type = 'text';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-describedby','exerciseAnswerHelp');
      input.lang=exercise.answerLanguage || 'ru';
      const help=document.createElement('p');help.id='exerciseAnswerHelp';help.className='exercise-input-help';help.textContent='Не помнишь? Можно отправить пустой ответ.';
      card.appendChild(label);
      card.appendChild(input);
      card.appendChild(help);
      card.appendChild(feedback);
      const actions = buildActionsRow((button) => revealTextHint(card, exercise, button));
      const checkBtn = actions.querySelector('.btn-primary');
      checkBtn.textContent = 'Проверить';
      checkBtn.addEventListener('click', () => handleTypedAnswer(input.value, exercise, input, feedback, checkBtn));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkBtn.click(); });
      card.appendChild(actions);
      setTimeout(() => input.focus(), 50);
      return;
    }

    if (exercise.kind === 'spelling_scramble') {
      renderScramble(card, exercise, feedback);
      return;
    }
  }

  function renderMissingLetters(card, exercise, feedback) {
    const word = Array.from(exercise.correctAnswer || '');
    const missing = new Set(exercise.missingPositions || []);
    const line = document.createElement('div');
    line.className = 'spelling-line';
    line.setAttribute('aria-label', 'Вставь пропущенные буквы');
    const inputs = [];
    let group = document.createElement('span');
    group.className = 'spelling-word';
    const appendGroup = () => {
      if(group.childNodes.length) {group.style.setProperty('--letter-count',group.childElementCount);line.appendChild(group);}
      group = document.createElement('span');group.className = 'spelling-word';
    };
    word.forEach((char, index) => {
      if (/\s/.test(char)) { appendGroup(); return; }
      if (!missing.has(index)) {
        const letter = document.createElement('span');
        letter.className = 'spelling-letter';
        letter.textContent = char;
        group.appendChild(letter);
        return;
      }
      const input = document.createElement('input');
      input.className = 'spelling-box';
      input.type = 'text';
      input.maxLength = 1;
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', `Пропущенная буква ${inputs.length + 1}`);
      inputs.push({ index, input });
      group.appendChild(input);
    });
    appendGroup();
    if (!inputs.length) {
      renderUnavailableCard(card, 'В этом слове нет букв для заполнения.');
      return;
    }
    card.appendChild(line);
    card.appendChild(feedback);
    const actions = buildActionsRow((button) => revealTextHint(card, exercise, button));
    const checkBtn = actions.querySelector('.btn-primary');
    const check = () => {
      const answer = word.map((char, index) => inputs.find((item) => item.index === index)?.input.value || (missing.has(index) ? '' : char)).join('');
      handleTypedAnswer(answer, exercise, inputs.map((item) => item.input), feedback, checkBtn);
    };
    checkBtn.addEventListener('click', check);
    inputs.forEach(({ input }, position) => {
      input.addEventListener('input', (event) => {
        if (event.isComposing) return;
        input.value = Array.from(input.value).slice(-1).join('');
        if (input.value && position < inputs.length - 1) inputs[position + 1].input.focus();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !input.value && position > 0) {
          event.preventDefault();
          inputs[position - 1].input.focus();
          inputs[position - 1].input.value = '';
        }
        if (event.key === 'Enter') { event.preventDefault(); checkBtn.click(); }
      });
      input.addEventListener('paste', (event) => {
        const letters = Array.from(event.clipboardData?.getData('text') || '').filter((char) => !/\s/.test(char));
        if (!letters.length) return;
        event.preventDefault();
        letters.forEach((letter, offset) => { if (inputs[position + offset]) inputs[position + offset].input.value = letter; });
        inputs[Math.min(position + letters.length, inputs.length - 1)].input.focus();
      });
    });
    card.appendChild(actions);
    setTimeout(() => inputs[0].input.focus(), 50);
  }

  function buildActionsRow(onHint) {
    const row = document.createElement('div');
    row.className = 'exercise-actions';
    if (onHint) row.appendChild(makeHintButton(onHint));
    const primary = document.createElement('button');
    primary.className = 'btn btn-primary';
    primary.textContent = 'Проверить';
    row.appendChild(primary);
    return row;
  }

  function showFeedback(feedback, isCorrect, correctAnswer, note) {
    const card = feedback.closest('.exercise-card');
    if (card) {
      card.querySelectorAll('.exercise-hint, .hint-actions, .hint-btn').forEach((hint) => hint.remove());
    }
    feedback.hidden = false;
    feedback.className = 'feedback ' + (isCorrect ? 'ok' : 'bad');
    feedback.innerHTML = isCorrect
      ? `✓ Верно!${note ? `<span class="feedback-note">${escapeHtml(note)}</span>` : ''}`
      : `✗ Неверно. Правильный ответ: <strong>${escapeHtml(correctAnswer)}</strong>${note ? `<span class="feedback-note">${escapeHtml(note)}</span>` : ''}`;
  }

  function appendContinueButton(card, onNext) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Далее';
    btn.style.marginTop = '8px';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      // A durable local journal lets the next task start while the cloud write
      // completes. When journalling is unavailable, wait for confirmation.
      if (!pendingBackupAvailable) await saveQueue;
      if (saveFailure && !pendingBackupAvailable) {
        btn.disabled = false; showToast('Сначала повтори сохранение прогресса.', 4000); return;
      }
      state.session.scoredPendingIds?.clear();
      onNext();
    });
    card.appendChild(btn);
  }

  function offerRetry(exercise, isCorrect, feedback) {
    if (isCorrect) return false;
    exercise.failedAttempts = (exercise.failedAttempts || 0) + 1;
    if (exercise.failedAttempts >= 3) return false;
    feedback.hidden = false;
    feedback.className = 'feedback bad';
    feedback.textContent = `Пока неверно. Попробуй ещё раз · осталось попыток: ${3 - exercise.failedAttempts}`;
    return true;
  }

  function handleMultipleChoiceAnswer(chosen, exercise, grid, feedback) {
    if (state.session.answered) return;
    const isCorrect = chosen === exercise.correctAnswer;
    if (offerRetry(exercise, isCorrect, feedback)) {
      const wrong = Array.from(grid.children).find((btn) => btn.textContent === chosen);
      if (wrong) { wrong.classList.add('incorrect'); wrong.disabled = true; }
      return;
    }
    state.session.answered = true;
    Array.from(grid.children).forEach((btn) => {
      btn.classList.add('disabled-choice');
      if (btn.textContent === exercise.correctAnswer) btn.classList.add('correct');
      else if (btn.textContent === chosen && !isCorrect) btn.classList.add('incorrect');
    });
    showFeedback(feedback, isCorrect, exercise.correctAnswer,
      !isCorrect && exercise.answerLanguage === 'de' ? 'В немецком учитываются артикль и заглавная буква существительного.' : '');
    scoreTerm(exercise.termId, isCorrect);
    appendContinueButton(el.exerciseCard, () => advanceAfterAnswer(isCorrect));
  }

  function handleTypedAnswer(value, exercise, input, feedback, checkBtn) {
    if (state.session.answered) return;
    el.exerciseCard.querySelectorAll('.alias-accept').forEach(button => button.remove());
    const term = getTermById(exercise.termId);
    const options = { language: exercise.answerLanguage, strict: exercise.kind === 'spelling_missing',
      alternatives: exercise.answerSide === 'translation' ? term?.translationAliases : [] };
    const isCorrect = Ex.answersMatch(value, exercise.correctAnswer, options);
    if (!isCorrect && exercise.kind !== 'spelling_missing' && exercise.answerLanguage !== 'de' &&
        Ex.isPossibleTypo(value, exercise.correctAnswer, options)) {
      feedback.hidden = false; feedback.className = 'feedback bad';
      feedback.textContent = 'Возможно, опечатка. Проверь написание — попытка не потрачена.';
      input.focus(); return;
    }
    const finish = correct => {
      state.session.answered = true;
      (Array.isArray(input) ? input : [input]).forEach(field => { field.disabled = true; });
      checkBtn.remove();
      showFeedback(feedback, correct, exercise.correctAnswer,
        correct && exercise.answerLanguage === 'en' && Ex.isEnglishSpellingVariant(value, exercise.correctAnswer)
          ? 'Британский и американский варианты написания равнозначны.'
          : !correct && exercise.answerLanguage === 'de' ? 'В немецком учитываются артикль и заглавная буква существительного.' : '');
      scoreTerm(exercise.termId, correct);
      appendContinueButton(el.exerciseCard, () => advanceAfterAnswer(correct));
    };
    const offerAlias = () => {
      const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'btn btn-ghost alias-accept';
      accept.textContent = 'Мой перевод тоже верен';
      accept.onclick = async () => {
        if (!await confirmDialog(`Засчитать «${value.trim()}» и сохранить его как вариант перевода этого слова?`, {title:'Добавить перевод?',action:'Засчитать'})) return;
        term.translationAliases ||= [];
        if (!term.translationAliases.some(alias => Ex.normalize(alias) === Ex.normalize(value))) {
          term.translationAliases.push(value.trim());
          term.translationAliases = term.translationAliases.slice(-30);
        }
        el.exerciseCard.querySelectorAll('.alias-accept, .alias-reject').forEach(button => button.remove());
        finish(true);
      };
      el.exerciseCard.append(accept);
    };
    if (!isCorrect && exercise.kind === 'type_answer' && exercise.answerSide === 'translation' && value.trim() &&
        (exercise.failedAttempts || 0) >= 2) {
      feedback.hidden = false; feedback.className = 'feedback bad';
      feedback.innerHTML = `В наборе указан ответ: <strong>${escapeHtml(exercise.correctAnswer)}</strong>. Если твой перевод тоже верен, добавь его как вариант.`;
      checkBtn.remove();
      const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'btn btn-ghost alias-reject';
      reject.textContent = 'Считать ошибкой';
      reject.onclick = () => { el.exerciseCard.querySelector('.alias-accept')?.remove(); reject.remove(); finish(false); };
      offerAlias(); el.exerciseCard.append(reject);
      return;
    }
    if (offerRetry(exercise, isCorrect, feedback)) {
      if (!isCorrect && exercise.kind === 'type_answer' && exercise.answerSide === 'translation' && value.trim()) offerAlias();
      const fields = Array.isArray(input) ? input : [input];
      (fields.find((field) => Array.isArray(input) && field.value !== Array.from(exercise.correctAnswer)[exercise.missingPositions[fields.indexOf(field)]]) || fields[0]).focus();
      return;
    }
    finish(isCorrect);
  }

  function renderScramble(card, exercise, feedback) {
    const assembledRow = document.createElement('div');
    assembledRow.className = 'assembled-row';

    const tilesRow = document.createElement('div');
    tilesRow.className = 'letter-tiles';

    let assembled = [];
    const tileEls = exercise.tiles.map((unit, idx) => {
      const tile = document.createElement('button'); tile.type = 'button';
      tile.className = 'letter-tile';
      tile.textContent = unit;
      tile.addEventListener('click', () => {
        if (state.session.answered || tile.classList.contains('used')) return;
        tile.classList.add('used');
        assembled.push({ unit, idx });
        renderAssembled();
        if (assembled.length === exercise.tiles.length) checkScramble();
      });
      tilesRow.appendChild(tile);
      return tile;
    });

    function renderAssembled() {
      assembledRow.innerHTML = '';
      assembled.forEach((a) => {
        const t = document.createElement('button'); t.type = 'button';
        t.className = 'letter-tile';
        t.textContent = a.unit;
        t.addEventListener('click', () => {
          if (state.session.answered) return;
          assembled = assembled.filter((x) => x !== a);
          tileEls[a.idx].classList.remove('used');
          renderAssembled();
        });
        assembledRow.appendChild(t);
      });
    }

    function checkScramble() {
      if (state.session.answered) return;
      const userAnswer = assembled.map((a) => a.unit).join(exercise.joinWith);
      const isCorrect = Ex.answersMatch(userAnswer, exercise.correctAnswer, { language: exercise.answerLanguage, strict: true });
      if (offerRetry(exercise, isCorrect, feedback)) return;
      state.session.answered = true;
      showFeedback(feedback, isCorrect, exercise.correctAnswer,
        !isCorrect && exercise.answerLanguage === 'de' ? 'В немецком учитываются артикль и заглавная буква существительного.' : '');
      scoreTerm(exercise.termId, isCorrect);
      appendContinueButton(el.exerciseCard, () => advanceAfterAnswer(isCorrect));
    }

    card.appendChild(assembledRow);
    card.appendChild(tilesRow);
    card.appendChild(feedback);
    const hintRow = document.createElement('div');
    hintRow.className = 'exercise-actions hint-actions';
    hintRow.appendChild(makeHintButton((button) => revealTextHint(card, exercise, button)));
    card.appendChild(hintRow);
  }

  function renderExerciseFlashcard(card, exercise) {
    const promptLabel = document.createElement('div');
    promptLabel.className = 'exercise-prompt-label';
    promptLabel.textContent = exercise.promptLabel;
    card.appendChild(promptLabel);

    const face = document.createElement('div');
    face.className = 'flash-face';
    face.setAttribute('role', 'button');
    face.setAttribute('tabindex', '0');
    const promptText = document.createElement('div');
    promptText.className = 'exercise-prompt';
    promptText.textContent = exercise.prompt;
    const hint = document.createElement('div');
    hint.className = 'flash-hint';
    hint.textContent = 'Нажми, чтобы посмотреть перевод';
    face.appendChild(promptText);
    face.appendChild(hint);
    card.appendChild(face);

    let revealed = false;
    face.addEventListener('click', () => {
      if (revealed) return;
      revealed = true;
      hint.remove();
      const answer = document.createElement('div');
      answer.className = 'flash-answer';
      answer.textContent = exercise.answer;
      face.appendChild(answer);
      showFlashButtons();
    });
    face.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        face.click();
      }
    });

    function showFlashButtons() {
      const actions = document.createElement('div');
      actions.className = 'exercise-actions';
      const forgot = document.createElement('button');
      forgot.className = 'btn btn-ghost';
      forgot.textContent = 'Забыл';
      const remember = document.createElement('button');
      remember.className = 'btn btn-primary';
      remember.textContent = 'Помню';
      actions.appendChild(forgot);
      actions.appendChild(remember);
      card.appendChild(actions);

      const answerOnce = (isCorrect) => {
        if (state.session.answered) return;
        state.session.answered = true;
        actions.remove();
        scoreTerm(exercise.termId, isCorrect);
        const feedback = document.createElement('div');
        feedback.className = `feedback ${isCorrect ? 'ok' : 'bad'}`;
        feedback.textContent = isCorrect
          ? `✓ Помню: ${exercise.prompt} — ${exercise.answer}`
          : `Перевод: ${exercise.prompt} — ${exercise.answer}`;
        card.appendChild(feedback);
        appendContinueButton(card, () => advanceAfterAnswer(isCorrect));
      };
      forgot.addEventListener('click', () => answerOnce(false));
      remember.addEventListener('click', () => answerOnce(true));
    }
  }

  function renderMatching(terms) {
    const exercise = Ex.buildMatching(terms);
    const card = el.exerciseCard;
    card.innerHTML = '';

    const kindEl = document.createElement('div');
    kindEl.className = 'exercise-kind';
    kindEl.textContent = exercise.kindLabel;
    card.appendChild(kindEl);

    const label = document.createElement('div');
    label.className = 'exercise-prompt-label';
    label.textContent = exercise.promptLabel;
    card.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'matching-grid';
    card.appendChild(grid);

    const leftHeading = document.createElement('div');
    leftHeading.className = 'match-heading';
    leftHeading.textContent = 'Русский';
    const rightHeading = document.createElement('div');
    rightHeading.className = 'match-heading';
    const firstTerm = terms[0];
    const firstMeta = firstTerm && state.termMeta.get(firstTerm.id);
    rightHeading.textContent = firstMeta ? languageLabel(firstMeta.language) : 'Изучаемый язык';
    grid.appendChild(leftHeading);
    grid.appendChild(rightHeading);

    let selectedLeft = null;
    let selectedRight = null;
    let solvedIds = new Set();
    let checkingPair = false;

    function makeCell(item) {
      const cell = document.createElement('button'); cell.type = 'button';
      cell.className = 'match-cell';
      cell.textContent = item.text;
      cell.dataset.termId = item.termId;
      cell.dataset.side = item.side;
      cell.setAttribute('aria-pressed', 'false');
      cell.addEventListener('click', () => onCellClick(cell, item));
      return cell;
    }

    exercise.left.forEach((item, index) => {
      grid.appendChild(makeCell(item));
      if (exercise.right[index]) grid.appendChild(makeCell(exercise.right[index]));
    });

    const hintRow = document.createElement('div');
    hintRow.className = 'exercise-actions hint-actions';
    hintRow.appendChild(makeHintButton((button) => {
      const availableId = exercise.termIds.find((id) => !solvedIds.has(id));
      if (!availableId) return;
      const pair = Array.from(grid.querySelectorAll(`[data-term-id="${CSS.escape(availableId)}"]`));
      pair.forEach((item) => item.classList.add('hint-pair'));
      button.disabled = true;
      setTimeout(() => pair.forEach((item) => item.classList.remove('hint-pair')), 1300);
    }));
    card.appendChild(hintRow);

    function onCellClick(cell, item) {
      if (checkingPair || cell.classList.contains('solved')) return;
      if (item.side === 'term') {
        if (selectedLeft) { selectedLeft.el.classList.remove('selected'); selectedLeft.el.setAttribute('aria-pressed', 'false'); }
        selectedLeft = { el: cell, termId: item.termId };
        cell.classList.add('selected');
        cell.setAttribute('aria-pressed', 'true');
      } else {
        if (selectedRight) { selectedRight.el.classList.remove('selected'); selectedRight.el.setAttribute('aria-pressed', 'false'); }
        selectedRight = { el: cell, termId: item.termId };
        cell.classList.add('selected');
        cell.setAttribute('aria-pressed', 'true');
      }
      if (selectedLeft && selectedRight) {
        if (selectedLeft.termId === selectedRight.termId) {
          selectedLeft.el.classList.remove('selected');
          selectedRight.el.classList.remove('selected');
          selectedLeft.el.classList.add('solved');
          selectedRight.el.classList.add('solved');
          selectedLeft.el.disabled = true; selectedRight.el.disabled = true;
          selectedLeft.el.setAttribute('aria-pressed', 'false'); selectedRight.el.setAttribute('aria-pressed', 'false');
          solvedIds.add(selectedLeft.termId);
          selectedLeft = null; selectedRight = null;
          if (solvedIds.size === exercise.termIds.length) finishMatching();
        } else {
          const wrongEls = [selectedLeft.el, selectedRight.el];
          checkingPair = true;
          wrongEls.forEach((c) => c.classList.add('wrong'));
          setTimeout(() => {
            wrongEls.forEach((c) => { c.classList.remove('wrong'); c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
            checkingPair = false;
          }, 450);
          selectedLeft = null; selectedRight = null;
        }
      }
    }

    function finishMatching() {
      hintRow.remove();
      exercise.termIds.forEach((id) => scoreTerm(id, true));
      saveSession({ ids: exercise.termIds, correct: true });
      const note = document.createElement('div');
      note.className = 'feedback ok';
      note.textContent = '✓ Все пары найдены!';
      card.appendChild(note);
      appendContinueButton(card, () => {
        state.session.queue = state.session.queue.filter((id) => !exercise.termIds.includes(id));
        saveSession();
        setTimeout(() => { if (state.screen === 'learn') renderLearnStep(); }, 50);
      });
    }
  }

  // ---------------------------------------------------------------------
  // Review screen
  // ---------------------------------------------------------------------
  function statTile(num, label) {
    return `<div class="stat-tile"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  }

  function effectiveReviewSize(poolSize) {
    return Math.max(0, Math.min(state.reviewSize, poolSize));
  }

  function quickReviewPool() {
    return Srs.reviewPool(state.terms,state.extraPractice);
  }

  function chooseReviewTerms(pool, count) {
    const now = Date.now();
    return Srs.selectSessionTerms(Ex.shuffle(pool),count,now);
  }

  function renderReviewSizeControl() {
    const poolSize = quickReviewPool().length;
    const max = Math.max(1, poolSize);
    const value = Math.max(1, Math.min(state.reviewSize, max));
    el.reviewSize.max = String(max);
    el.reviewSize.value = String(value);
    el.reviewSize.disabled = poolSize === 0;
    el.reviewSizeValue.value = String(poolSize ? value : 0);
    el.reviewSizeValue.textContent = String(poolSize ? value : 0);
    el.reviewSizeMax.textContent = String(poolSize);
    el.reviewSize.style.setProperty('--range-progress', `${poolSize ? (max === 1 ? 100 : (value - 1) / (max - 1) * 100) : 0}%`);
    el.reviewSize.setAttribute('aria-valuetext', `${poolSize ? value : 0} из ${poolSize} слов`);
  }

  function updateReviewSizeInput(rawValue) {
    const max = Math.max(1, quickReviewPool().length);
    const raw = Math.max(1, Math.min(max, Number(rawValue) || 1));
    state.reviewSize = Math.round(raw);
    el.reviewSizeValue.value = String(state.reviewSize);
    el.reviewSizeValue.textContent = String(state.reviewSize);
    el.reviewSize.style.setProperty('--range-progress', `${max === 1 ? 100 : (raw - 1) / (max - 1) * 100}%`);
    el.reviewSize.setAttribute('aria-valuetext', `${state.reviewSize} из ${quickReviewPool().length} слов`);
    el.btnQuickReview.textContent = `Повторить сейчас · ${effectiveReviewSize(quickReviewPool().length)}`;
    if (!el.btnStartReview.hidden) el.btnStartReview.textContent = `Повторить эти слова · ${effectiveReviewSize(Srs.reviewPool(filteredReviewTerms(),state.extraPractice).length)}`;
  }

  function renderReview() {
    const stats = computeStats(state.terms);
    const quickPoolSize = quickReviewPool().length;
    renderStreak();
    renderReviewSizeControl();
    el.btnQuickReview.hidden = quickPoolSize === 0;
    el.btnQuickReview.textContent = `Повторить сейчас · ${effectiveReviewSize(quickPoolSize)}`;
    el.btnExtraPractice.textContent=state.extraPractice ? 'Вернуться к плану' : 'Тренироваться раньше срока';
    el.btnExtraPractice.setAttribute('aria-pressed',String(state.extraPractice));
    const nextAt=state.terms.filter(term=>term.status!=='new' && Number(term.due_date)>Date.now()).reduce((next,term)=>Math.min(next,term.due_date),Infinity);
    el.reviewPlanNote.textContent=state.extraPractice
      ? 'Свободная практика: доступны все слова. Каждый правильный ответ прибавляет прогресс.'
      : quickPoolSize
        ? 'Новые и сложные слова — в приоритете. Изученные иногда возвращаются для проверки.'
        : `На сейчас всё повторено.${Number.isFinite(nextAt) ? ` Следующее напоминание — ${new Date(nextAt).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}.` : ''} Можно выбрать свободную практику.`;
    el.reviewStats.innerHTML =
      statTile(stats.learning, 'Учатся') +
      statTile(stats.dueToday, 'Сегодня') +
      statTile(stats.successRate + '%', 'Точность');

    renderReviewList();
    requestAnimationFrame(() => positionReviewIndicator(el.reviewTabs.querySelector('.tab.active')));
  }

  function positionReviewIndicator(tab) {
    if (!tab || !el.reviewTabIndicator) return;
    el.reviewTabIndicator.style.width = tab.offsetWidth + 'px';
    el.reviewTabIndicator.style.transform = `translateX(${tab.offsetLeft}px)`;
  }

  function filteredReviewTerms() {
    const now = Date.now();
    switch (state.reviewFilter) {
      case 'due': return Srs.reviewPool(state.terms,false,now);
      case 'difficult': return state.terms.filter(isDifficult);
      case 'learned': return state.terms.filter((t) => t.status === 'learned');
      case 'stale': return state.terms.filter((t) => Srs.isStale(t, 14, now));
      default: return [];
    }
  }

  function badgeFor(term) {
    if (term.status === 'learned' && Srs.needsReminder(term, state.settings.intervalsDays))
      return '<span class="badge badge-learning">Пора повторить</span>';
    if (term.status === 'learned') return '<span class="badge badge-learned">Изучено</span>';
    if (term.status === 'new') return '<span class="badge badge-new">Новое</span>';
    return '<span class="badge badge-learning">Учится</span>';
  }

  const EMPTY_NOTES = {
    due: 'Доступные слова повторены. Изученные будут иногда возвращаться для проверки.',
    difficult: 'Сложных слов пока нет — отличная работа!',
    learned: 'Пока нет изученных слов. Продолжай заниматься в разделе «Учить».',
    stale: 'Нет слов, которые давно не повторялись.'
  };

  function renderReviewList() {
    const items = filteredReviewTerms();
    const eligible = Srs.reviewPool(items,state.extraPractice);
    if (items.length === 0) {
      el.reviewList.innerHTML = `<div class="empty-note">${EMPTY_NOTES[state.reviewFilter]}</div>`;
      el.btnStartReview.hidden = true;
      return;
    }
    el.reviewList.innerHTML = items.map((t) => `
      <div class="review-item">
        <div class="review-item-main">
          <div class="review-item-term">${escapeHtml(t.term)}</div>
          <div class="review-item-tr">${escapeHtml(t.translation)}</div>
          <div class="term-source">${escapeHtml(termSourceLabel(t))}</div>
        </div>
        ${badgeFor(t)}
      </div>
    `).join('');
    el.btnStartReview.hidden = eligible.length === 0;
    el.btnStartReview.textContent = `Повторить эти слова · ${effectiveReviewSize(eligible.length)}`;
    el.btnStartReview.onclick = () => {
      const ids = chooseReviewTerms(eligible, effectiveReviewSize(eligible.length)).map((t) => t.id);
      showScreen('learn', ids);
    };
  }

  async function startQuickReview() {
    const pool = quickReviewPool();
    const ids = chooseReviewTerms(pool, effectiveReviewSize(pool.length)).map((term) => term.id);
    if (ids.length === 0) return;
    const saved = readJournal('session');
    if (hasSessionTasks(saved) &&
        !await confirmDialog('Начать новое повторение вместо незавершённого занятия? Прогресс слов останется.', {title:'Новое повторение?',action:'Начать'})) return;
    showScreen('learn', ids, true);
  }

  function renderFlashcard() {
    const { items, index, revealed } = state.flashcards;
    const term = items[index];
    if (!term) return;
    el.flashcardPosition.textContent = `${index + 1} / ${items.length}`;
    el.flashcardSource.textContent = termSourceLabel(term);
    el.flashcardTerm.textContent = term.term;
    el.flashcardTranslation.textContent = term.translation;
    el.flashcardContext.textContent = term.context ? `«${term.context}»` : '';
    el.flashcardReveal.hidden = revealed;
    el.flashcardTranslation.hidden = !revealed;
    el.flashcardContext.hidden = !revealed || !term.context;
    el.flashcardFace.classList.toggle('revealed', revealed);
    el.flashcardFace.setAttribute('aria-label', revealed ? 'Скрыть перевод' : 'Показать перевод');
    el.btnPreviousFlashcard.disabled = index === 0;
    el.btnNextFlashcard.textContent = index === items.length - 1 ? 'Готово' : 'Далее →';
  }

  function openFlashcards() {
    if (!state.terms.length) return;
    state.flashcards = { items: Ex.shuffle([...state.terms]), index: 0, revealed: false };
    el.flashcardBackdrop.hidden = false;
    $('#app').inert = true;
    renderFlashcard();
    el.btnCloseFlashcards.focus();
  }

  function closeFlashcards() {
    if (el.flashcardBackdrop.hidden) return;
    el.flashcardBackdrop.hidden = true;
    $('#app').inert = false;
    el.btnBrowseCards.focus();
  }

  function moveFlashcard(direction) {
    const next = state.flashcards.index + direction;
    if (next < 0) return;
    if (next >= state.flashcards.items.length) { closeFlashcards(); return; }
    state.flashcards.index = next;
    state.flashcards.revealed = false;
    renderFlashcard();
  }

  // ---------------------------------------------------------------------
  // Progress screen
  // ---------------------------------------------------------------------
  function renderProgress() {
    renderDailyGoal();
    const stats = computeStats(state.terms);
    const remaining = stats.total - stats.learned;
    const streak = Srs.currentStreak(state.activity);
    el.progressStats.innerHTML =
      statTile(stats.total, 'Всего слов') +
      statTile(stats.learned, 'Изучено') +
      statTile(remaining, 'Осталось') +
      statTile(stats.successRate + '%', 'Точность');

    const intervals = state.settings.intervalsDays;
    const pct = Srs.masteryPercent(state.terms, intervals);
    el.progressBarFill.style.width = pct + '%';
    el.progressBarLabel.innerHTML = `<strong>${pct}%</strong><span>общий прогресс</span>`;

    const sorted = [...state.terms].sort((a, b) => {
      const order = { learning: 0, new: 1, learned: 2 };
      return order[a.status] - order[b.status] || a.term.localeCompare(b.term);
    });

    el.wordTable.innerHTML = sorted.map((t) => {
      const dots = Array.from({ length: intervals.length }, (_, i) =>
        `<span class="mastery-dot ${i < Srs.effectiveMastery(t, intervals) ? 'filled' : ''}"></span>`).join('');
      const nextReview = new Date(t.due_date).toLocaleDateString('ru-RU');
      return `
        <div class="word-row">
          <div class="word-row-top">
            <div class="word-row-term">${escapeHtml(t.term)} <span class="word-row-translation">— ${escapeHtml(t.translation)}</span></div>
            <div class="word-row-actions">
              ${badgeFor(t)}
              <button class="word-edit-btn" type="button" data-edit-term="${escapeHtml(t.id)}" aria-label="Изменить ${escapeHtml(t.term)}">Изменить</button>
            </div>
          </div>
          <div class="term-source">${escapeHtml(termSourceLabel(t))}</div>
          <div class="word-row-details">
            <span>Верных ответов: ${t.correct_count} / ${t.attempts}</span>
            <span>Для изучения: ${Srs.effectiveMastery(t, intervals)} / ${intervals.length}</span>
            <span>${t.status==='learned' ? 'Напоминание: '+nextReview : 'Можно продолжать сейчас'}</span>
            <span class="mastery-dots">${dots}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderStreak() {
    const streak = Srs.currentStreak(state.activity);
    const doneToday = state.activity.lastDay === Srs.localDay();
    const lastTwoDigits = streak % 100;
    const lastDigit = streak % 10;
    const dayWord = lastTwoDigits >= 11 && lastTwoDigits <= 14 ? 'дней'
      : lastDigit === 1 ? 'день' : lastDigit >= 2 && lastDigit <= 4 ? 'дня' : 'дней';
    el.reviewStreak.innerHTML = `<span class="streak-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13.5 2.5c.1 3-1.4 4.2-1.5 6.6-1.3-1-1.8-2.7-1.7-3.8-3.6 2.4-5.4 5.2-5.4 8.6a7.1 7.1 0 0 0 14.2 0c0-4.5-2.7-7.7-5.6-11.4Z"/></svg></span>
      <div><strong>${streak} ${dayWord} подряд</strong>
      <span>${doneToday ? 'Сегодня уже занимались' : 'Ответь хотя бы на одно слово сегодня'}</span></div><span class="streak-calendar-label">Календарь</span>`;
    el.reviewStreak.setAttribute('aria-label',`${streak} ${dayWord} подряд. Открыть календарь`);
  }

  let calendarMonth=null, calendarSelected=null, calendarFocus=null;
  function renderWeek() {
    if(!el.weekStrip) return;
    const today=Srs.localDay(), weekday=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7;
    const labels=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    el.weekStrip.innerHTML=labels.map((label,index)=>{
      const day=Srs.shiftDay(today,index-weekday), active=!!state.activity.history?.[day];
      return `<span class="week-day ${active ? 'practiced' : ''} ${day===today ? 'today' : ''}" ${day===today ? 'aria-current="date"' : ''}><span>${label}</span><strong>${Number(day.slice(8))}</strong><i aria-hidden="true"></i></span>`;
    }).join('');
  }
  function openCalendar(event) {
    calendarFocus=event?.currentTarget || document.activeElement;calendarMonth=Srs.localDay().slice(0,7);calendarSelected=Srs.localDay();
    $('#app').inert=true;el.calendarBackdrop.hidden=false;renderCalendar();el.btnCloseCalendar.focus();
  }
  function closeCalendar() {
    if(el.calendarBackdrop.hidden) return;
    el.calendarBackdrop.hidden=true;$('#app').inert=false;calendarFocus?.focus();
  }
  function renderCalendar() {
    const today=Srs.localDay(), history=state.activity.history || {};
    el.calendarMonth.textContent=new Date(calendarMonth+'-01T12:00:00').toLocaleDateString('ru-RU',{month:'long',year:'numeric'}).replace(' г.','');
    el.calendarCurrent.textContent=String(Srs.currentStreak(state.activity));
    el.calendarBest.textContent=String(state.activity.longest || 0);
    el.calendarTotal.textContent=String(Object.keys(history).length);
    el.btnCalendarNext.disabled=calendarMonth>=today.slice(0,7);
    el.btnCalendarPrev.disabled=calendarMonth<='1900-01';
    const inferred=new Set(state.activity.inferredDays || []);
    el.calendarGrid.innerHTML=Srs.calendarDays(calendarMonth,today).map(({day,inMonth,future})=>{
      if(!inMonth) return '<span class="calendar-empty" aria-hidden="true"></span>';
      const count=history[day] || 0, label=new Date(day+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
      return `<button type="button" class="calendar-day ${count ? 'practiced' : ''} ${day===today ? 'today' : ''} ${inferred.has(day) ? 'inferred' : ''}" data-calendar-day="${day}" aria-label="${escapeHtml(label)}: ${future ? 'ещё впереди' : inferred.has(day) ? 'восстановлено из старой серии' : `${count} ${answerWord(count)}`}" aria-pressed="${day===calendarSelected}" ${future ? 'disabled' : ''} ${day===today ? 'aria-current="date"' : ''}>${Number(day.slice(8))}<i aria-hidden="true"></i></button>`;
    }).join('');
    const selected=calendarSelected?.startsWith(calendarMonth) ? calendarSelected : null;
    const monthDays=Object.keys(history).filter(day=>day.startsWith(calendarMonth)).length;
    el.calendarDetail.textContent=selected
      ? inferred.has(selected) ? 'Этот день восстановлен из прежней серии. Число ответов неизвестно.'
        : `${new Date(selected+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'})} · ${history[selected] || 0} ${answerWord(history[selected] || 0)}`
      : `Дней с занятиями в этом месяце: ${monthDays}`;
  }
  function moveCalendar(direction) {
    const date=new Date(calendarMonth+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+direction);
    calendarMonth=date.toISOString().slice(0,7);calendarSelected=null;renderCalendar();
  }

  // ---------------------------------------------------------------------
  // Boot + event wiring (deferred to DOMContentLoaded so every element
  // referenced below is guaranteed to exist first)
  // ---------------------------------------------------------------------
  function cacheDom() {
    el = {
      mainHeader: $('#mainHeader'),
      skipContent:$('#skipContent'),answerStatus:$('#answerStatus'),todayDate:$('#todayDate'),
      btnHomeContinue:$('#btnHomeContinue'),homeScopeLabel:$('#homeScopeLabel'),
      weekStrip:$('#weekStrip'),
      dailyStreak:$('#dailyStreak'),
      calendarBackdrop:$('#calendarBackdrop'),btnCloseCalendar:$('#btnCloseCalendar'),
      calendarMonth:$('#calendarMonth'),calendarGrid:$('#calendarGrid'),calendarDetail:$('#calendarDetail'),
      calendarCurrent:$('#calendarCurrent'),calendarBest:$('#calendarBest'),calendarTotal:$('#calendarTotal'),
      btnCalendarPrev:$('#btnCalendarPrev'),btnCalendarNext:$('#btnCalendarNext'),
      btnBackHome: $('#btnBackHome'),
      topbarTitle: $('#topbarTitle'),
      setSwitch: $('#setSwitch'),
      setSelect: $('#setSelect'),
      btnSetMenu: $('#btnSetMenu'),
      setMenu: $('#setMenu'),
      btnAddSet: $('#btnAddSet'),
      btnAddWord: $('#btnAddWord'),
      btnEditLanguage: $('#btnEditLanguage'),
      btnDeleteSet: $('#btnDeleteSet'),
      btnTheme: $('#btnTheme'),
      syncBadge: $('#syncBadge'),

      screens: {
        loading: $('#screen-loading'),
        import: $('#screen-import'),
        home: $('#screen-home'),
        learn: $('#screen-learn'),
        review: $('#screen-review'),
        progress: $('#screen-progress')
      },
      bottomnav: $('#bottomnav'),

      importTitle: $('#importTitle'),
      importSubtitle: $('#importSubtitle'),
      setNameInput: $('#setNameInput'),
      setLanguageSelect: $('#setLanguageSelect'),
      setLanguageOther: $('#setLanguageOther'),
      fileInput: $('#fileInput'),
      dropzone: $('#dropzone'),
      btnLoadDemo: $('#btnLoadDemo'),
      btnCancelImport: $('#btnCancelImport'),
      importErrors: $('#importErrors'),
      learnProgressFill: $('#learnProgressFill'),
      dailyGoalCard: $('#dailyGoalCard'),
      dailyGoalCount: $('#dailyGoalCount'),
      dailyGoalMessage: $('#dailyGoalMessage'),
      dailyGoalFill: $('#dailyGoalFill'),
      dailyGoalTrack: $('#dailyGoalTrack'),
      dailyStreak: $('#dailyStreak'),
      dailyStreakText: $('#dailyStreakText'),
      dailyGoalSelect: $('#dailyGoalSelect'),
      dailyGoalSelectLabel: $('#dailyGoalSelectLabel'),
      homeSetList: $('#homeSetList'),
      btnHomeAddSet: $('#btnHomeAddSet'),
      learnCounter: $('#learnCounter'),
      exerciseCard: $('#exerciseCard'),
      learnEmpty: $('#learnEmpty'),
      btnLearnEmptyToReview: $('#btnLearnEmptyToReview'),

      reviewStats: $('#reviewStats'),
      reviewStreak: $('#reviewStreak'),
      btnQuickReview: $('#btnQuickReview'),
      btnExtraPractice:$('#btnExtraPractice'),reviewPlanNote:$('#reviewPlanNote'),
      btnBrowseCards: $('#btnBrowseCards'),
      reviewSize: $('#reviewSize'),
      reviewSizeValue: $('#reviewSizeValue'),
      reviewSizeMax: $('#reviewSizeMax'),
      reviewTabs: $('#reviewTabs'),
      reviewTabIndicator: $('#reviewTabIndicator'),
      reviewList: $('#reviewList'),
      btnStartReview: $('#btnStartReview'),

      progressStats: $('#progressStats'),
      progressBarFill: $('#progressBarFill'),
      progressBarLabel: $('#progressBarLabel'),
      wordTable: $('#wordTable'),

      flashcardBackdrop: $('#flashcardBackdrop'),
      flashcardPosition: $('#flashcardPosition'),
      flashcardSource: $('#flashcardSource'),
      flashcardTerm: $('#flashcardTerm'),
      flashcardReveal: $('#flashcardReveal'),
      flashcardTranslation: $('#flashcardTranslation'),
      flashcardContext: $('#flashcardContext'),
      flashcardFace: $('#flashcardFace'),
      btnCloseFlashcards: $('#btnCloseFlashcards'),
      btnPreviousFlashcard: $('#btnPreviousFlashcard'),
      btnNextFlashcard: $('#btnNextFlashcard'),

      surfaceBackdrop: $('#surfaceBackdrop'),
      surfaceTitle: $('#surfaceTitle'),
      btnCloseSurface: $('#btnCloseSurface'),
      addWordForm: $('#addWordForm'),
      manualSetSelect: $('#manualSetSelect'),
      manualTerm: $('#manualTerm'),
      manualTranslation: $('#manualTranslation'),
      manualContext: $('#manualContext'),
      manualAliases: $('#manualAliases'),
      manualAliasesDetails: $('#manualAliasesDetails'),
      manualGermanHint: $('#manualGermanHint'),
      btnSaveWord: $('#btnSaveWord'),
      setLanguageForm: $('#setLanguageForm'),
      setLanguageHint: $('#setLanguageHint'),
      editLanguageSelect: $('#editLanguageSelect'),
      editLanguageOther: $('#editLanguageOther'),

      toast: $('#toast'),
      confirmBackdrop: $('#confirmBackdrop'),
      confirmMessage: $('#confirmMessage'),
      btnConfirmCancel: $('#btnConfirmCancel'),
      btnConfirmDelete: $('#btnConfirmDelete')
    };
  }

  function wireEvents() {
    let setSwipe = null;
    let suppressSetOpenUntil = 0;
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.screen));
    });
    el.btnBackHome.addEventListener('click', () => showScreen('home'));
    el.btnHomeContinue.addEventListener('click',openHomeSession);
    el.skipContent.addEventListener('click',event=>{event.preventDefault();const screen=el.screens[state.screen];screen.tabIndex=-1;screen.focus({preventScroll:false});});
    el.dailyStreak.addEventListener('click',openCalendar);
    el.reviewStreak.addEventListener('click',openCalendar);
    el.btnCloseCalendar.addEventListener('click',closeCalendar);
    el.btnCalendarPrev.addEventListener('click',()=>moveCalendar(-1));
    el.btnCalendarNext.addEventListener('click',()=>moveCalendar(1));
    el.calendarGrid.addEventListener('click',event=>{const button=event.target.closest('[data-calendar-day]');if(button){calendarSelected=button.dataset.calendarDay;renderCalendar();el.calendarGrid.querySelector(`[data-calendar-day="${calendarSelected}"]`)?.focus();}});
    el.calendarBackdrop.addEventListener('click',event=>{if(event.target===el.calendarBackdrop) closeCalendar();});
    const resume=()=>{if(document.visibilityState==='hidden') return;refreshActivity();if(pendingWrites.length || readJournal('activity')){retryCount=0;flushPendingWrites();}};
    document.addEventListener('visibilitychange',resume);
    window.addEventListener('online',resume);
    window.addEventListener('focus',resume);
    $('#btnRestartLearn').addEventListener('click', async () => {
      const reviewIds = state.session.reviewKinds ? [...state.session.reviewKinds.keys()] : undefined;
      if (await confirmDialog('Начать новое занятие вместо незавершённого? Сохранённый прогресс слов останется.', { title: 'Новое занятие?', action: 'Начать' })) startLearnSession(reviewIds, true);
    });
    el.btnHomeAddSet.addEventListener('click', () => openImportScreen('add'));
    el.homeSetList.addEventListener('pointerdown', (event) => {
      const card = event.target.closest('.home-set-card');
      if (!card || !card.querySelector('[data-delete-set]') || event.target.closest('.home-set-delete')) return;
      setSwipe = { card, x: event.clientX, y: event.clientY, dragging: false, wasRevealed: card.classList.contains('revealed') };
    });
    el.homeSetList.addEventListener('pointermove', (event) => {
      if (!setSwipe) return;
      const { card, x, y } = setSwipe;
      const dx = event.clientX - x;
      const dy = event.clientY - y;
      if (!setSwipe.dragging && (Math.abs(dx) < 7 || Math.abs(dx) < Math.abs(dy) * 1.3)) return;
      setSwipe.dragging = true;
      const start = card.classList.contains('revealed') ? -92 : 0;
      const offset = Math.max(-card.clientWidth, Math.min(0, start + dx));
      const open = card.querySelector('.home-set-open');
      open.style.transition = 'none';
      open.style.transform = `translateX(${offset}px)`;
    });
    el.homeSetList.addEventListener('pointerup', (event) => {
      if (!setSwipe) return;
      const { card, x, y, dragging, wasRevealed } = setSwipe;
      setSwipe = null;
      const dx = event.clientX - x;
      const dy = event.clientY - y;
      if (!dragging || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      const open = card.querySelector('.home-set-open');
      open.style.transition = '';
      open.style.transform = '';
      el.homeSetList.querySelectorAll('.home-set-card.revealed').forEach((item) => item.classList.remove('revealed'));
      suppressSetOpenUntil = performance.now() + 500;
      const deleteButton = card.querySelector('[data-delete-set]');
      if (deleteButton && dx < -card.clientWidth * 0.65) {
        card.classList.add('full-swiped');
        setTimeout(async () => {
          await deleteActiveSet(deleteButton.dataset.deleteSet);
          if (card.isConnected) card.classList.remove('full-swiped');
        }, 300);
      } else if (deleteButton && (dx < -35 || (wasRevealed && dx < 35))) card.classList.add('revealed');
    });
    el.homeSetList.addEventListener('pointercancel', () => {
      if (setSwipe) {
        const open = setSwipe.card.querySelector('.home-set-open');
        open.style.transition = '';
        open.style.transform = '';
      }
      setSwipe = null;
    });
    el.homeSetList.addEventListener('click', async (event) => {
      const deleteButton = event.target.closest('[data-delete-set]');
      if (deleteButton) { await deleteActiveSet(deleteButton.dataset.deleteSet); return; }
      const openButton = event.target.closest('[data-open-set]');
      if (!openButton) return;
      if (performance.now() < suppressSetOpenUntil) return;
      const card = openButton.closest('.home-set-card');
      if (card.classList.contains('revealed')) { card.classList.remove('revealed'); return; }
      if (state.activeSetId !== openButton.dataset.openSet && !await switchActiveSet(openButton.dataset.openSet)) return;
      showScreen('learn');
    });
    el.homeSetList.addEventListener('focusin', (event) => {
      if (event.target.matches('.home-set-delete')) event.target.closest('.home-set-card').classList.add('revealed');
    });
    el.btnConfirmCancel.addEventListener('click', () => closeConfirm(false));
    el.btnConfirmDelete.addEventListener('click', () => closeConfirm(true));
    el.confirmBackdrop.addEventListener('click', (event) => {
      if (event.target === el.confirmBackdrop) closeConfirm(false);
    });
    el.setLanguageSelect.addEventListener('change', () => updateOtherLanguage(el.setLanguageSelect, el.setLanguageOther));
    el.editLanguageSelect.addEventListener('change', () => updateOtherLanguage(el.editLanguageSelect, el.editLanguageOther));

    el.fileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        const text = await readFileAsText(file);
        await handleCsvText(text, baseName(file.name));
      } catch (e) {
        renderImportErrors(['Не удалось прочитать файл. Попробуйте ещё раз.'], []);
      } finally {
        el.fileInput.value = '';
      }
    });

    el.btnLoadDemo.addEventListener('click', () => handleCsvText(DEMO_CSV, 'Демо-набор'));

    el.btnCancelImport.addEventListener('click', () => {
      showScreen(state.sets.length ? 'home' : 'import');
    });

    el.setSelect.addEventListener('change', (e) => switchActiveSet(e.target.value));
    el.btnSetMenu.addEventListener('click', () => {
      el.setMenu.hidden = !el.setMenu.hidden;
      el.btnSetMenu.setAttribute('aria-expanded', String(!el.setMenu.hidden));
    });
    el.btnAddSet.addEventListener('click', () => openImportScreen('add'));
    el.btnAddWord.addEventListener('click', () => openSurface('word'));
    el.btnEditLanguage.addEventListener('click', () => openSurface('language'));
    el.btnDeleteSet.addEventListener('click', () => deleteActiveSet());
    el.btnTheme.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    el.dailyGoalSelect.addEventListener('change', async () => {
      state.activity = { ...state.activity, dailyGoal: Number(el.dailyGoalSelect.value),goalUpdatedAt:Date.now() };
      renderDailyGoal();
      try { await saveActivity(); }
      catch (error) { console.error('Could not save daily goal', error); showToast('Не удалось сохранить цель'); }
    });
    el.btnCloseSurface.addEventListener('click', closeSurface);
    el.addWordForm.addEventListener('submit', addWordManually);
    el.manualSetSelect.addEventListener('change', updateManualLanguageHint);
    el.setLanguageForm.addEventListener('submit', changeSetLanguage);
    el.surfaceBackdrop.addEventListener('click', (event) => {
      if (event.target === el.surfaceBackdrop) closeSurface();
    });
    el.btnQuickReview.addEventListener('click', startQuickReview);
    el.btnExtraPractice.addEventListener('click',()=>{state.extraPractice=!state.extraPractice;renderReview();});
    el.btnBrowseCards.addEventListener('click', openFlashcards);
    el.btnCloseFlashcards.addEventListener('click', closeFlashcards);
    el.flashcardFace.addEventListener('click', () => {
      state.flashcards.revealed = !state.flashcards.revealed;
      renderFlashcard();
    });
    el.btnPreviousFlashcard.addEventListener('click', () => moveFlashcard(-1));
    el.btnNextFlashcard.addEventListener('click', () => moveFlashcard(1));
    el.flashcardBackdrop.addEventListener('click', (event) => {
      if (event.target === el.flashcardBackdrop) closeFlashcards();
    });
    el.reviewSize.addEventListener('input', () => updateReviewSizeInput(el.reviewSize.value));
    el.reviewSize.addEventListener('change', () => {
      try { localStorage.setItem('vocab_review_size', String(state.reviewSize)); } catch (e) { /* optional preference */ }
    });
    el.reviewSize.addEventListener('keydown', (event) => {
      const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
      if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const next = event.key === 'Home' ? 1 : event.key === 'End'
        ? Math.max(1, quickReviewPool().length) : state.reviewSize + delta;
      el.reviewSize.value = String(Math.max(1, Math.min(quickReviewPool().length, next)));
      updateReviewSizeInput(el.reviewSize.value);
      try { localStorage.setItem('vocab_review_size', String(state.reviewSize)); } catch (e) { /* optional preference */ }
    });
    el.wordTable.addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-term]');
      if (button) openSurface('edit-word', button.dataset.editTerm);
    });

    el.reviewTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      state.reviewFilter = tab.dataset.filter;
      document.querySelectorAll('#reviewTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      positionReviewIndicator(tab);
      renderReviewList();
    });

    el.btnLearnEmptyToReview.addEventListener('click', () => {
      if(Srs.currentDailyCount(state.activity)<dailyGoal() && !Srs.reviewPool(state.terms).length) openHomeSession();
      else showScreen('review');
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.set-menu-wrap')) {
        el.setMenu.hidden = true;
        el.btnSetMenu.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      const modal = [el.calendarBackdrop, el.confirmBackdrop, el.surfaceBackdrop, el.flashcardBackdrop].find(node => !node.hidden);
      if (modal && event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (first && (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
      if (!el.flashcardBackdrop.hidden) {
        if (event.key === 'Escape') { closeFlashcards(); return; }
        if (event.key === 'ArrowRight') { event.preventDefault(); moveFlashcard(1); return; }
        if (event.key === 'ArrowLeft') { event.preventDefault(); moveFlashcard(-1); return; }
        if (event.key === ' ' && event.target === el.flashcardBackdrop) {
          event.preventDefault(); state.flashcards.revealed = !state.flashcards.revealed; renderFlashcard(); return;
        }
      }
      if (event.key === 'Escape') {
        if(!el.calendarBackdrop.hidden) {closeCalendar();return;}
        if (!el.confirmBackdrop.hidden) { closeConfirm(false); return; }
        closeSurface();
        el.setMenu.hidden = true;
      }
    });
    window.addEventListener('resize', () => positionReviewIndicator(el.reviewTabs.querySelector('.tab.active')));
  }

  async function deleteActiveSet(setId = state.activeSetId) {
    if (!setId || isAggregateScope(setId)) return;
    const setName = (state.sets.find((s) => s.id === setId) || {}).name || 'этот набор';
    const ok = await confirmDialog(`Удалить набор «${setName}» и весь его прогресс?`);
    if (!ok) return;
    try {
      if (!await state.store.deleteSet(setId)) throw new Error('Delete failed');
      await refreshSetsList();
      state.activeSetId = await state.store.getActiveSetId();
      if (!isValidScope(state.activeSetId)) {
        state.activeSetId = state.sets[0]?.id || null;
        await state.store.setActiveSetId(state.activeSetId || '');
      }
      await loadActiveSetTerms();
      renderSetSwitcher();
      if (state.sets.length === 0) openImportScreen('first');
      else showScreen('home');
      showToast(`Набор «${setName}» удалён`);
    } catch (error) {
      console.error('Could not delete set', error);
      showToast('Не удалось удалить набор. Попробуй ещё раз.');
    }
  }

  async function boot() {
    cacheDom();
    initTheme();
    initReviewSize();
    wireEvents();
    registerOfflineApp();

    async function loadStorage() {
      showScreen('loading');
      $('#loadingError').hidden = true;
      $('#btnRetryLoad').disabled = true;
      try {
      const launchedInTelegram=/(?:^|[&#?])tgWebAppData=/.test(location.hash+location.search);
      if(launchedInTelegram && !window.Telegram?.WebApp?.initData) {
        await new Promise(resolve=>{const deadline=Date.now()+3000;const check=()=>window.Telegram?.WebApp?.initData || Date.now()>=deadline ? resolve() : setTimeout(check,50);check();});
      }
      initTelegram();
      state.store = await window.VocabStorage.VocabStore.create();
      el.syncBadge.hidden = false;
      el.syncBadge.className = 'sync-badge ' + state.store.backendName;
      el.syncBadge.textContent = state.store.backendName === 'cloud'
        ? 'Telegram · загружаем данные…'
        : 'На этом устройстве · без синхронизации';

      [state.settings, state.activity, state.activeSetId] = await Promise.all([state.store.getSettings(), state.store.getActivity(),state.store.getActiveSetId(),refreshSetsList()]);
      lastActivityRefresh=Date.now();
      const savedActivity=readJournal('activity');
      if(savedActivity) state.activity={...Srs.mergeActivity(state.activity,savedActivity),sourceId:state.activity.sourceId};
      const pending = readJournal('pending');
      pendingWrites = Array.isArray(pending) ? pending.filter(job => job && typeof job.setId === 'string' && job.term?.id && job.activity && typeof job.activity === 'object') : [];
      pendingWrites.forEach(job => {
        state.activity = {...Srs.mergeActivity(state.activity,job.activity),sourceId:state.activity.sourceId};
      });
      // Also publish recovered legacy history, even before the first new answer.
      writeJournal('activity',state.activity);
      if (state.sets.length === 0) {
      openImportScreen('first');
      updateSyncBadge();flushPendingWrites();
      return;
      }

    if (!isValidScope(state.activeSetId)) {
      // Retire the old multilingual scope without changing any word data.
      state.activeSetId = state.activeSetId === ALL_SETS_ID && state.languageGroups.length
        ? languageScopeId(state.languageGroups[0].language) : state.sets[0].id;
      try { await state.store.setActiveSetId(state.activeSetId); }
      catch (e) { console.error('Failed to persist active set id:', e); }
    }

    renderSetSwitcher();
    showScreen('home');
    updateSyncBadge();
    // The home screen must not wait for potentially slow/offline writes.
    flushPendingWrites();
      } catch (error) {
        console.error('Storage load failed', error);
        $('#loadingError').hidden = false;
        $('#loadingErrorText').textContent = 'Не удалось загрузить словарь. Данные не удалены. ' + (error.message || 'Проверь соединение и попробуй снова.');
      } finally { $('#btnRetryLoad').disabled = false; }
    }
    $('#btnRetryLoad').addEventListener('click', loadStorage);
    el.dropzone.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!importBusy) el.fileInput.click(); }
    });
    await loadStorage();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
