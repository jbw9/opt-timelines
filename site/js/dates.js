// Calendar-date helpers. All dates are plain "YYYY-MM-DD" strings so they sort
// and compare lexically and never drift across time zones.

const DAY = 86400000;

export function isoFromParts(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null; // Feb 30 etc.
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

export function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

// Reddit timestamps are UTC seconds; USCIS and applicants think in US time.
const eastern = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

export function isoDate(utcSeconds) {
  return eastern.format(new Date(utcSeconds * 1000));
}
