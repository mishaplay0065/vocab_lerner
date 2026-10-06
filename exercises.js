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
      .normalize('NFC')
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

  function sameIgnoringEnglishInfinitive(a, b) {
    const left = normalize(a).replace(/^to\s+/, '');
    const right = normalize(b).replace(/^to\s+/, '');
    return Boolean(left && right && left === right && (normalize(a).startsWith('to ') || normalize(b).startsWith('to ')));
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
    // A small typo, not a different ending or several wrong letters.
    return longest >= 6 && editDistance(a, b) <= 1;
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
    const actual = [String(a || '').trim()].filter(Boolean);
    const expected = [String(b || '').trim(), ...rawAnswerVariants(b), ...(options?.alternatives || [])];
    const language = options && options.language;
    if (actual.length === 0 || expected.every(value => !value)) return false;
    return actual.some((givenRaw) => expected.some((answerRaw) => {
      if (language === 'de' && !validGermanForm(givenRaw, answerRaw)) return false;
      const given = normalize(givenRaw);
      const answer = normalize(answerRaw);
      if (options && options.strict) return given === answer;
      return given === answer ||
        (language !== 'de' && sameIgnoringLeadingEnglishArticle(given, answer)) ||
        (language === 'en' && sameIgnoringEnglishInfinitive(given, answer)) ||
        sameWordsInAnyOrder(given, answer);
    }));
  }

  function isPossibleTypo(a, b, options) {
    if (!normalize(a) || answersMatch(a, b, options)) return false;
    return [...rawAnswerVariants(b), ...(options?.alternatives || [])].some(answer => closeEnough(normalize(a), normalize(answer)) || fuzzyRussianWordsInAnyOrder(a, answer));
  }

  function canonicalLanguage(value) {
    const aliases = { 'немецкий':'de', 'german':'de', 'deutsch':'de', 'английский':'en', 'english':'en', 'русский':'ru', 'russian':'ru', 'испанский':'es', 'spanish':'es', 'французский':'fr', 'french':'fr', 'итальянский':'it', 'italian':'it', 'португальский':'pt', 'portuguese':'pt', 'японский':'ja', 'japanese':'ja', 'китайский':'zh', 'chinese':'zh', 'корейский':'ko', 'korean':'ko', 'арабский':'ar', 'arabic':'ar', 'хинди':'hi', 'hindi':'hi' };
    const normalized = String(value || '').trim().toLowerCase();
    return aliases[normalized] || (/^(en|de|es|fr|it|pt|zh|ja|ko|ar|hi|ru)(?:-|_)[a-z]+$/.test(normalized) ? normalized.split(/[-_]/)[0] : normalized);
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
      missingPositions: [...hidden].sort((a, b) => a - b),
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
    // A slash/comma means alternative answers, not one enormous spelling item.
    const variants = rawAnswerVariants(term.term);
    const word = (variants[0] || term.term).trim();
    const spellingTerm = { ...term, term: word };
    if (!/[a-zA-Zа-яёА-ЯЁäöüßÄÖÜ]/.test(word)) return buildSpellingScramble(spellingTerm);
    // Very short single words are easier to scramble than to blank out.
    if (word.length <= 3 && !word.includes(' ')) return buildSpellingScramble(spellingTerm);
    return Math.random() < 0.5 ? buildSpellingMissingLetters(spellingTerm) : buildSpellingScramble(spellingTerm);
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
    const seenTerms = new Set(), seenTranslations = new Set();
    const chosen = shuffle(terms).filter(term => {
      const word = normalize(term.term), translation = normalize(term.translation);
      if (seenTerms.has(word) || seenTranslations.has(translation)) return false;
      seenTerms.add(word); seenTranslations.add(translation); return true;
    }).slice(0, 4);
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

  function buildReviewPlan(ids, pool, budget = 20) {
    const unique = [...new Set(ids)];
    const byId = new Map(pool.map(term => [term.id, term]));
    const translations = new Set(pool.map(term => normalize(term.translation)));
    const kinds = new Map(unique.map((id) => {
      const term = byId.get(id);
      const count = translations.size - Number(translations.has(normalize(term?.translation)));
      const first = count >= 3 ? 'multiple_choice' : 'flashcard';
      return [id, term?.status === 'new' ? [first, 'type_answer', 'spelling'] : ['type_answer', 'spelling', first]];
    }));
    const goals = new Map(unique.map(id => [id, 1]));
    const priority = [...unique].sort((a, b) => {
      const weight = id => {
        const term = byId.get(id);
        return (term?.last_review_failed ? 100 : 0) + (term?.status === 'new' ? 50 : 0) + (term?.status === 'learned' ? 0 : 25) - (term?.mastery_level || 0);
      };
      return weight(b) - weight(a);
    });
    let spare = Math.max(0, budget - unique.length);
    for (let round = 2; round <= 3 && spare; round++) {
      for (const id of priority) {
        const term = byId.get(id);
        if (goals.get(id) !== round - 1 || (term?.status === 'learned' && !term?.last_review_failed) ||
            (round === 3 && !(term?.last_review_failed || term?.status === 'new'))) continue;
        goals.set(id, round); spare--;
        if (!spare) break;
      }
    }
    const plan = [];
    for (let round = 0; round < 3; round++) {
      let batch = shuffle(unique.filter(id => goals.get(id) > round));
      if (batch.length > 1 && batch[0] === plan[plan.length - 1]?.termId) batch.push(batch.shift());
      plan.push(...batch.map((termId) => ({ termId, kind: kinds.get(termId)[round] })));
    }
    return plan;
  }

  function buildExercise(kind, term, pool) {
    if (kind === 'multiple_choice') return buildMultipleChoice(term, pool);
    if (kind === 'type_answer') return buildTypeAnswer(term);
    if (kind === 'spelling') return buildSpelling(term);
    return buildFlashcard(term);
  }

  global.VocabExercises = {
    shuffle,
    normalize,
    answerVariants,
    answersMatch,
    isPossibleTypo,
    canonicalLanguage,
    buildMultipleChoice,
    buildTypeAnswer,
    buildSpelling,
    buildFlashcard,
    buildMatching,
    buildReviewPlan,
    buildExercise,
    pickExerciseType
  };
})(window);
