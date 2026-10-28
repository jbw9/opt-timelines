// Statistics over parsed reports. Runs in the browser; also imported by tests.

import { addDays, daysBetween } from './dates.js';

export const CATEGORIES = [
  { id: 'opt', label: 'OPT, regular processing', short: 'OPT' },
  { id: 'stem', label: 'STEM OPT, regular processing', short: 'STEM OPT' },
  { id: 'premium', label: 'Premium processing (OPT or STEM)', short: 'Premium' },
];

// Premium cases run on their own clock, so they form one group regardless of type.
export const category = (r) => (r.premium ? 'premium' : r.type === 'stem' ? 'stem' : 'opt');

const EXCLUDE = ['inconsistent_order', 'implausible_duration', 'premium_start_unknown'];
export const usable = (r) => !r.flags.some((f) => EXCLUDE.includes(f)) && r.status !== 'rejected';

export const clockStart = (r) => (category(r) === 'premium' ? r.events.premium_upgrade || r.start : r.start);

export const days = (r) => (category(r) === 'premium' ? r.daysPremium : r.daysToDecision);

export const decidedOn = (r) => r.events.approved || r.events.denied || null;

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  return { n: s.length, p10: quantile(s, 0.1), p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9) };
}

const within = (date, today, windowDays) => {
  const d = daysBetween(date, today);
  return d >= 0 && d <= windowDays;
};

// Decisions reported in the last `windowDays`, widening the window when the
// sample is too thin to say anything.
export function recentDecisions(reports, cat, today, windowDays = 30) {
  for (const w of [windowDays, windowDays * 2, windowDays * 4]) {
    const picked = reports.filter((r) => usable(r) && category(r) === cat && decidedOn(r) && days(r) != null && within(decidedOn(r), today, w));
    if (picked.length >= 5 || w === windowDays * 4) return { windowDays: w, reports: picked, ...summarize(picked.map(days)) };
  }
  return null;
}

// "Now approving": the receipt dates of cases approved recently.
export function approvalFront(reports, cat, today, windowDays = 14) {
  for (const w of [windowDays, windowDays * 2, windowDays * 4]) {
    const picked = reports.filter((r) => usable(r) && category(r) === cat && r.events.approved && clockStart(r) && within(r.events.approved, today, w));
    if (picked.length >= 3 || w === windowDays * 4) {
      const offsets = summarize(picked.map((r) => daysBetween(today, clockStart(r))));
      const at = (v) => (v == null ? null : addDays(today, Math.round(v)));
      return { windowDays: w, n: picked.length, reports: picked, from: at(offsets.p10), median: at(offsets.median), to: at(offsets.p90) };
    }
  }
  return null;
}

// Approval -> card produced -> delivered, across all categories.
export function cardTimes(reports) {
  const ok = reports.filter(usable);
  return {
    toCard: summarize(ok.map((r) => r.daysToCard).filter((d) => d != null && d >= 0 && d <= 60)),
    toDelivery: summarize(ok.map((r) => r.daysToDelivery).filter((d) => d != null && d >= 0 && d <= 45)),
  };
}
