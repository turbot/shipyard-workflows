'use strict';

// The due rule of the central start: is this repo due this hour? A pure function of the facts it
// is given. It reads no clock, no file and no network, and keeps no state, so two runs in the
// same hour with the same facts give the same answer.
//
//   daily   due once the area's start time (UTC) has passed
//   weekly  due once that time has passed on the area's weekly day
//   manual  never
//
// A repo is due only while nothing has started its release since that start time: no prep job
// (open or closed: a person closing one means "not today") and no tag made at or after it. A
// late run still sees a due repo as due for 24 hours after its start, so a 21:00 start is still
// due at 00:07 UTC, and a start is never lost to the change of the UTC day. Each start counts
// from the latest occurrence of the area's time at or before `now`, so a prep job or tag from
// an earlier start never blocks the next one.

const { WEEKDAYS, TIME } = require('./areas');

class DueError extends Error {}

const CADENCES = ['daily', 'weekly', 'manual'];
const DAY_MS = 24 * 60 * 60 * 1000;

// A full ISO date with its zone: a string without one would read as the machine's local time.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function toMs(value, what) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' && ISO_WITH_ZONE.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new DueError(`${what} must be a Date or an ISO date string with its zone, such as 2026-11-24T09:07:00Z (got ${JSON.stringify(value) ?? String(value)})`);
  return ms;
}

const iso = (ms) => new Date(ms).toISOString();

// The latest occurrence of a start time ("HH:MM", UTC) at or before `nowMs`: today's if it has passed, else yesterday's.
function latestStart(nowMs, time) {
  const [hh, mm] = time.split(':').map(Number);
  const midnight = nowMs - (((nowMs % DAY_MS) + DAY_MS) % DAY_MS);
  const startMs = midnight + (hh * 60 + mm) * 60 * 1000;
  return startMs > nowMs ? startMs - DAY_MS : startMs;
}

/**
 * Decide whether one repo is due.
 *
 * @param {object} facts
 * @param {Date|string} facts.now the moment of the run
 * @param {{start: string, weeklyDay: string}} [facts.area] the repo's area, as lib/areas.js reads it
 *   (not needed for a `manual` repo)
 * @param {'daily'|'weekly'|'manual'} facts.cadence
 * @param {Array<{createdAt: Date|string, state: string}>} [facts.prepJobs] prep jobs, any state,
 *   that the caller fetched for the repo (jobs made before the start time are ignored here)
 * @param {Date|string|null} [facts.newestTagAt] when the newest tag was made, if the repo has one
 * @returns {{due: boolean, why: string}}
 */
function isDue({ now, area, cadence, prepJobs = [], newestTagAt = null } = {}) {
  const nowMs = toMs(now, 'now');
  if (!CADENCES.includes(cadence)) throw new DueError(`cadence must be one of ${CADENCES.join(', ')} (got ${JSON.stringify(cadence) ?? String(cadence)})`);
  if (cadence === 'manual') return { due: false, why: 'manual repo: the schedule never starts it' };
  if (!area || typeof area.start !== 'string' || !TIME.test(area.start)) {
    throw new DueError(`area.start must be a time of day as "HH:MM" in UTC (got ${JSON.stringify(area && area.start) ?? 'nothing'})`);
  }
  if (cadence === 'weekly' && !WEEKDAYS.includes(area.weeklyDay)) {
    throw new DueError(`area.weeklyDay must be a lower-case weekday name (got ${JSON.stringify(area.weeklyDay) ?? 'nothing'})`);
  }
  if (!Array.isArray(prepJobs)) throw new DueError('prepJobs must be a list');
  // Every fact is checked before any is used, so a bad one never hides behind an early answer.
  const jobs = prepJobs.map((job, i) => ({
    at: toMs(job && job.createdAt, `prepJobs[${i}].createdAt`),
    open: String(job.state).toLowerCase() === 'open',
  }));
  const tagMs = newestTagAt === null || newestTagAt === undefined ? null : toMs(newestTagAt, 'newestTagAt');

  const startMs = latestStart(nowMs, area.start);

  if (cadence === 'weekly') {
    const startDay = WEEKDAYS[(new Date(startMs).getUTCDay() + 6) % 7];
    if (startDay !== area.weeklyDay) {
      return { due: false, why: `weekly repo: the latest ${area.start} UTC (${iso(startMs)}) was on ${startDay}, its day is ${area.weeklyDay}` };
    }
  }
  const kind = cadence === 'weekly' ? `weekly start ${area.start} UTC on ${area.weeklyDay}` : `daily start ${area.start} UTC`;

  const since = jobs.find((job) => job.at >= startMs);
  if (since) return { due: false, why: `a prep job ${since.open ? 'is open' : 'was closed'} since the start (made ${iso(since.at)}; start ${iso(startMs)})` };
  if (tagMs !== null && tagMs >= startMs) return { due: false, why: `a tag was made since the start (${iso(tagMs)}; start ${iso(startMs)})` };
  return { due: true, why: `past the ${kind} (${iso(startMs)}) with no prep job and no tag since` };
}

module.exports = { DueError, isDue, latestStart };
