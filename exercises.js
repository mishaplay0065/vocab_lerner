/**
 * exercises.js
 * -----------------------------------------------------------------------
 * Builds the data for one exercise. Each builder returns a plain object
 * describing what to render; app.js turns that into DOM and calls back
 * into srs.js with the result. No DOM code lives here on purpose, so the
 * exercise logic stays easy to test/reuse.
 * -----------------------------------------------------------------------
 */
(function (global) {

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function normalize(str) {
    return (str || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/\s+/g, ' ')
      .replace(/[.,!?;:"'`()\[\]{}]/g, '');
  }

  function answerVariants(str) {
    return (str || '').toString().split(/\s*(?:[,;/|]|\s+или\s+)\s*/i).map(normalize).filter(Boolean);
  }

  function sameWordsInAnyOrder(a, b) {
    // Russian word order is flexible. Accept the same set of words in a
    // different order, but only when the expected answer is in Cyrillic.
    if (!/[а-яё]/i.test(b)) return false;
    const left = normalize(a).split(' ').filter(Boolean).sort();
    const right = normalize(b).split(' ').filter(Boolean).sort();
    return left.length === right.length && left.every((word, i) => word === right[i]);
  }

  function answersMatch(a, b) {
    const actual = answerVariants(a);
    const expected = answerVariants(b);
    if (actual.length === 0 || expected.length === 0) return false;
    return actual.some((given) => expected.some((answer) =>
      given === answer || sameWordsInAnyOrder(given, answer)
    ));
  }

  // ---- 1. Multiple choice ------------------------------------------------
  function buildMultipleChoice(term, pool) {
    const distractors = shuffle(
      pool.filter((t) => t.id !== term.id && t.translation.toLowerCase() !== term.translation.toLowerCase())
    ).slice(0, 3).map((t) => t.translation);

    const options = shuffle([term.translation, ...distractors]);
    return {
      kind: 'multiple_choice',
      kindLabel: 'Выбор перевода',
      promptLabel: 'Переведи слово',
      prompt: term.term,
      context: term.context,
      options,
      correctAnswer: term.translation,
      termId: term.id
    };
  }

  // ---- 2. Type answer ------------------------------------------------
  function buildTypeAnswer(term) {
    const direction = Math.random() < 0.5 ? 'to_translation' : 'to_term';
    const isToTranslation = direction === 'to_translation';
    return {
      kind: 'type_answer',
      kindLabel: 'Напиши ответ',
      promptLabel: isToTranslation ? 'Переведи слово' : 'Напиши слово по переводу',
      prompt: isToTranslation ? term.term : term.translation,
      context: term.context,
      correctAnswer: isToTranslation ? term.translation : term.term,
      termId: term.id
    };
  }

  // ---- 3. Spelling ------------------------------------------------
  function pickLettersToHide(word) {
    // Hide ~40% of alphabetic characters (at least 1), keep spaces intact.
    const chars = word.split('');
    const letterIdx = chars.map((c, i) => (/[a-zA-Zа-яёА-ЯЁäöüßÄÖÜ]/.test(c) ? i : -1)).filter((i) => i >= 0);
    const hideCount = Math.max(1, Math.round(letterIdx.length * 0.4));
    const hidden = new Set(shuffle(letterIdx).slice(0, hideCount));
    return hidden;
  }

  function buildSpellingMissingLetters(term) {
    const word = term.term;
    const hidden = pickLettersToHide(word);
    const display = word.split('').map((c, i) => (hidden.has(i) ? '_' : c)).join('');
    return {
      kind: 'spelling_missing',
      kindLabel: 'Вставь пропущенные буквы',
      promptLabel: term.translation,
      prompt: display,
      context: term.context,
      correctAnswer: word,
      termId: term.id
    };
  }

  function buildSpellingScramble(term) {
    const word = term.term.trim();
    const isPhrase = word.includes(' ');
    const units = isPhrase ? word.split(' ') : word.split('');
    let scrambled = shuffle(units);
    // Make sure it's not accidentally already in the correct order (when possible).
    if (units.length > 1) {
      let tries = 0;
      while (scrambled.join('') === units.join('') && tries < 5) {
        scrambled = shuffle(units);
        tries++;
      }
    }
    return {
      kind: 'spelling_scramble',
      kindLabel: isPhrase ? 'Собери фразу из слов' : 'Собери слово из букв',
      promptLabel: term.translation,
      prompt: null,
      context: term.context,
      tiles: scrambled,
      joinWith: isPhrase ? ' ' : '',
      correctAnswer: word,
      termId: term.id
    };
  }

  function buildSpelling(term) {
    const word = term.term.trim();
    // Very short single words are easier to scramble than to blank out.
    if (word.length <= 3 && !word.includes(' ')) return buildSpellingScramble(term);
    return Math.random() < 0.5 ? buildSpellingMissingLetters(term) : buildSpellingScramble(term);
  }

  // ---- 4. Flashcard ------------------------------------------------
  function buildFlashcard(term) {
    const showContext = Boolean(term.context) && Math.random() < 0.5;
    return {
      kind: 'flashcard',
      kindLabel: 'Карточка',
      promptLabel: showContext ? 'Вспомни слово по контексту' : 'Вспомни слово по переводу',
      prompt: showContext ? term.context : term.translation,
      answer: term.term,
      termId: term.id
    };
  }

  // ---- 5. Matching pairs (bonus, used occasionally with small pools) ----
  function buildMatching(terms) {
    const chosen = shuffle(terms).slice(0, Math.min(4, terms.length));
    const left = shuffle(chosen.map((t) => ({ termId: t.id, text: t.term, side: 'term' })));
    const right = shuffle(chosen.map((t) => ({ termId: t.id, text: t.translation, side: 'translation' })));
    return {
      kind: 'matching',
      kindLabel: 'Найди пары',
      promptLabel: 'Соедини слово и перевод',
      left,
      right,
      termIds: chosen.map((t) => t.id)
    };
  }

  // ---- Picker ------------------------------------------------
  function pickExerciseType(term, pool) {
    const types = ['multiple_choice', 'type_answer', 'spelling', 'flashcard'];
    // Multiple choice needs at least 3 other distinct translations.
    if (pool.filter((t) => t.id !== term.id).length < 3) {
      types.splice(types.indexOf('multiple_choice'), 1);
    }
    const type = types[Math.floor(Math.random() * types.length)];
    switch (type) {
      case 'multiple_choice': return buildMultipleChoice(term, pool);
      case 'type_answer': return buildTypeAnswer(term);
      case 'spelling': return buildSpelling(term);
      case 'flashcard': return buildFlashcard(term);
      default: return buildFlashcard(term);
    }
  }

  global.VocabExercises = {
    shuffle,
    normalize,
    answerVariants,
    answersMatch,
    buildMultipleChoice,
    buildTypeAnswer,
    buildSpelling,
    buildFlashcard,
    buildMatching,
    pickExerciseType
  };
})(window);
