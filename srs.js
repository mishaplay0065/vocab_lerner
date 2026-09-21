/**
 * srs.js
 * -----------------------------------------------------------------------
 * Spaced repetition scheduler.
 *
 * Each term carries: attempts, correct_count, mastery_level, due_date,
 * last_seen, status.
 *
 *   mastery_level: 0..intervals.length. Advances by exactly one on every
 *   correct answer and is what drives the schedule (not correct_count,
 *   which is kept only for stats). A term becomes "learned" once
 *   mastery_level reaches intervals.length (10 by default) — i.e. after
 *   10 successful *spaced* reviews, because after each correct answer the
 *   due_date is pushed into the future by the matching interval, so the
 *   same item can't be re-answered and re-credited repeatedly inside one
 *   sitting.
 *
 *   On an incorrect answer, mastery_level drops by one (min 0) and the
 *   item is made due again soon (default: 10 minutes), so it resurfaces
 *   for extra practice without resetting all prior progress.
 * -----------------------------------------------------------------------
 */
(function (global) {
  const DEFAULT_INTERVALS_DAYS = [1, 2, 4, 7, 14, 21, 30, 45, 60, 90];
  const RELEARN_MINUTES = 10;

  function makeTerm(raw) {
    const now = Date.now();
    return {
      id: raw.id || (crypto.randomUUID ? crypto.randomUUID() : 'id_' + now + '_' + Math.random().toString(36).slice(2)),
      term: raw.term,
      translation: raw.translation,
      context: raw.context || '',
      attempts: 0,
      correct_count: 0,
      mastery_level: 0,
      due_date: now,       // immediately eligible for learning
      last_seen: null,
      status: 'new',
      created_at: now
    };
  }

  function statusFor(term, intervals) {
    if (term.attempts === 0) return 'new';
    if (term.mastery_level >= intervals.length) return 'learned';
    return 'learning';
  }

  /**
   * Mutates and returns the term after an answer.
   * @param {object} term
   * @param {boolean} isCorrect
   * @param {number[]} intervals - days per mastery step
   */
  function applyAnswer(term, isCorrect, intervals) {
    intervals = intervals || DEFAULT_INTERVALS_DAYS;
    const now = Date.now();
    term.attempts += 1;
    term.last_seen = now;

    if (isCorrect) {
      term.correct_count += 1;
      term.mastery_level = Math.min(term.mastery_level + 1, intervals.length);
      const stepDays = intervals[Math.min(term.mastery_level, intervals.length) - 1];
      term.due_date = now + stepDays * 24 * 60 * 60 * 1000;
    } else {
      term.mastery_level = Math.max(term.mastery_level - 1, 0);
      term.due_date = now + RELEARN_MINUTES * 60 * 1000;
    }

    term.status = statusFor(term, intervals);
    return term;
  }

  function isDue(term, now) {
    now = now || Date.now();
    return term.due_date <= now;
  }

  function isStale(term, days, now) {
    now = now || Date.now();
    if (!term.last_seen) return false;
    return (now - term.last_seen) > days * 24 * 60 * 60 * 1000;
  }

  global.VocabSrs = {
    DEFAULT_INTERVALS_DAYS,
    RELEARN_MINUTES,
    makeTerm,
    applyAnswer,
    isDue,
    isStale,
    statusFor
  };
})(window);
