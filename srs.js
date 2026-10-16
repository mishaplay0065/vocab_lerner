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
 *   mastery_level reaches intervals.length (5 by default) — i.e. after
 *   5 successful *spaced* reviews, because after each correct answer the
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
  const DEFAULT_INTERVALS_DAYS = [1, 3, 7, 14, 30];
  const RELEARN_MINUTES = 10;

  function makeTerm(raw) {
    const now = Date.now();
    return {
      id: raw.id || (crypto.randomUUID ? crypto.randomUUID() : 'id_' + now + '_' + Math.random().toString(36).slice(2)),
      term: raw.term,
      translation: raw.translation,
      translationAliases: Array.isArray(raw.translationAliases) ? raw.translationAliases.slice(0, 30) : [],
      context: raw.context || '',
      attempts: 0,
      correct_count: 0,
      practice_points: 0,
      srs_version: 2,
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
    const wasDue = term.attempts === 0 || isDue(term, now);
    term.mastery_level = effectiveMastery(term, intervals, now);
    term.attempts += 1;
    term.last_seen = now;

    if (isCorrect) {
      term.correct_count += 1;
      if (wasDue) {
        term.mastery_level = Math.min(term.mastery_level + 1, intervals.length);
        const stepDays = intervals[Math.min(term.mastery_level, intervals.length) - 1];
        term.due_date = now + stepDays * 24 * 60 * 60 * 1000;
      }
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

  function effectiveMastery(term, intervals, now) {
    intervals = intervals || DEFAULT_INTERVALS_DAYS;
    now = now ?? Date.now();
    const level = Math.max(0, Math.min(term.mastery_level || 0, intervals.length));
    if (!level || !term.last_seen || now < term.due_date) return level;
    const period = Math.max(1, intervals[level - 1]) * 86400000;
    const decay = Math.floor((now - term.due_date) / period) + (term.status === 'learned' ? 1 : 0);
    return Math.max(0, level - decay);
  }

  function needsReminder(term, intervals, now) {
    return term.status !== 'learned' || effectiveMastery(term, intervals, now) < (intervals || DEFAULT_INTERVALS_DAYS).length;
  }

  function masteryPercent(terms, intervals, now) {
    intervals = intervals || DEFAULT_INTERVALS_DAYS;
    if (!terms.length) return 0;
    return Math.round(terms.reduce((sum, term) => sum + effectiveMastery(term, intervals, now), 0) /
      (terms.length * intervals.length) * 100);
  }

  function reviewPriority(term, now) {
    now = now ?? Date.now();
    const overdueDays = Math.max(0, (now - (Number(term.due_date) || now)) / 86400000);
    return (term.last_review_failed ? 100 : 0) +
      (term.status !== 'new' && isDue(term, now) ? 30 : 0) +
      Math.min(overdueDays, 30) - (Number(term.mastery_level) || 0);
  }

  function isStale(term, days, now) {
    now = now || Date.now();
    if (!term.last_seen) return false;
    return (now - term.last_seen) > days * 24 * 60 * 60 * 1000;
  }

  function localDay(date) {
    const value = date || new Date();
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dayDistance(from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return NaN;
    const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
    const [toYear, toMonth, toDay] = to.split('-').map(Number);
    return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
  }

  function recordPractice(activity, today) {
    const previous = mergeActivity(activity), day = today || localDay();
    const sourceId = activity?.sourceId || 'browser';
    const days = { ...(previous.sources[sourceId] || {}) };
    days[day] = (days[day] || 0) + 1;
    return { ...mergeActivity(previous, {version:3,sources:{[sourceId]:days}}), sourceId };
  }

  function validDay(day) {
    return /^\d{4}-\d{2}-\d{2}$/.test(day || '') &&
      Number.isFinite(Date.parse(day + 'T12:00:00Z')) && new Date(day + 'T12:00:00Z').toISOString().slice(0,10) === day;
  }

  function shiftDay(day, offset) {
    const date = new Date(day + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0,10);
  }

  // Grow-only per-device counters: replay uses max, different devices add.
  // Legacy counters are a baseline, never another copy of new daily answers.
  function mergeActivity(...values) {
    const sources = {}, legacyDays = {}, inferred = new Set();
    let dailyGoal = 5, goalUpdatedAt = 0, legacyLongest = 0;
    const mergeDays = (target, days) => {
      if (!days || typeof days !== 'object' || Array.isArray(days)) return;
      Object.entries(days).forEach(([day,count]) => {
        if (validDay(day) && Number.isSafeInteger(count) && count > 0 && count <= 1000000000)
          target[day] = Math.max(target[day] || 0, count);
      });
    };
    values.forEach(value => {
      if (!value || typeof value !== 'object') return;
      const timestamp = Number.isFinite(value.goalUpdatedAt) ? value.goalUpdatedAt : 0;
      if ([5,10,20].includes(value.dailyGoal) && timestamp >= goalUpdatedAt) { dailyGoal=value.dailyGoal; goalUpdatedAt=timestamp; }
      if (value.version === 3) {
        Object.entries(value.sources || {}).forEach(([id,days]) => {
          if (/^[a-zA-Z0-9_-]{1,80}$/.test(id)) mergeDays(sources[id] ||= {}, days);
        });
        mergeDays(legacyDays, value.legacyDays);
        (Array.isArray(value.inferredDays) ? value.inferredDays : []).filter(validDay).forEach(day=>inferred.add(day));
        legacyLongest = Math.max(legacyLongest, Math.min(36600, Number(value.legacyLongest) || 0));
      } else if (validDay(value.lastDay)) {
        const streak = Math.min(3660, Math.max(1, Math.floor(Number(value.streak) || 0)));
        for(let i=0;i<streak;i++) {
          const day=shiftDay(value.lastDay,-i);
          legacyDays[day]=Math.max(legacyDays[day] || 0, i ? 1 : Math.min(1000000000,Math.max(1,Math.floor(Number(value.dailyCount) || 0))));
          if(i) inferred.add(day);
        }
        legacyLongest=Math.max(legacyLongest, Math.min(36600,Number(value.longest) || streak));
      }
    });
    const history={...legacyDays};
    Object.values(sources).forEach(days=>Object.entries(days).forEach(([day,count])=>{history[day]=(history[day] || 0)+count;}));
    const days=Object.keys(history).sort();
    let run=0, longest=legacyLongest;
    days.forEach((day,index)=>{run=index && dayDistance(days[index-1],day)===1 ? run+1 : 1; longest=Math.max(longest,run);});
    const lastDay=days.at(-1) || null;
    return {version:3,sources,legacyDays,inferredDays:[...inferred].sort(),legacyLongest,dailyGoal,goalUpdatedAt,
      history,lastDay,streak:run,longest,dailyCount:lastDay ? history[lastDay] : 0};
  }

  function currentDailyCount(activity, today) {
    return activity && activity.lastDay === (today || localDay()) ? activity.dailyCount || 0 : 0;
  }

  function currentStreak(activity, today) {
    if (!activity || !activity.lastDay) return 0;
    const distance = dayDistance(activity.lastDay, today || localDay());
    return distance === 0 || distance === 1 ? activity.streak || 0 : 0;
  }

  function calendarDays(month, today = localDay()) {
    if(!/^\d{4}-\d{2}$/.test(month) || !validDay(month+'-01')) return [];
    const first=month+'-01', weekday=(new Date(first+'T12:00:00Z').getUTCDay()+6)%7;
    const next=new Date(first+'T12:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);
    const count=dayDistance(first,next.toISOString().slice(0,10));
    return Array.from({length:Math.ceil((weekday+count)/7)*7},(_,index)=>{
      const day=shiftDay(first,index-weekday);
      return {day,inMonth:day.startsWith(month),today:day===today,future:day>today};
    });
  }

  global.VocabSrs = {
    DEFAULT_INTERVALS_DAYS,
    RELEARN_MINUTES,
    makeTerm,
    applyAnswer,
    isDue,
    effectiveMastery,
    masteryPercent,
    reviewPriority,
    needsReminder,
    isStale,
    statusFor,
    localDay,
    validDay,
    shiftDay,
    mergeActivity,
    calendarDays,
    recordPractice,
    currentDailyCount,
    currentStreak
  };
})(window);
