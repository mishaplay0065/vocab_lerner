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
  const LANGUAGE_LABELS = { en: 'Английский', de: 'Немецкий', mixed: 'Смешанные' };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    store: null,
    sets: [],                 // [{id, name, createdAt, termCount, chunkCount}]
    activeSetId: null,
    terms: [],                 // terms of the active set
    chunkMap: new Map(),       // termId -> {setId, chunkIdx}, for cheap partial saves
    termMeta: new Map(),       // termId -> {setId, setName, language}
    settings: null,
    screen: 'loading',       // loading | import | learn | review | progress
    importMode: 'first',    // 'first' (no sets yet) | 'add' (adding another set)
    session: {
      queue: [],
      initialLength: 0,
      answered: false,
      pendingStudyTermId: null // set while Phase 1 (study) is showing, before Phase 2 test
    },
    reviewFilter: 'due'
  };

  let el = {}; // populated on DOMContentLoaded
  const $ = (sel) => document.querySelector(sel);
  const SCREEN_TITLES = { learn: 'Учить', review: 'Повторение', progress: 'Прогресс', import: 'Vocab', loading: 'Vocab' };

  // ---------------------------------------------------------------------
  // Telegram WebApp integration
  // ---------------------------------------------------------------------
  function initTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) return;
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1')) {
        tg.setHeaderColor('secondary_bg_color');
      }
    } catch (e) { /* not fatal outside Telegram */ }
  }

  function confirmDialog(message) {
    const tg = window.Telegram && window.Telegram.WebApp;
    return new Promise((resolve) => {
      if (tg && tg.showConfirm) tg.showConfirm(message, (ok) => resolve(ok));
      else resolve(window.confirm(message));
    });
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
    document.documentElement.dataset.theme = chosen;
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

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function detectTermLanguage(text) {
    const value = (text || '').trim();
    return /[äöüß]/i.test(value) || /\b(?:der|die|das|ein|eine|einen|einem|einer|nicht|sich|zu)\b/i.test(value)
      ? 'de'
      : 'en';
  }

  function inferSetLanguage(terms) {
    const languages = new Set(terms.map((term) => detectTermLanguage(term.term)));
    if (languages.size === 1) return [...languages][0];
    return 'mixed';
  }

  function languageLabel(language) {
    return LANGUAGE_LABELS[language] || LANGUAGE_LABELS.mixed;
  }

  function termSourceLabel(term) {
    const meta = state.termMeta.get(term.id);
    if (!meta) return '';
    return `${languageLabel(meta.language)} · ${meta.setName}`;
  }

  // ---------------------------------------------------------------------
  // Screen navigation
  // ---------------------------------------------------------------------
  function showScreen(name) {
    console.log('renderScreen:', name);
    state.screen = name;
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
    });
    // Belt-and-braces in case a new screen is ever added to the DOM but
    // forgotten in el.screens: loading is never allowed to stay visible
    // once we've decided to render anything else.
    if (name !== 'loading' && el.screens.loading) el.screens.loading.hidden = true;

    el.mainHeader.hidden = name === 'loading';
    el.topbarTitle.hidden = name !== 'import';
    el.topbarTitle.textContent = SCREEN_TITLES[name];
    el.setSwitch.hidden = name === 'loading' || name === 'import' || state.sets.length === 0;
    el.bottomnav.hidden = name === 'loading' || name === 'import';
    el.syncBadge.hidden = name === 'loading';

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.screen === name);
    });

    if (name === 'learn') startLearnSession();
    if (name === 'review') renderReview();
    if (name === 'progress') renderProgress();
  }

  // ---------------------------------------------------------------------
  // Set switcher (header dropdown + add/delete)
  // ---------------------------------------------------------------------
  function renderSetSwitcher() {
    const groups = { en: [], de: [], mixed: [] };
    state.sets.forEach((set) => (groups[set.language] || groups.mixed).push(set));
    let html = state.sets.length > 1
      ? `<option value="${ALL_SETS_ID}" ${state.activeSetId === ALL_SETS_ID ? 'selected' : ''}>Все наборы (${state.sets.reduce((sum, set) => sum + (set.termCount || 0), 0)})</option>`
      : '';
    Object.keys(groups).forEach((language) => {
      if (groups[language].length === 0) return;
      html += `<optgroup label="${languageLabel(language)}">` + groups[language].map((set) =>
        `<option value="${escapeHtml(set.id)}" ${set.id === state.activeSetId ? 'selected' : ''}>${escapeHtml(set.name)} (${set.termCount})</option>`
      ).join('') + '</optgroup>';
    });
    el.setSelect.innerHTML = html;
    el.btnDeleteSet.hidden = state.activeSetId === ALL_SETS_ID;
    el.btnEditLanguage.disabled = state.activeSetId === ALL_SETS_ID;
    el.manualSetSelect.innerHTML = state.sets.map((set) =>
      `<option value="${escapeHtml(set.id)}">${escapeHtml(set.name)} · ${languageLabel(set.language)}</option>`
    ).join('');
    if (state.activeSetId !== ALL_SETS_ID) el.manualSetSelect.value = state.activeSetId;
  }

  async function switchActiveSet(setId) {
    state.activeSetId = setId;
    await state.store.setActiveSetId(setId);
    await loadActiveSetTerms();
    renderSetSwitcher();
    if (state.screen === 'learn' || state.screen === 'review' || state.screen === 'progress') {
      showScreen(state.screen);
    }
  }

  async function loadActiveSetTerms() {
    if (!state.activeSetId) {
      state.terms = [];
      state.chunkMap = new Map();
      state.termMeta = new Map();
      return;
    }
    const selectedSets = state.activeSetId === ALL_SETS_ID
      ? state.sets
      : state.sets.filter((set) => set.id === state.activeSetId);
    const bundles = await Promise.all(selectedSets.map(async (set) => ({
      set,
      data: await state.store.loadSetTerms(set.id)
    })));
    state.terms = [];
    state.chunkMap = new Map();
    state.termMeta = new Map();
    bundles.forEach(({ set, data }) => {
      const setLanguage = set.language || inferSetLanguage(data.terms);
      set.language = setLanguage;
      data.terms.forEach((term) => {
        const language = setLanguage === 'mixed' ? detectTermLanguage(term.term) : setLanguage;
        state.terms.push(term);
        state.chunkMap.set(term.id, { setId: set.id, chunkIdx: data.chunkMap.get(term.id) });
        state.termMeta.set(term.id, { setId: set.id, setName: set.name, language });
      });
    });
  }

  async function refreshSetsList() {
    state.sets = await state.store.listSets();
  }

  function openImportScreen(mode) {
    state.importMode = mode;
    el.importTitle.textContent = mode === 'add' ? 'Новый набор слов' : 'Учить слова стало проще';
    el.importSubtitle.textContent = mode === 'add'
      ? 'Загрузи CSV-файл для ещё одного набора — он появится в списке рядом с остальными.'
      : 'Загрузи CSV-файл со словами и фразами на английском или немецком — приложение построит для тебя карточки и расписание повторений.';
    el.btnCancelImport.hidden = mode !== 'add';
    el.setNameInput.value = '';
    el.setLanguageSelect.value = 'auto';
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
      html += `<p><strong>Предупреждения:</strong> ${warnings.length} строк пропущено (дубликаты).</p>`;
    }
    el.importErrors.innerHTML = html;
  }

  function baseName(fileName) {
    return (fileName || '').replace(/\.[^/.]+$/, '') || 'Мой набор';
  }

  async function handleCsvText(text, defaultName) {
    const { items, errors, warnings } = Csv.parseCsv(text);
    renderImportErrors(errors, warnings);
    if (errors.length || items.length === 0) return;

    const name = (el.setNameInput.value || '').trim() || defaultName;
    const terms = items.map((it) => Srs.makeTerm(it));
    const selectedLanguage = el.setLanguageSelect.value;
    const language = selectedLanguage === 'auto' ? inferSetLanguage(terms) : selectedLanguage;
    const newId = await state.store.createSet(name, terms, language);

    await refreshSetsList();
    state.activeSetId = newId;
    await loadActiveSetTerms();
    renderSetSwitcher();

    showToast(`Набор «${name}» создан: ${terms.length} слов`);
    showScreen('learn');
  }

  function openSurface(mode) {
    el.setMenu.hidden = true;
    el.btnSetMenu.setAttribute('aria-expanded', 'false');
    el.surfaceBackdrop.hidden = false;
    el.addWordForm.hidden = mode !== 'word';
    el.setLanguageForm.hidden = mode !== 'language';

    if (mode === 'word') {
      el.surfaceTitle.textContent = 'Добавить слово';
      if (state.activeSetId !== ALL_SETS_ID) el.manualSetSelect.value = state.activeSetId;
      setTimeout(() => el.manualTerm.focus(), 60);
      return;
    }

    const set = state.sets.find((item) => item.id === state.activeSetId);
    if (!set) return closeSurface();
    el.surfaceTitle.textContent = 'Язык набора';
    el.setLanguageHint.textContent = `Выбери язык для набора «${set.name}». Слова автоматически переместятся в соответствующую группу.`;
    el.editLanguageSelect.value = set.language || 'mixed';
    setTimeout(() => el.editLanguageSelect.focus(), 60);
  }

  function closeSurface() {
    el.surfaceBackdrop.hidden = true;
  }

  async function addWordManually(event) {
    event.preventDefault();
    const setId = el.manualSetSelect.value;
    const term = el.manualTerm.value.trim();
    const translation = el.manualTranslation.value.trim();
    const context = el.manualContext.value.trim();
    if (!setId || !term || !translation) return;

    const result = await state.store.addTerm(setId, Srs.makeTerm({ term, translation, context }));
    if (!result.ok) {
      showToast(result.reason === 'duplicate' ? 'Такое слово уже есть в наборе' : 'Не удалось добавить слово');
      return;
    }

    await refreshSetsList();
    if (state.activeSetId === setId || state.activeSetId === ALL_SETS_ID) await loadActiveSetTerms();
    renderSetSwitcher();
    el.addWordForm.reset();
    el.manualSetSelect.value = setId;
    closeSurface();
    showToast(`«${term}» добавлено в набор`);
    if (state.screen === 'learn') startLearnSession();
    if (state.screen === 'review') renderReview();
    if (state.screen === 'progress') renderProgress();
  }

  async function changeSetLanguage(event) {
    event.preventDefault();
    if (!state.activeSetId || state.activeSetId === ALL_SETS_ID) return;
    await state.store.updateSetLanguage(state.activeSetId, el.editLanguageSelect.value);
    await refreshSetsList();
    await loadActiveSetTerms();
    renderSetSwitcher();
    closeSurface();
    showToast('Язык набора изменён');
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
    return t.attempts >= 2 && t.status !== 'learned' && (t.correct_count / t.attempts) < 0.6;
  }

  // ---------------------------------------------------------------------
  // Learn session
  // ---------------------------------------------------------------------
  function buildLearnQueue(terms) {
    const now = Date.now();
    const due = terms.filter((t) => t.status !== 'new' && Srs.isDue(t, now))
      .sort((a, b) => a.due_date - b.due_date);
    const fresh = terms.filter((t) => t.status === 'new')
      .sort((a, b) => a.created_at - b.created_at);
    // Due reviews first, but always include fresh words too so a brand-new
    // set (all "new", nothing "due" yet) is never shown as empty.
    return [...due, ...fresh].slice(0, SESSION_SIZE).map((t) => t.id);
  }

  function getTermById(id) { return state.terms.find((t) => t.id === id); }

  function startLearnSession(customQueue) {
    const queue = customQueue || buildLearnQueue(state.terms);
    state.session.queue = queue;
    state.session.initialLength = Math.max(queue.length, 1);
    state.session.answered = false;
    state.session.pendingStudyTermId = null;
    renderLearnStep();
  }

  function updateLearnProgress() {
    const done = state.session.initialLength - state.session.queue.length;
    const pct = Math.max(0, Math.min(100, Math.round((done / state.session.initialLength) * 100)));
    el.learnProgressFill.style.width = pct + '%';
    el.learnCounter.textContent = state.session.queue.length
      ? `Осталось: ${state.session.queue.length}`
      : 'Готово';
  }

  function renderLearnStep() {
    updateLearnProgress();

    if (state.session.queue.length === 0) {
      el.exerciseCard.hidden = true;
      el.learnEmpty.hidden = false;
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

    // Phase 1: never-attempted words get a Study card before any test.
    if (term.attempts === 0) {
      state.session.answered = false;
      renderStudyCard(term);
      return;
    }

    // Bonus "find the pair" round — only among words already past Study,
    // so it never collides with the Study->Test flow of brand-new words.
    const frontIds = state.session.queue.slice(0, 4);
    const frontTerms = frontIds.map(getTermById).filter(Boolean);
    const matchingLanguages = new Set(frontTerms.map((term) => (state.termMeta.get(term.id) || {}).language));
    if (frontTerms.length === 4 && matchingLanguages.size === 1 && frontTerms.every((t) => t.attempts > 0) && Math.random() < 0.2) {
      renderMatching(frontTerms);
      return;
    }

    state.session.answered = false;
    const exercise = Ex.pickExerciseType(term, state.terms);
    renderExercise(exercise);
  }

  function advanceAfterAnswer(isCorrect) {
    const id = state.session.queue.shift();
    if (!isCorrect) state.session.queue.push(id); // resurface later this session
    setTimeout(renderLearnStep, 550);
  }

  async function scoreTerm(termId, isCorrect) {
    const term = getTermById(termId);
    if (!term) return;
    Srs.applyAnswer(term, isCorrect, state.settings.intervalsDays);

    // Persist just the one chunk this term lives in, not the whole set —
    // keeps writes small and fast against Telegram CloudStorage's per-key
    // size limit.
    const location = state.chunkMap.get(termId);
    if (location && location.chunkIdx !== undefined) {
      const chunkTerms = state.terms.filter((candidate) => {
        const candidateLocation = state.chunkMap.get(candidate.id);
        return candidateLocation && candidateLocation.setId === location.setId && candidateLocation.chunkIdx === location.chunkIdx;
      });
      await state.store.saveChunk(location.setId, location.chunkIdx, chunkTerms);
    }
  }

  function speakTerm(term) {
    if (!term || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      showToast('Озвучивание не поддерживается на этом устройстве');
      return;
    }
    const meta = state.termMeta.get(term.id);
    const utterance = new SpeechSynthesisUtterance(term.term);
    utterance.lang = meta && meta.language === 'de' ? 'de-DE' : 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function makeSpeakButton(term) {
    const button = document.createElement('button');
    button.className = 'speak-btn';
    button.type = 'button';
    button.setAttribute('aria-label', 'Озвучить слово');
    button.title = 'Озвучить слово';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5Zm12.5-1.5a6 6 0 0 1 0 9m-2-6.8a3 3 0 0 1 0 4.6"/></svg>';
    button.addEventListener('click', () => speakTerm(term));
    return button;
  }

  function makePronunciationActions(term) {
    const actions = document.createElement('div');
    actions.className = 'pronunciation-actions';
    actions.appendChild(makeSpeakButton(term));

    const meta = state.termMeta.get(term.id);
    if (!meta || meta.language === 'en') {
      const slug = term.term
        .toLowerCase()
        .trim()
        .replace(/[’']/g, '')
        .replace(/\s+/g, '-');
      const link = document.createElement('a');
      link.className = 'speak-btn cambridge-btn';
      link.href = `https://dictionary.cambridge.org/pronunciation/english/${encodeURIComponent(slug)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', 'Открыть произношение в Cambridge Dictionary');
      link.title = 'Произношение Cambridge: UK и US';
      link.textContent = 'C';
      actions.appendChild(link);
    }
    return actions;
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
    termRow.appendChild(makePronunciationActions(term));
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
    const canMultipleChoice = state.terms.filter((t) => t.id !== term.id).length >= 3;
    const type = canMultipleChoice && Math.random() < 0.5 ? 'multiple_choice' : 'type_answer';
    const exercise = type === 'multiple_choice'
      ? Ex.buildMultipleChoice(term, state.terms)
      : Ex.buildTypeAnswer(term);
    exercise.kindLabel = 'Проверка';
    state.session.answered = false;
    renderExercise(exercise);
  }

  // ---- Generic exercise rendering (multiple choice / type / spelling / flashcard) ----
  function renderExercise(exercise) {
    const card = el.exerciseCard;
    card.innerHTML = '';

    const kindEl = document.createElement('div');
    kindEl.className = 'exercise-kind';
    kindEl.textContent = exercise.kindLabel;
    card.appendChild(kindEl);

    const exerciseTerm = exercise.termId ? getTermById(exercise.termId) : null;
    if (exerciseTerm) appendTermSource(card, exerciseTerm);

    if (exercise.kind === 'flashcard') {
      renderFlashcard(card, exercise);
      return;
    }

    const promptLabel = document.createElement('div');
    promptLabel.className = 'exercise-prompt-label';
    promptLabel.textContent = exercise.promptLabel;
    card.appendChild(promptLabel);

    if (exercise.prompt) {
      const promptRow = document.createElement('div');
      promptRow.className = 'term-heading-row';
      const prompt = document.createElement('div');
      prompt.className = 'exercise-prompt';
      prompt.textContent = exercise.prompt;
      promptRow.appendChild(prompt);
      if (exerciseTerm && exercise.prompt === exerciseTerm.term) {
        promptRow.appendChild(makePronunciationActions(exerciseTerm));
      }
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
      return;
    }

    if (exercise.kind === 'type_answer' || exercise.kind === 'spelling_missing') {
      const input = document.createElement('input');
      input.className = 'text-input';
      input.type = 'text';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.placeholder = 'Введите ответ или оставьте пустым';
      card.appendChild(input);
      card.appendChild(feedback);
      const actions = buildActionsRow();
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

  function buildActionsRow() {
    const row = document.createElement('div');
    row.className = 'exercise-actions';
    const primary = document.createElement('button');
    primary.className = 'btn btn-primary';
    primary.textContent = 'Проверить';
    row.appendChild(primary);
    return row;
  }

  function showFeedback(feedback, isCorrect, correctAnswer) {
    feedback.hidden = false;
    feedback.className = 'feedback ' + (isCorrect ? 'ok' : 'bad');
    feedback.innerHTML = isCorrect
      ? '✓ Верно!'
      : `✗ Неверно. Правильный ответ: <strong>${escapeHtml(correctAnswer)}</strong>`;
  }

  function appendContinueButton(card, onNext) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Далее';
    btn.style.marginTop = '8px';
    btn.addEventListener('click', onNext);
    card.appendChild(btn);
  }

  function handleMultipleChoiceAnswer(chosen, exercise, grid, feedback) {
    if (state.session.answered) return;
    state.session.answered = true;
    const isCorrect = chosen === exercise.correctAnswer;
    Array.from(grid.children).forEach((btn) => {
      btn.classList.add('disabled-choice');
      if (btn.textContent === exercise.correctAnswer) btn.classList.add('correct');
      else if (btn.textContent === chosen && !isCorrect) btn.classList.add('incorrect');
    });
    showFeedback(feedback, isCorrect, exercise.correctAnswer);
    scoreTerm(exercise.termId, isCorrect);
    appendContinueButton(el.exerciseCard, () => advanceAfterAnswer(isCorrect));
  }

  function handleTypedAnswer(value, exercise, input, feedback, checkBtn) {
    if (state.session.answered) return;
    state.session.answered = true;
    const isCorrect = Ex.answersMatch(value, exercise.correctAnswer);
    input.disabled = true;
    checkBtn.remove();
    showFeedback(feedback, isCorrect, exercise.correctAnswer);
    scoreTerm(exercise.termId, isCorrect);
    appendContinueButton(el.exerciseCard, () => advanceAfterAnswer(isCorrect));
  }

  function renderScramble(card, exercise, feedback) {
    const assembledRow = document.createElement('div');
    assembledRow.className = 'assembled-row';

    const tilesRow = document.createElement('div');
    tilesRow.className = 'letter-tiles';

    let assembled = [];
    const tileEls = exercise.tiles.map((unit, idx) => {
      const tile = document.createElement('div');
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
        const t = document.createElement('div');
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
      state.session.answered = true;
      const userAnswer = assembled.map((a) => a.unit).join(exercise.joinWith);
      const isCorrect = Ex.answersMatch(userAnswer, exercise.correctAnswer);
      showFeedback(feedback, isCorrect, exercise.correctAnswer);
      scoreTerm(exercise.termId, isCorrect);
      appendContinueButton(el.exerciseCard, () => advanceAfterAnswer(isCorrect));
    }

    card.appendChild(assembledRow);
    card.appendChild(tilesRow);
    card.appendChild(feedback);
  }

  function renderFlashcard(card, exercise) {
    const promptLabel = document.createElement('div');
    promptLabel.className = 'exercise-prompt-label';
    promptLabel.textContent = exercise.promptLabel;
    card.appendChild(promptLabel);

    const face = document.createElement('div');
    face.className = 'flash-face';
    const promptText = document.createElement('div');
    promptText.className = 'exercise-prompt';
    promptText.textContent = exercise.prompt;
    const hint = document.createElement('div');
    hint.className = 'flash-hint';
    hint.textContent = 'Нажми, чтобы посмотреть слово';
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
      const term = getTermById(exercise.termId);
      if (term) face.appendChild(makeSpeakButton(term));
      showFlashButtons();
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
        forgot.disabled = true; remember.disabled = true;
        scoreTerm(exercise.termId, isCorrect);
        advanceAfterAnswer(isCorrect);
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

    function makeCell(item) {
      const cell = document.createElement('div');
      cell.className = 'match-cell';
      cell.textContent = item.text;
      cell.dataset.termId = item.termId;
      cell.dataset.side = item.side;
      cell.addEventListener('click', () => onCellClick(cell, item));
      return cell;
    }

    exercise.left.forEach((item, index) => {
      grid.appendChild(makeCell(item));
      if (exercise.right[index]) grid.appendChild(makeCell(exercise.right[index]));
    });

    function onCellClick(cell, item) {
      if (cell.classList.contains('solved')) return;
      if (item.side === 'term') {
        if (selectedLeft) selectedLeft.el.classList.remove('selected');
        selectedLeft = { el: cell, termId: item.termId };
        cell.classList.add('selected');
      } else {
        if (selectedRight) selectedRight.el.classList.remove('selected');
        selectedRight = { el: cell, termId: item.termId };
        cell.classList.add('selected');
      }
      if (selectedLeft && selectedRight) {
        if (selectedLeft.termId === selectedRight.termId) {
          selectedLeft.el.classList.remove('selected');
          selectedRight.el.classList.remove('selected');
          selectedLeft.el.classList.add('solved');
          selectedRight.el.classList.add('solved');
          solvedIds.add(selectedLeft.termId);
          selectedLeft = null; selectedRight = null;
          if (solvedIds.size === exercise.termIds.length) finishMatching();
        } else {
          const wrongEls = [selectedLeft.el, selectedRight.el];
          wrongEls.forEach((c) => c.classList.add('wrong'));
          setTimeout(() => {
            wrongEls.forEach((c) => { c.classList.remove('wrong'); c.classList.remove('selected'); });
          }, 450);
          selectedLeft = null; selectedRight = null;
        }
      }
    }

    function finishMatching() {
      exercise.termIds.forEach((id) => scoreTerm(id, true));
      const note = document.createElement('div');
      note.className = 'feedback ok';
      note.textContent = '✓ Все пары найдены!';
      card.appendChild(note);
      appendContinueButton(card, () => {
        state.session.queue = state.session.queue.filter((id) => !exercise.termIds.includes(id));
        setTimeout(renderLearnStep, 50);
      });
    }
  }

  // ---------------------------------------------------------------------
  // Review screen
  // ---------------------------------------------------------------------
  function statTile(num, label) {
    return `<div class="stat-tile"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  }

  function renderReview() {
    const stats = computeStats(state.terms);
    const availableNow = state.terms.filter((term) => term.attempts > 0);
    el.btnQuickReview.hidden = state.terms.length === 0;
    el.btnQuickReview.textContent = `Повторить сейчас · ${Math.min((availableNow.length || state.terms.length), SESSION_SIZE)}`;
    el.reviewStats.innerHTML =
      statTile(stats.total, 'Всего') +
      statTile(stats.new, 'Новые') +
      statTile(stats.learning, 'Учатся') +
      statTile(stats.dueToday, 'Сегодня') +
      statTile(stats.learned, 'Изучено') +
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
      case 'due': return state.terms.filter((t) => t.status !== 'new' && Srs.isDue(t, now));
      case 'difficult': return state.terms.filter(isDifficult);
      case 'learned': return state.terms.filter((t) => t.status === 'learned');
      case 'stale': return state.terms.filter((t) => Srs.isStale(t, 14, now));
      default: return [];
    }
  }

  function badgeFor(term) {
    if (term.status === 'learned') return '<span class="badge badge-learned">Изучено</span>';
    if (term.status === 'new') return '<span class="badge badge-new">Новое</span>';
    return '<span class="badge badge-learning">Учится</span>';
  }

  const EMPTY_NOTES = {
    due: 'Нет слов, готовых к повторению прямо сейчас. Загляни позже.',
    difficult: 'Сложных слов пока нет — отличная работа!',
    learned: 'Пока нет изученных слов. Продолжай заниматься в разделе «Учить».',
    stale: 'Нет слов, которые давно не повторялись.'
  };

  function renderReviewList() {
    const items = filteredReviewTerms();
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
    el.btnStartReview.hidden = false;
    el.btnStartReview.onclick = () => {
      const ids = items.slice(0, SESSION_SIZE).map((t) => t.id);
      showScreen('learn');
      startLearnSession(ids);
    };
  }

  function startQuickReview() {
    const attempted = state.terms.filter((term) => term.attempts > 0);
    const pool = attempted.length ? attempted : state.terms;
    const ids = Ex.shuffle(pool).slice(0, SESSION_SIZE).map((term) => term.id);
    if (ids.length === 0) return;
    showScreen('learn');
    startLearnSession(ids);
  }

  // ---------------------------------------------------------------------
  // Progress screen
  // ---------------------------------------------------------------------
  function renderProgress() {
    const stats = computeStats(state.terms);
    const remaining = stats.total - stats.learned;
    el.progressStats.innerHTML =
      statTile(stats.total, 'Всего слов') +
      statTile(stats.learned, 'Изучено') +
      statTile(remaining, 'Осталось') +
      statTile(stats.successRate + '%', 'Успешность');

    const pct = stats.total ? Math.round((stats.learned / stats.total) * 100) : 0;
    el.progressBarFill.style.width = pct + '%';
    el.progressBarLabel.textContent = `${pct}% слов выучено (${stats.learned} из ${stats.total})`;

    const intervals = state.settings.intervalsDays;
    const sorted = [...state.terms].sort((a, b) => {
      const order = { learning: 0, new: 1, learned: 2 };
      return order[a.status] - order[b.status] || a.term.localeCompare(b.term);
    });

    el.wordTable.innerHTML = sorted.map((t) => {
      const dots = Array.from({ length: intervals.length }, (_, i) =>
        `<span class="mastery-dot ${i < t.mastery_level ? 'filled' : ''}"></span>`).join('');
      const nextReview = t.status === 'learned' && t.mastery_level >= intervals.length
        ? '—'
        : new Date(t.due_date).toLocaleDateString('ru-RU');
      return `
        <div class="word-row">
          <div class="word-row-top">
            <div class="word-row-term">${escapeHtml(t.term)} <span style="color:var(--ink-soft);font-weight:400;">— ${escapeHtml(t.translation)}</span></div>
            ${badgeFor(t)}
          </div>
          <div class="term-source">${escapeHtml(termSourceLabel(t))}</div>
          <div class="word-row-details">
            <span>Попыток: ${t.attempts}</span>
            <span>Верно: ${t.correct_count}</span>
            <span>Следующее повторение: ${nextReview}</span>
            <span class="mastery-dots">${dots}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ---------------------------------------------------------------------
  // Boot + event wiring (deferred to DOMContentLoaded so every element
  // referenced below is guaranteed to exist first)
  // ---------------------------------------------------------------------
  function cacheDom() {
    el = {
      mainHeader: $('#mainHeader'),
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
        learn: $('#screen-learn'),
        review: $('#screen-review'),
        progress: $('#screen-progress')
      },
      bottomnav: $('#bottomnav'),

      importTitle: $('#importTitle'),
      importSubtitle: $('#importSubtitle'),
      setNameInput: $('#setNameInput'),
      setLanguageSelect: $('#setLanguageSelect'),
      fileInput: $('#fileInput'),
      dropzone: $('#dropzone'),
      btnLoadDemo: $('#btnLoadDemo'),
      btnCancelImport: $('#btnCancelImport'),
      importErrors: $('#importErrors'),

      learnProgressFill: $('#learnProgressFill'),
      learnCounter: $('#learnCounter'),
      exerciseCard: $('#exerciseCard'),
      learnEmpty: $('#learnEmpty'),
      btnLearnEmptyToReview: $('#btnLearnEmptyToReview'),

      reviewStats: $('#reviewStats'),
      btnQuickReview: $('#btnQuickReview'),
      reviewTabs: $('#reviewTabs'),
      reviewTabIndicator: $('#reviewTabIndicator'),
      reviewList: $('#reviewList'),
      btnStartReview: $('#btnStartReview'),

      progressStats: $('#progressStats'),
      progressBarFill: $('#progressBarFill'),
      progressBarLabel: $('#progressBarLabel'),
      wordTable: $('#wordTable'),

      surfaceBackdrop: $('#surfaceBackdrop'),
      surfaceTitle: $('#surfaceTitle'),
      btnCloseSurface: $('#btnCloseSurface'),
      addWordForm: $('#addWordForm'),
      manualSetSelect: $('#manualSetSelect'),
      manualTerm: $('#manualTerm'),
      manualTranslation: $('#manualTranslation'),
      manualContext: $('#manualContext'),
      setLanguageForm: $('#setLanguageForm'),
      setLanguageHint: $('#setLanguageHint'),
      editLanguageSelect: $('#editLanguageSelect'),

      toast: $('#toast')
    };
  }

  function wireEvents() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.screen));
    });

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
      showScreen(state.terms.length ? 'learn' : 'import');
    });

    el.setSelect.addEventListener('change', (e) => switchActiveSet(e.target.value));
    el.btnSetMenu.addEventListener('click', () => {
      el.setMenu.hidden = !el.setMenu.hidden;
      el.btnSetMenu.setAttribute('aria-expanded', String(!el.setMenu.hidden));
    });
    el.btnAddSet.addEventListener('click', () => openImportScreen('add'));
    el.btnAddWord.addEventListener('click', () => openSurface('word'));
    el.btnEditLanguage.addEventListener('click', () => openSurface('language'));
    el.btnDeleteSet.addEventListener('click', deleteActiveSet);
    el.btnTheme.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    el.btnCloseSurface.addEventListener('click', closeSurface);
    el.addWordForm.addEventListener('submit', addWordManually);
    el.setLanguageForm.addEventListener('submit', changeSetLanguage);
    el.surfaceBackdrop.addEventListener('click', (event) => {
      if (event.target === el.surfaceBackdrop) closeSurface();
    });
    el.btnQuickReview.addEventListener('click', startQuickReview);

    el.reviewTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      state.reviewFilter = tab.dataset.filter;
      document.querySelectorAll('#reviewTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      positionReviewIndicator(tab);
      renderReviewList();
    });

    el.btnLearnEmptyToReview.addEventListener('click', () => showScreen('review'));
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.set-menu-wrap')) {
        el.setMenu.hidden = true;
        el.btnSetMenu.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSurface();
        el.setMenu.hidden = true;
      }
    });
    window.addEventListener('resize', () => positionReviewIndicator(el.reviewTabs.querySelector('.tab.active')));
  }

  async function deleteActiveSet() {
    if (!state.activeSetId || state.activeSetId === ALL_SETS_ID) return;
    const setName = (state.sets.find((s) => s.id === state.activeSetId) || {}).name || 'этот набор';
    const ok = await confirmDialog(`Удалить набор «${setName}» и весь его прогресс?`);
    if (!ok) return;
    await state.store.deleteSet(state.activeSetId);
    await refreshSetsList();
    state.activeSetId = await state.store.getActiveSetId();
    await loadActiveSetTerms();
    renderSetSwitcher();
    if (state.sets.length === 0) openImportScreen('first');
    else showScreen('learn');
  }

  async function boot() {
    cacheDom();
    initTheme();
    wireEvents();
    initTelegram();

    const INIT_TIMEOUT_MS = 2000;

    // The actual storage bootstrap (store creation + settings + sets list
    // + active set id). Wrapped in its own function so it can be raced
    // against a timeout below — a stuck CloudStorage callback must never
    // be able to leave the loading screen up forever.
    async function loadStorage() {
      state.store = await window.VocabStorage.VocabStore.create();
      el.syncBadge.hidden = false;
      el.syncBadge.className = 'sync-badge ' + state.store.backendName;
      el.syncBadge.textContent = state.store.backendName === 'cloud'
        ? 'Синхронизировано с Telegram'
        : 'Локальный режим (без Telegram) — прогресс останется в этом браузере';

      state.settings = await state.store.getSettings();
      await refreshSetsList();
      state.activeSetId = await state.store.getActiveSetId();
    }

    let timedOut = false;
    try {
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => { timedOut = true; resolve('timeout'); }, INIT_TIMEOUT_MS);
      });
      const outcome = await Promise.race([loadStorage().then(() => 'done'), timeoutPromise]);
      if (outcome === 'timeout') {
        console.warn('Storage init exceeded', INIT_TIMEOUT_MS, 'ms — proceeding without waiting further.');
      }
    } catch (e) {
      console.error('Storage init failed:', e);
    }

    console.log('Storage loaded:', state.sets);
    console.log('Active set:', state.activeSetId);

    // Nothing usable yet (no sets, a still-empty result because we timed
    // out, or an error above) — go straight to the import screen instead
    // of leaving the loading screen up.
    const totalWords = state.sets.reduce((sum, s) => sum + (s.termCount || 0), 0);
    if (!state.store || state.sets.length === 0 || totalWords === 0) {
      if (timedOut) console.warn('Proceeding to import screen after timeout with no confirmed sets.');
      openImportScreen('first');
      return;
    }

    if (!state.activeSetId || (state.activeSetId !== ALL_SETS_ID && !state.sets.find((s) => s.id === state.activeSetId))) {
      state.activeSetId = state.sets[0].id;
      try { await state.store.setActiveSetId(state.activeSetId); }
      catch (e) { console.error('Failed to persist active set id:', e); }
    }

    try {
      await loadActiveSetTerms();
    } catch (e) {
      console.error('Failed to load active set terms:', e);
    }

    // Defensive fallback: sets existed but this particular set somehow has
    // no terms — still don't get stuck, send the user to add words.
    if (state.terms.length === 0) {
      openImportScreen('add');
      return;
    }

    renderSetSwitcher();
    showScreen('learn');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
