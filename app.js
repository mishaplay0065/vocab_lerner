/**
 * app.js
 * -----------------------------------------------------------------------
 * Main controller: screens (Import / Learn / Review / Progress), session
 * queue management, rendering and event wiring. Persistence goes through
 * VocabStorage; scheduling math through VocabSrs; exercise data through
 * VocabExercises; CSV parsing through VocabCsv.
 * -----------------------------------------------------------------------
 */
(function () {
  'use strict';

  const { StorageService } = window.VocabStorage;
  const Srs = window.VocabSrs;
  const Ex = window.VocabExercises;
  const Csv = window.VocabCsv;

  const storage = StorageService.create();

  // Embedded fallback demo set so the "Загрузить демо-набор" button works
  // even when the app is opened straight from disk (file://), where
  // fetching data/sample.csv would be blocked by the browser.
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

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    terms: [],
    settings: null,
    screen: 'import',      // import | learn | review | progress
    session: {
      queue: [],            // array of term ids
      initialLength: 0,
      current: null,         // current exercise payload
      answered: false,
      matchingState: null
    },
    reviewFilter: 'due'
  };

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    topbarTitle: $('#topbarTitle'),
    btnReset: $('#btnReset'),
    screens: {
      import: $('#screen-import'),
      learn: $('#screen-learn'),
      review: $('#screen-review'),
      progress: $('#screen-progress')
    },
    bottomnav: $('#bottomnav'),
    fileInput: $('#fileInput'),
    dropzone: $('#dropzone'),
    btnLoadDemo: $('#btnLoadDemo'),
    importErrors: $('#importErrors'),

    learnProgressFill: $('#learnProgressFill'),
    learnCounter: $('#learnCounter'),
    exerciseCard: $('#exerciseCard'),
    learnEmpty: $('#learnEmpty'),
    btnLearnEmptyToReview: $('#btnLearnEmptyToReview'),

    reviewStats: $('#reviewStats'),
    reviewTabs: $('#reviewTabs'),
    reviewList: $('#reviewList'),
    btnStartReview: $('#btnStartReview'),

    progressStats: $('#progressStats'),
    progressBarFill: $('#progressBarFill'),
    progressBarLabel: $('#progressBarLabel'),
    wordTable: $('#wordTable'),

    toast: $('#toast')
  };

  const SCREEN_TITLES = { learn: 'Учить', review: 'Повторение', progress: 'Прогресс', import: 'Карточки' };

  // ---------------------------------------------------------------------
  // Telegram WebApp integration
  // ---------------------------------------------------------------------
  function initTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('secondary_bg_color');
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

  // ---------------------------------------------------------------------
  // Screen navigation
  // ---------------------------------------------------------------------
  function showScreen(name) {
    state.screen = name;
    Object.keys(el.screens).forEach((key) => { el.screens[key].hidden = key !== name; });
    el.topbarTitle.textContent = SCREEN_TITLES[name];
    el.bottomnav.hidden = name === 'import';
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.screen === name);
    });

    if (name === 'learn') startLearnSession();
    if (name === 'review') renderReview();
    if (name === 'progress') renderProgress();
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });

  // ---------------------------------------------------------------------
  // Import flow
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

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function handleCsvText(text, sourceName) {
    const { items, errors, warnings } = Csv.parseCsv(text);
    renderImportErrors(errors, warnings);
    if (errors.length || items.length === 0) return;

    const terms = items.map((it) => Srs.makeTerm(it));
    state.terms = terms;
    await storage.setTerms(terms);
    await storage.setMeta({ importedAt: Date.now(), sourceFileName: sourceName || 'demo', count: terms.length });
    showToast(`Загружено слов: ${terms.length}`);
    showScreen('learn');
  }

  el.fileInput.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      await handleCsvText(text, file.name);
    } catch (e) {
      renderImportErrors(['Не удалось прочитать файл. Попробуйте ещё раз.'], []);
    } finally {
      el.fileInput.value = '';
    }
  });

  el.btnLoadDemo.addEventListener('click', () => handleCsvText(DEMO_CSV, 'demo.csv'));

  el.btnReset.addEventListener('click', async () => {
    const ok = await confirmDialog('Удалить текущий список слов и загрузить новый? Прогресс будет потерян.');
    if (!ok) return;
    await storage.clearAll();
    state.terms = [];
    el.importErrors.hidden = true;
    showScreen('import');
  });

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
  const SESSION_SIZE = 10;

  function buildLearnQueue(terms) {
    const now = Date.now();
    const due = terms.filter((t) => t.status !== 'new' && Srs.isDue(t, now))
      .sort((a, b) => a.due_date - b.due_date);
    const fresh = terms.filter((t) => t.status === 'new')
      .sort((a, b) => a.created_at - b.created_at);
    return [...due, ...fresh].slice(0, SESSION_SIZE).map((t) => t.id);
  }

  function getTermById(id) { return state.terms.find((t) => t.id === id); }

  function startLearnSession(customQueue) {
    const queue = customQueue || buildLearnQueue(state.terms);
    state.session.queue = queue;
    state.session.initialLength = Math.max(queue.length, 1);
    state.session.answered = false;
    state.session.matchingState = null;
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

    // Occasionally offer the bonus "matching" round when enough items remain.
    if (state.session.queue.length >= 4 && Math.random() < 0.2) {
      const ids = state.session.queue.slice(0, 4);
      const terms = ids.map(getTermById);
      renderMatching(terms);
      return;
    }

    const termId = state.session.queue[0];
    const term = getTermById(termId);
    const exercise = Ex.pickExerciseType(term, state.terms);
    state.session.current = exercise;
    state.session.answered = false;
    renderExercise(exercise);
  }

  function advanceAfterAnswer(isCorrect) {
    const id = state.session.queue.shift();
    if (!isCorrect) state.session.queue.push(id); // resurface later this session
    setTimeout(renderLearnStep, 550);
  }

  async function scoreTerm(termId, isCorrect) {
    const term = getTermById(termId);
    Srs.applyAnswer(term, isCorrect, state.settings.intervalsDays);
    await storage.setTerms(state.terms);
  }

  function renderExercise(exercise) {
    const card = el.exerciseCard;
    card.innerHTML = '';

    const kindEl = document.createElement('div');
    kindEl.className = 'exercise-kind';
    kindEl.textContent = exercise.kindLabel;
    card.appendChild(kindEl);

    if (exercise.kind === 'flashcard') {
      renderFlashcard(card, exercise);
      return;
    }

    const promptLabel = document.createElement('div');
    promptLabel.className = 'exercise-prompt-label';
    promptLabel.textContent = exercise.promptLabel;
    card.appendChild(promptLabel);

    if (exercise.prompt) {
      const prompt = document.createElement('div');
      prompt.className = 'exercise-prompt';
      prompt.textContent = exercise.prompt;
      card.appendChild(prompt);
    }

    if (exercise.context) {
      const ctx = document.createElement('div');
      ctx.className = 'exercise-context';
      ctx.textContent = '«' + exercise.context + '»';
      card.appendChild(ctx);
    }

    const feedback = document.createElement('div');
    feedback.className = 'feedback';
    feedback.hidden = true;
    feedback.id = 'feedbackBox';

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
      input.placeholder = 'Введите ответ';
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
    if (!value.trim()) { input.focus(); return; }
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

    const leftCol = document.createElement('div');
    const rightCol = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gap = '8px';

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

    exercise.left.forEach((item) => grid.appendChild(makeCell(item)));
    exercise.right.forEach((item) => grid.appendChild(makeCell(item)));

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

  el.btnLearnEmptyToReview.addEventListener('click', () => showScreen('review'));

  // ---------------------------------------------------------------------
  // Review screen
  // ---------------------------------------------------------------------
  function statTile(num, label) {
    return `<div class="stat-tile"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  }

  function renderReview() {
    const stats = computeStats(state.terms);
    el.reviewStats.innerHTML =
      statTile(stats.total, 'Всего') +
      statTile(stats.new, 'Новые') +
      statTile(stats.learning, 'Учатся') +
      statTile(stats.dueToday, 'Сегодня') +
      statTile(stats.learned, 'Изучено') +
      statTile(stats.successRate + '%', 'Точность');

    renderReviewList();
  }

  el.reviewTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.reviewFilter = tab.dataset.filter;
    document.querySelectorAll('#reviewTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderReviewList();
  });

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
  // Boot
  // ---------------------------------------------------------------------
  async function boot() {
    initTelegram();
    state.settings = await storage.getSettings();
    const terms = await storage.getTerms();
    state.terms = terms || [];
    if (state.terms.length > 0) {
      showScreen('learn');
    } else {
      showScreen('import');
    }
  }

  boot();
})();
