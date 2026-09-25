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

  function rawAnswerVariants(str) {
    return (str || '').toString().split(/\s*(?:[,;/|]|\s+или\s+)\s*/i).map((value) => value.trim()).filter(Boolean);
  }

  function sameWordsInAnyOrder(a, b) {
    // Russian word order is flexible. Accept the same set of words in a
    // different order, but only when the expected answer is in Cyrillic.
    if (!/[а-яё]/i.test(b)) return false;
    const left = normalize(a).split(' ').filter(Boolean).sort();
    const right = normalize(b).split(' ').filter(Boolean).sort();
    return left.length === right.length && left.every((word, i) => word === right[i]);
  }

  function withoutLeadingEnglishArticle(value) {
    return normalize(value).replace(/^(?:a|an|the)\s+/i, '');
  }

  function sameIgnoringLeadingEnglishArticle(a, b) {
    const left = withoutLeadingEnglishArticle(a);
    const right = withoutLeadingEnglishArticle(b);
    return Boolean(left && right && left === right);
  }

  function wordsPreservingCase(value) {
    return (value || '')
      .trim()
      .replace(/[.,!?;:"'`()\[\]{}]/g, '')
      .split(/\s+/)
      .filter(Boolean);
  }

  function validGermanForm(given, expected) {
    const actualWords = wordsPreservingCase(given);
    const expectedWords = wordsPreservingCase(expected);
    if (!actualWords.length || !expectedWords.length) return false;

    const articles = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer']);
    const expectedArticle = expectedWords[0].toLocaleLowerCase();
    if (articles.has(expectedArticle) && actualWords[0].toLocaleLowerCase() !== expectedArticle) return false;

    // German nouns are capitalized. If the stored correct form contains an
    // uppercase word, require the learner to capitalize that word too.
    return expectedWords.every((word, index) => {
      if (!/^[A-ZÄÖÜ]/.test(word)) return true;
      return Boolean(actualWords[index] && /^[A-ZÄÖÜ]/.test(actualWords[index]));
    });
  }

  function editDistance(a, b) {
    const left = Array.from(a);
    const right = Array.from(b);
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    left.forEach((char, row) => {
      const current = [row + 1];
      right.forEach((other, column) => {
        current.push(Math.min(
          current[column] + 1,
          previous[column + 1] + 1,
          previous[column] + (char === other ? 0 : 1)
        ));
      });
      previous = current;
    });
    return previous[right.length];
  }

  function closeEnough(a, b) {
    if (a === b) return true;
    const longest = Math.max(a.length, b.length);
    if (longest < 5) return false;
    const allowance = longest >= 9 ? 2 : 1;
    return editDistance(a, b) <= allowance;
  }

  function fuzzyRussianWordsInAnyOrder(a, b) {
    if (!/[а-яё]/i.test(b)) return false;
    const given = normalize(a).split(' ').filter(Boolean);
    const expected = normalize(b).split(' ').filter(Boolean);
    if (given.length !== expected.length) return false;
    const unused = expected.slice();
    return given.every((word) => {
      const matchIndex = unused.findIndex((candidate) => closeEnough(word, candidate));
      if (matchIndex < 0) return false;
      unused.splice(matchIndex, 1);
      return true;
    });
  }

  function answersMatch(a, b, options) {
    const actual = rawAnswerVariants(a);
    const expected = rawAnswerVariants(b);
    const language = options && options.language;
    if (actual.length === 0 || expected.length === 0) return false;
    return actual.some((givenRaw) => expected.some((answerRaw) => {
      if (language === 'de' && !validGermanForm(givenRaw, answerRaw)) return false;
      const given = normalize(givenRaw);
      const answer = normalize(answerRaw);
      return given === answer ||
        (language !== 'de' && sameIgnoringLeadingEnglishArticle(given, answer)) ||
        sameWordsInAnyOrder(given, answer) ||
        fuzzyRussianWordsInAnyOrder(given, answer) ||
        closeEnough(given, answer);
    }));
  }

  // ---- 1. Multiple choice ------------------------------------------------
  function buildMultipleChoice(term, pool) {
    const seen = new Set([normalize(term.translation)]);
    const distractors = shuffle(pool).filter((candidate) => {
      if (candidate.id === term.id) return false;
      const key = normalize(candidate.translation);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3).map((candidate) => candidate.translation);

    const options = shuffle([term.translation, ...distractors]);
    return {
      kind: 'multiple_choice',
      kindLabel: 'Выбор перевода',
      promptLabel: 'Переведи слово',
      prompt: term.term,
      context: term.context,
      options,
      correctAnswer: term.translation,
      answerSide: 'translation',
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
      answerSide: isToTranslation ? 'translation' : 'term',
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
      answerSide: 'term',
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
      answerSide: 'term',
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
    return {
      kind: 'flashcard',
      kindLabel: 'Карточка',
      promptLabel: 'Вспомни перевод выражения',
      prompt: term.term,
      answer: term.translation,
      answerSide: 'translation',
      termId: term.id
    };
  }

  // ---- 5. Matching pairs (bonus, used occasionally with small pools) ----
  function buildMatching(terms) {
    const chosen = shuffle(terms).slice(0, Math.min(4, terms.length));
    const left = shuffle(chosen.map((t) => ({ termId: t.id, text: t.translation, side: 'translation' })));
    const right = shuffle(chosen.map((t) => ({ termId: t.id, text: t.term, side: 'term' })));
    return {
      kind: 'matching',
      kindLabel: 'Найди пары',
      promptLabel: 'Слева — русский, справа — изучаемый язык',
      left,
      right,
      termIds: chosen.map((t) => t.id)
    };
  }

  // ---- Picker ------------------------------------------------
  function pickExerciseType(term, pool) {
    const types = ['multiple_choice', 'type_answer', 'spelling', 'flashcard'];
    // Multiple choice needs at least 3 other distinct translations.
    const distinctTranslations = new Set(pool
      .filter((candidate) => candidate.id !== term.id)
      .map((candidate) => normalize(candidate.translation))
      .filter((translation) => translation && translation !== normalize(term.translation)));
    if (distinctTranslations.size < 3) {
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
