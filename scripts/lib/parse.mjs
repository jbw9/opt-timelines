// Turns a free-form Reddit comment (plus any follow-up replies by the same
// author) into a structured OPT / STEM OPT timeline report.
//
// Everything here is deterministic and conservative: when a date can't be tied
// to a milestone with reasonable confidence it is dropped, and reports whose
// milestones contradict each other are flagged so the site can exclude them
// from statistics while still listing them.

import { addDays, daysBetween, isoFromParts } from '../../site/js/dates.js';

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "3/4 weeks", "1-2 months", "60/90 days" are durations, not dates.
const UNIT_AFTER = /^\s*(?:-\s*\d+\s*)?(?:days?\b|d\b|weeks?\b|wks?\b|w\b|months?\b|mos?\b|business\b|biz\b|hrs?\b|hours?\b|years?\b|yrs?\b|%|x\b)/;

// Milestones in the order they normally happen. Used for sanity checks.
export const ORDER = ['recommended', 'filed', 'received', 'approved', 'card_produced', 'card_mailed', 'card_delivered'];

// Milestones whose dates may legitimately be in the future.
const FUTURE_OK = new Set(['start_date', 'program_end']);

// Longest match wins when patterns overlap, so specific phrases ("received my
// card", "application received") beat generic ones ("received", "application").
const LABELS = {
  recommended: [
    'dso\\s+recommend(?:ed|ation)(?:\\s+(?:date|in\\s+sevis|on))?',
    'recommend(?:ed|ation)\\s+(?:date|in\\s+sevis|on)',
    'sevis\\s+recommend(?:ed|ation)',
    'i-?20\\s+(?:issued|received|signed|updated|recommendation|date)',
    '(?:got|received)\\s+(?:the\\s+|my\\s+)?(?:new\\s+|updated\\s+|opt\\s+|stem\\s+)*i-?20',
  ],
  filed: [
    'appl(?:ied|ication)(?:\\s+(?:date|submitted|sent|filed|mailed))?(?:\\s+on)?',
    'applied\\s+(?:online|on|for\\s+(?:post[\\s-]*completion\\s+|initial\\s+)?(?:opt|stem(?:\\s+opt)?|ead|the\\s+extension))',
    '(?:e-?)?filed(?:\\s+(?:online|on))?',
    'filing(?:\\s+date)?',
    'date\\s+(?:of\\s+)?(?:filing|application|submission)',
    'submitted(?:\\s+(?:online|on))?',
    'submission(?:\\s+date)?',
    '(?:application|app|i-?765|packet|package)\\s+(?:was\\s+)?(?:submitted|sent|filed|mailed)',
    'mailed\\s+(?:the\\s+|my\\s+)?(?:application|app|i-?765|packet|package)',
    'fd(?=\\s*[:=-])',
  ],
  received: [
    'received(?:\\s+(?:date|on))?',
    'receiv(?:ing|ed)\\s+date',
    'receipt(?:\\s+(?:date|notice))?(?:\\s+(?:received|date|on))?',
    '(?:case|application|app|i-?765|packet|package)\\s+(?:was\\s+)?received(?:\\s+(?:by\\s+uscis|on|date))?',
    'uscis\\s+received',
    'got\\s+(?:the\\s+|my\\s+)?receipt(?:\\s+notice)?',
    'notice\\s+date',
    'delivered\\s+to\\s+(?:uscis|the\\s+lockbox|lockbox)',
    '(?:rd|nd)(?=\\s*[:=-])',
  ],
  premium_upgrade: [
    '(?:upgraded?|switched|converted)\\s+to\\s+(?:premium|pp)(?:\\s+processing)?(?:\\s+on)?',
    'premium(?:\\s+processing)?\\s+(?:upgrade|upgraded|requested|request|filed|added|applied|received|date|started|paid|on)',
    'pp\\s+(?:upgrade|upgraded|requested|request|filed|added|date|started|received|on)',
    'i-?907(?:\\s+(?:filed|received|submitted|sent|date|on))?',
    '(?:filed|applied|paid)\\s+(?:for\\s+)?(?:premium|pp|i-?907)(?:\\s+processing)?(?:\\s+on)?',
    'premium(?:\\s+processing)?',
    'pp(?=\\s*[:=-])',
  ],
  biometrics_requested: [
    'biometrics?\\s+(?:requested|request|notice|scheduled|appointment|appt)(?:\\s+(?:date|for|on))?',
    'bio(?:s)?\\s+(?:requested|notice|scheduled|appointment|appt)(?:\\s+(?:date|for|on))?',
  ],
  biometrics: [
    'biometrics?(?:\\s+(?:done|completed|taken|attended|date|on))?',
    'bio(?:s)?\\s+(?:done|completed|taken|attended)',
  ],
  rfe: [
    'rfe(?:\\s+(?:issued|received|sent|date|notice|on))?',
    '(?:received|got|issued)\\s+(?:an?\\s+)?rfe',
    'request\\s+for\\s+(?:additional\\s+)?evidence(?:\\s+(?:issued|received|sent))?',
  ],
  rfe_response: [
    'rfe\\s+(?:response|responded|reply|replied|answered)(?:\\s+(?:sent|submitted|received|on))?',
    '(?:responded|replied|response)\\s+to\\s+(?:the\\s+)?rfe(?:\\s+(?:on|sent|submitted))?',
    'rfe\\s+response\\s+received',
  ],
  approved: [
    'approv(?:ed|al)(?:\\s+(?:date|notice|email|on))?(?:\\s+(?:received|came|on))?',
    '(?:case|application|app|opt|stem(?:\\s+opt)?|ead|i-?765)\\s+(?:was\\s+|got\\s+|is\\s+)?approved(?:\\s+on)?',
    '(?:got|received)\\s+(?:the\\s+|my\\s+|an?\\s+)?approv(?:ed|al)(?:\\s+notice)?(?:\\s+on)?',
    'ad(?=\\s*[:=-])',
  ],
  denied: [
    'denied(?:\\s+on)?',
    'denial(?:\\s+notice)?(?:\\s+(?:received|on))?',
  ],
  rejected: [
    'rejected(?:\\s+on)?',
    'rejection(?:\\s+notice)?(?:\\s+(?:received|on))?',
  ],
  transferred: [
    '(?:case\\s+)?(?:was\\s+)?transferred(?:\\s+to\\s+(?:another|a\\s+different|new)\\s+office)?(?:\\s+on)?',
  ],
  silent_update: [
    'silent(?:ly)?\\s+updated?(?:\\s+on)?',
    'api\\s+(?:update|updated|changed|status\\s+changed)(?:\\s+on)?',
    '(?:updated|update|change)\\s+(?:on|in)\\s+(?:the\\s+)?api(?:\\s+on)?',
    'api\\s+(?:showed|shows)\\s+(?:an?\\s+)?(?:update|change)(?:\\s+on)?',
  ],
  card_produced: [
    '(?:new\\s+)?card\\s+(?:is\\s+|was\\s+)?(?:being\\s+)?produced(?:\\s+on)?',
    'card\\s+(?:is\\s+|was\\s+)?(?:in\\s+)?production(?:\\s+date)?(?:\\s+on)?',
    'card\\s+prod(?:uced)?',
    'cp(?=\\s*[:=-])',
  ],
  card_mailed: [
    'card\\s+(?:was\\s+|has\\s+been\\s+)?(?:mailed|shipped|sent|dispatched)(?:\\s+(?:out|on))?',
    '(?:mailed|shipped|sent)\\s+(?:out\\s+)?(?:the\\s+|my\\s+)?(?:new\\s+|ead\\s+)?card',
    '(?:card\\s+)?picked\\s+up(?:\\s+by\\s+(?:the\\s+)?usps)?',
    'usps\\s+(?:tracking|picked\\s+up)(?:\\s+number)?',
    'tracking(?:\\s+(?:number|#|no\\.?))?\\s+(?:assigned|received|available|generated|added|on)',
    'in\\s+transit',
    'shipped(?:\\s+on)?',
  ],
  card_delivered: [
    'card\\s+(?:was\\s+|got\\s+)?(?:delivered|arrived|received)(?:\\s+on)?',
    '(?:received|got)\\s+(?:the\\s+|my\\s+)?(?:physical\\s+|ead\\s+|opt\\s+|stem\\s+|new\\s+)*card(?:\\s+on)?',
    'delivered(?:\\s+on)?',
    'card\\s+in\\s+hand',
    'ead\\s+(?:card\\s+)?(?:arrived|delivered|received)(?:\\s+on)?',
    'arrived(?:\\s+on)?',
  ],
  start_date: [
    '(?:requested\\s+|employment\\s+|opt\\s+|ead\\s+|job\\s+)?start(?:s|ing)?\\s+date',
    '(?:valid|validity)\\s+from',
  ],
  program_end: [
    'program\\s+end(?:s|ed)?(?:\\s+date)?',
    'graduat(?:ed|ion|ing)(?:\\s+date|\\s+on)?',
    '(?:degree\\s+)?completion\\s+date',
    'ped(?=\\s*[:=-])',
  ],
};

// "mailed" / "sent" alone could be the application or the card.
const AMBIGUOUS = { filed_or_mailed: ['mailed(?:\\s+on)?', 'sent(?:\\s+(?:out|on))?'] };

// Phrases that contain a milestone word but are about something else. They win
// the longest-match contest and their dates are dropped.
const OTHER = { other: ['service\\s+request(?:\\s+(?:was\\s+)?(?:submitted|filed|sent|opened|created))?(?:\\s+on)?', 'case\\s+inquiry(?:\\s+(?:submitted|filed|sent))?(?:\\s+on)?', 'expedite\\s+request(?:\\s+(?:submitted|filed|sent))?(?:\\s+on)?'] };

const LABEL_RES = Object.entries({ ...LABELS, ...AMBIGUOUS, ...OTHER }).map(([key, pats]) => ({
  key,
  re: new RegExp(`(?<![a-z0-9])(?:${pats.join('|')})(?![a-z])`, 'g'),
}));

// A label preceded by one of these is talking about something that hasn't
// happened ("still no approval", "waiting for approval since 1/5").
const NEGATION_BEFORE = /(?:waiting|awaiting|wait|no|not|still|yet\s+to|until|hope|hoping|expect(?:ing|ed)?|without|w\/o|any|when|if|non|before)[\s-]+(?:for\s+)?(?:the\s+|an?\s+|my\s+|on\s+|any\s+)?(?:[\w-]+\s+){0,3}$/;

const RECEIPT = /\b(IOE|YSC|EAC|LIN|SRC|WAC|MSC|NBC)[\s-]*(\d{10})\b/gi;
const A_NUMBER = /\bA[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2,3}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;

export function redact(text) {
  return text
    .replace(RECEIPT, (_, p) => `${p.toUpperCase()}••••••••••`)
    .replace(A_NUMBER, 'A•••••••••')
    .replace(EMAIL, '[email]');
}

// Markdown tables become "Header: cell" lines so the normal pairing applies.
function flattenTables(text) {
  const lines = text.split('\n');
  const out = [];
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const sep = lines[i + 1];
    if (lines[i].includes('|') && sep && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(sep)) {
      const head = cells(lines[i]);
      i += 2;
      for (; i < lines.length && lines[i].includes('|'); i++) {
        cells(lines[i]).forEach((c, j) => { if (head[j] && c) out.push(`${head[j]}: ${c}`); });
        out.push('');
      }
      i--;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

function normalize(text) {
  return flattenTables(text)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line)) // quoted text belongs to someone else
    .join('\n')
    .replace(/~~[\s\S]*?~~/g, ' ') // struck-through text is outdated by definition
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]+/g, ' ')
    .replace(/[‐‑–—−]/g, '-')
    .replace(/[→➡⇒]|->|=>/g, ' > ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .toLowerCase();
}

function unitFollows(text, end) {
  return UNIT_AFTER.test(text.slice(end, end + 20));
}

function findDates(text) {
  const found = [];
  const add = (re, build) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const tok = build(m);
      if (!tok) continue;
      tok.start = m.index;
      tok.end = m.index + m[0].length;
      if (tok.numeric && unitFollows(text, tok.end)) continue;
      found.push(tok);
    }
  };
  const year2 = (y) => (y == null ? null : +y < 100 ? 2000 + +y : +y);

  add(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (m) => ({ y: +m[1], m: +m[2], d: +m[3] }));
  add(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2}|\d{2})\b(?![/.-]\d)/g, (m) => ({ numeric: true, a: +m[1], b: +m[2], y: year2(m[3]) }));
  add(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (m) => ({ numeric: true, a: +m[1], b: +m[2], y: null }));
  add(new RegExp(`\\b(${MONTHS})\\.?[\\s-]*(\\d{1,2})(?:st|nd|rd|th)?\\b(?:[,\\s-]*(?:'(\\d{2})|(20\\d{2}))\\b)?`, 'g'), (m) => ({
    m: MONTH_INDEX[m[1].slice(0, 3)], d: +m[2], y: year2(m[3] ?? m[4]),
  }));
  add(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*(?:of\\s+)?(${MONTHS})\\b\\.?(?:[,\\s-]*(?:'(\\d{2})|(20\\d{2}))\\b)?`, 'g'), (m) => ({
    m: MONTH_INDEX[m[2].slice(0, 3)], d: +m[1], y: year2(m[3] ?? m[4]),
  }));
  add(/\b(today|yesterday|this morning|tonight|last night)\b/g, (m) => ({ rel: m[1] === 'yesterday' || m[1] === 'last night' ? -1 : 0 }));

  // Prefer the earliest, then the longest, non-overlapping match.
  found.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start));
  const out = [];
  let lastEnd = -1;
  for (const t of found) {
    if (t.start < lastEnd) continue;
    out.push(t);
    lastEnd = t.end;
  }
  return out;
}

function findLabels(text) {
  const found = [];
  for (const { key, re } of LABEL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      // Negation only reaches back within the same line or segment.
      const before = text.slice(Math.max(0, m.index - 30), m.index).split(/[\n|;•]/).pop();
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
      const negated = NEGATION_BEFORE.test(before) || /^\s?\?/.test(after);
      found.push({ key, start: m.index, end: m.index + m[0].length, negated });
    }
  }
  found.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start));
  const out = [];
  let lastEnd = -1;
  for (const t of found) {
    if (t.start < lastEnd) continue;
    out.push(t);
    lastEnd = t.end;
  }
  return out;
}

// Gap "cost" between two adjacent tokens. Clause punctuation makes a pairing
// much less likely; label/date separators like ":" or "-" don't.
function gapCost(gap) {
  const punct = (gap.match(/[,.;!?()]/g) || []).length;
  const words = (gap.match(/[a-z]{3,}/g) || []).length;
  return gap.length + 10 * punct + 4 * words;
}

const MAX_GAP_COST = 40;
// Words between a date and a milestone that mean it hasn't happened yet.
const PREDICTION = /\b(?:expect\w*|estimat\w*|eta|hop(?:e|ing|efully)|should|projected|target\w*|predict\w*|waiting|awaiting|pending|still)\b/;

function segmentOf(text) {
  // Index -> segment id. Segments break on newlines, pipes, semicolons, bullets.
  const seg = new Int32Array(text.length + 1);
  let id = 0;
  for (let i = 0; i < text.length; i++) {
    seg[i] = id;
    if (/[\n|;•]/.test(text[i])) id++;
  }
  seg[text.length] = id;
  return seg;
}

// Pair each date with the closest adjacent label in the same segment.
function pair(text, labels, dates) {
  const seg = segmentOf(text);
  const tokens = [...labels.map((t) => ({ ...t, type: 'label' })), ...dates.map((t) => ({ ...t, type: 'date' }))]
    .sort((x, y) => x.start - y.start);

  const candidates = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.type === b.type) continue;
    const gap = text.slice(a.end, b.start);
    let sameSeg = seg[a.start] === seg[b.start];
    // "Approved:\n3/2" - a label alone at the end of a line pairs with the next line.
    if (!sameSeg && a.type === 'label' && /^\s*[:=-]?\s*[\n|]\s*$/.test(gap)) sameSeg = true;
    if (!sameSeg) continue;
    if (PREDICTION.test(gap)) continue; // "approval expected 11/20", "April 14 waiting for approval"
    const cost = gapCost(gap) + (a.type === 'label' ? 0 : 0.5); // tie -> label-before-date
    if (cost > MAX_GAP_COST) continue;
    candidates.push({ label: a.type === 'label' ? a : b, date: a.type === 'date' ? a : b, cost });
  }
  candidates.sort((x, y) => x.cost - y.cost);

  const usedLabel = new Set();
  const usedDate = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedLabel.has(c.label.start) || usedDate.has(c.date.start)) continue;
    usedLabel.add(c.label.start);
    usedDate.add(c.date.start);
    pairs.push(c);
  }

  // "Approved and card produced 3/2": chained labels share the date.
  for (let i = tokens.length - 2; i >= 0; i--) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.type !== 'label' || b.type !== 'label' || usedLabel.has(a.start)) continue;
    if (!/^\s*(?:and|&|\+|\/|,)\s*(?:the\s+)?$/.test(text.slice(a.end, b.start))) continue;
    const shared = pairs.find((p) => p.label.start === b.start && p.label.start < p.date.start);
    if (!shared) continue;
    usedLabel.add(a.start);
    pairs.push({ label: a, date: shared.date, cost: shared.cost });
  }
  return pairs.filter((p) => !p.label.negated && p.label.key !== 'other');
}

function resolveDate(tok, order, ref, key, part) {
  if (tok.rel != null) {
    // "today" in an edit refers to the edit time only if it sits after the last
    // EDIT/UPDATE marker; otherwise it's the original post time.
    const useEdit = part.edited && part.lastEditMarker >= 0 && tok.start > part.lastEditMarker;
    if (part.edited && !useEdit && part.lastEditMarker >= 0) return null;
    return { date: addDays(useEdit ? part.edited : part.created, tok.rel), approx: true };
  }
  let m = tok.m;
  let d = tok.d;
  if (tok.numeric) [m, d] = order === 'dm' ? [tok.b, tok.a] : [tok.a, tok.b];
  if (tok.y != null) {
    const iso = isoFromParts(tok.y, m, d);
    return iso ? { date: iso } : null;
  }
  // No year given: pick the year that makes sense relative to when it was posted.
  const refYear = +ref.slice(0, 4);
  const sameYear = isoFromParts(refYear, m, d);
  // "Approval expected 11/20": a date just after the post is a prediction, not last year.
  if (!FUTURE_OK.has(key) && sameYear && daysBetween(ref, sameYear) > 2 && daysBetween(ref, sameYear) <= 90) return { date: sameYear, nearFuture: true };
  let best = null;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const iso = isoFromParts(y, m, d);
    if (!iso) continue;
    if (FUTURE_OK.has(key)) {
      if (!best || Math.abs(daysBetween(ref, iso)) < Math.abs(daysBetween(ref, best))) best = iso;
    } else if (daysBetween(iso, ref) >= -2 && (!best || iso > best)) {
      best = iso;
    }
  }
  return best ? { date: best, yearInferred: true } : null;
}

function numericOrder(dateToks) {
  const numeric = dateToks.filter((t) => t.numeric);
  if (numeric.some((t) => t.a > 12 && t.b <= 12)) return { order: 'dm', ambiguous: false };
  if (numeric.some((t) => t.b > 12 && t.a <= 12)) return { order: 'md', ambiguous: false };
  return { order: 'md', ambiguous: numeric.some((t) => t.a !== t.b) };
}

function orderingProblems(ev) {
  const problems = [];
  const present = ORDER.filter((k) => ev[k]);
  for (let i = 1; i < present.length; i++) {
    if (ev[present[i]] < ev[present[i - 1]]) problems.push(`${present[i]}<${present[i - 1]}`);
  }
  const start = ev.received || ev.filed;
  if (ev.premium_upgrade && start && ev.premium_upgrade < (ev.filed || start)) problems.push('premium<start');
  if (ev.premium_upgrade && ev.approved && ev.approved < ev.premium_upgrade) problems.push('approved<premium');
  if (ev.rfe && start && ev.rfe < start) problems.push('rfe<received');
  // Biometrics always come before a decision.
  for (const k of ['biometrics_requested', 'biometrics']) if (ev[k] && ev.approved && ev.approved < ev[k]) problems.push(`approved<${k}`);
  if (ev.rfe_response && ev.rfe && ev.rfe_response < ev.rfe) problems.push('rfe_response<rfe');
  if (ev.approved && ev.rfe_response && ev.approved < ev.rfe_response) problems.push('approved<rfe_response');
  return problems;
}

function extractEvents(text, part) {
  const labels = findLabels(text);
  const dates = findDates(text);
  const pairs = pair(text, labels, dates);

  // Bare "mailed"/"sent" means the card once a decision exists, else the application.
  const decided = pairs.some((p) => ['approved', 'card_produced'].includes(p.label.key));
  for (const p of pairs) {
    if (p.label.key === 'filed_or_mailed') p.label = { ...p.label, key: decided ? 'card_mailed' : 'filed' };
  }

  const ref = part.edited || part.created;
  const { order, ambiguous } = numericOrder(pairs.map((p) => p.date));

  const build = (ord) => {
    const ev = {};
    const meta = { approx: new Set(), yearInferred: false, outOfRange: false, nearFuture: false };
    for (const p of pairs) {
      const key = p.label.key;
      if (ev[key]) continue; // first mention wins within one comment
      const r = resolveDate(p.date, ord, ref, key, part);
      if (!r) continue;
      if (r.nearFuture) {
        meta.nearFuture = true;
        continue;
      }
      if (!FUTURE_OK.has(key) && (daysBetween(r.date, ref) < -1 || daysBetween(r.date, ref) > 730)) {
        meta.outOfRange = true;
        continue;
      }
      ev[key] = r.date;
      if (r.approx) meta.approx.add(key);
      if (r.yearInferred) meta.yearInferred = true;
    }
    return { ev, meta };
  };

  let result = build(order);
  let ddmm = order === 'dm';
  const broken = (r) => r.meta.outOfRange || orderingProblems(r.ev).length > 0;
  if (ambiguous && broken(result)) {
    const alt = build('dm');
    if (!broken(alt)) {
      result = alt;
      ddmm = true;
    }
  }

  // Status words that don't come with a date still tell us where the case is.
  const said = new Set(labels.filter((l) => !l.negated).map((l) => l.key));
  return { ...result, ddmm, said, labels };
}

// The megathread template ("Date Applied: ...  Date Approved: ...") is how most
// people post. Fields often run together on one line, so each value is the
// text up to the next field label, and dates are read only from inside it.
const FIELDS = [
  ['type', /\btype\s*:/g],
  ['premium', /\bpremium\s+processing\s*:/g],
  ['filed', /\bdate\s+applied\s*:/g],
  ['rfie', /\brequest\s+for\s+initial\s+evidence\s*(?:\(rfie\))?\s*:?/g],
  ['rfe', /\brequest\s+for\s+evidence\s*(?:\(rfe\))?\s*:?/g],
  ['rfe_response', /\brfe\s+response\s*:/g],
  ['biometrics_requested', /\bbiometrics\s+requested\s*:/g],
  ['biometrics', /\bbiometrics\s+completed\s*:/g],
  ['noid', /\bnotice\s+of\s+intent\s+to\s+deny\s*(?:\(noid\))?\s*:?/g],
  ['approved', /\bdate\s+approv(?:ed|al)\s*:/g],
  ['card_produced', /\bdate\s+card\s+produced\s*:/g],
  ['card_delivered', /\bdate\s+card\s+received\s*:/g],
  ['silent_update', /\b(?:silent\s+)?api\s+update\s*:/g],
  ['center', /\bservice\s+center\s*:/g],
];
const SILENT_BEFORE = /(?:silent|api)[^0-9]{0,20}$/;

function templateEvents(text, part) {
  const hits = [];
  for (const [key, re] of FIELDS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) hits.push({ key, start: m.index, end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start);
  const keys = new Set(hits.map((h) => h.key));
  if (keys.size < 3 || !(keys.has('filed') || keys.has('approved'))) return null;

  const values = new Map();
  hits.forEach((h, i) => {
    if (!values.has(h.key)) values.set(h.key, text.slice(h.end, hits[i + 1]?.start ?? text.length));
  });
  // Later free text ("Update: approved today!") is handled by the normal pass.
  const last = hits[hits.length - 1];
  const lastValue = values.get(last.key) ?? '';
  values.set(last.key, lastValue.split('\n')[0]);

  const ref = part.edited || part.created;
  const allDates = [...values.values()].flatMap((v) => findDates(v));
  const { order } = numericOrder(allDates);
  const ev = {};
  const meta = { approx: new Set(), yearInferred: false, outOfRange: false };
  const take = (key, tok) => {
    const r = tok && resolveDate(tok, order, ref, key, part);
    if (!r || r.nearFuture) return;
    if (daysBetween(r.date, ref) < -1 || daysBetween(r.date, ref) > 730) { meta.outOfRange = true; return; }
    ev[key] = r.date;
    if (r.approx) meta.approx.add(key);
    if (r.yearInferred) meta.yearInferred = true;
  };

  const fields = new Set();
  let premium = null;
  for (const [key, value] of values) {
    const v = value.trim();
    const dates = findDates(v);
    if (key === 'premium') {
      if (/^(?:yes|y)\b/.test(v)) premium = true;
      else if (/^(?:no|n)\b/.test(v)) premium = false;
      if (premium) { fields.add('premium_upgrade'); take('premium_upgrade', dates[0]); }
    } else if (key === 'rfie' || key === 'rfe' || key === 'noid') {
      if (key === 'rfe') { fields.add('rfe'); take('rfe', dates[0]); }
    } else if (key === 'approved') {
      fields.add('approved');
      for (const d of dates) {
        if (SILENT_BEFORE.test(v.slice(0, d.start))) { if (!ev.silent_update) take('silent_update', d); } else if (!ev.approved) take('approved', d);
      }
    } else if (key !== 'type' && key !== 'center') {
      fields.add(key);
      take(key, dates[0]);
    }
  }
  const pendingAsOf = fields.has('approved') && !ev.approved ? part.created : null;
  return { ev, fields, premium, meta, pendingAsOf };
}

function detectType(text) {
  const field = text.match(/\b(?:type|category|application|app|applying\s+for|form)\s*[:=-]\s*([^\n|;,]{0,40})/);
  const classify = (s) => {
    if (/\bstem\b|24[\s-]*month|\(?c\)?\s*\(?3\)?\s*\(?c\b|\bc3c\b/.test(s)) return 'stem';
    if (/pre[\s-]*completion|\(?c\)?\s*\(?3\)?\s*\(?a\b|\bc3a\b/.test(s)) return 'pre';
    if (/post[\s-]*completion|initial\s+opt|regular\s+opt|first\s+opt|12[\s-]*month|\(?c\)?\s*\(?3\)?\s*\(?b\b|\bc3b\b|\bopt\b/.test(s)) return 'opt';
    return null;
  };
  if (field) {
    // An untouched template line ("Initial post-completion OPT / STEM OPT extension") answers nothing.
    if (/stem/.test(field[1]) && /post[\s-]*completion|initial/.test(field[1])) return { type: 'opt', inferred: true, defaulted: true };
    const t = classify(field[1]);
    if (t) return { type: t, inferred: false };
  }
  const t = classify(text);
  if (t === 'stem' || t === 'pre') return { type: t, inferred: true };
  return { type: 'opt', inferred: true, defaulted: t == null };
}

function detectPremium(text) {
  const yes = [
    /\b(?:premium|pp)(?:\s+processing)?\s*[:=?-]?\s*(?:yes|y|true|✅|✔)\b/,
    /\b(?:with|via|on|used|using|paid\s+for|upgraded?\s+to|opted\s+for|went\s+(?:with|for)|filed\s+with|applied\s+with|chose)\s+(?:the\s+)?(?:premium|pp)\b/,
    /\b(?:premium|pp)\s+(?:upgrade|upgraded|requested|filed|added|applied|case)\b/,
    /\bi-?907\b/,
  ];
  const no = [
    /\b(?:premium|pp)(?:\s+processing)?\s*[:=?-]?\s*(?:no|n|none|false|❌|✖|nope)\b/,
    /\b(?:no|without|non|w\/o|didn'?t\s+(?:use|pay\s+for|opt\s+for|do|go\s+with)|did\s+not\s+(?:use|pay\s+for|opt\s+for|do))[\s-]*(?:the\s+)?(?:premium|pp)\b/,
    /\b(?:regular|normal|standard)\s+processing\b/,
    /\bnon[\s-]?premium\b/,
  ];
  const y = yes.some((r) => r.test(text));
  const n = no.some((r) => r.test(text));
  if (y && !n) return true;
  if (n && !y) return false;
  if (y && n) {
    // "No premium initially, upgraded to premium on 2/1" - the upgrade wins.
    return /\b(?:upgraded?|switched|converted)\s+to\s+(?:premium|pp)\b/.test(text) ? true : null;
  }
  return null;
}

function detectMethod(text) {
  const center = text.match(/\b(ioe|ysc|eac|lin|src|wac|msc|nbc)(?=[\s-]*\d|\b)/);
  const online = /\b(?:online|e-?fil(?:ed|ing)|uscis\s+account)\b/.test(text);
  const paper = /\b(?:paper|by\s+mail|mailed\s+(?:in|the|my)|lockbox)\b/.test(text);
  let method = null;
  if (center) method = center[1] === 'ioe' ? 'online' : 'paper';
  else if (online && !paper) method = 'online';
  else if (paper && !online) method = 'paper';
  return { method, center: center ? center[1].toUpperCase() : null };
}

// Blank out sentences that ask a question in 4+ words or talk about other
// people's cases ("Feb 10 folks are getting approved"), keeping offsets intact.
// Short ones like "Premium? no" are template answers, not questions.
const OTHERS = /\b(?:folks|people|others|someone|somebody|anyone|anybody|friends?|they|their|he|she|his|her|guys|everyone|y'all|cases)\b/;
function blankHearsay(text) {
  return text.split(/(?<=[.!?\n])/).map((s) => {
    const question = /\?\s*$/.test(s) && (s.match(/[a-z']+/g) ?? []).length >= 4;
    const hearsay = OTHERS.test(s) && !/\b(?:i|i'm|i've|my|me|mine)\b/.test(s);
    return question || hearsay ? ' '.repeat(s.length) : s;
  }).join('');
}

// A follow-up reply counts only when it reads as the author's own news.
const OWN_UPDATE = /\b(?:update|updated|edit|finally|i\s+(?:just\s+|finally\s+)?(?:got|received)|got\s+(?:my|the)\s+(?:approval|card|email|notice)|i\s*(?:was|am|'m|have\s+been|'ve\s+been)\s+approved|my\s+(?:case|opt|stem|ead|card|application|approval)\b)/;
// "got approval email today", "approved on 23rd march" - but not advice to
// someone else ("you should be approved soon") or a question.
const ownUpdate = (text) => OWN_UPDATE.test(text)
  || (/\bapprov(?:ed|al)\b/.test(text) && !/\?/.test(text) && !OTHERS.test(text)
    && !/\b(?:you|your|should|will|would|could|might|hope|hoping|chances?|soon)\b/.test(text));

/**
 * @param {Array<{id:string, body:string, created:string, edited:string|null, url:string, topLevel?:boolean}>} parts
 *   The root comment first, then same-author follow-ups in chronological order.
 *   created/edited are YYYY-MM-DD in US Eastern time.
 */
export function parseReport(parts) {
  const events = {};
  const approx = new Set();
  const flags = new Set();
  const said = new Set();
  const texts = [];

  // Early milestones come from the earliest mention, later ones from the latest.
  const EARLY = new Set(['recommended', 'filed', 'received', 'start_date', 'program_end']);
  let templatePremium = null;
  let pendingAsOf = null;

  const normalized = parts.map((part) => normalize(part.body));
  const templates = parts.map((part, i) => templateEvents(normalized[i], { ...part, lastEditMarker: -1 }));
  const hasTemplate = templates.some(Boolean);

  for (const [i, part] of parts.entries()) {
    const text = normalized[i];
    texts.push(text);
    // Replies in a conversation are mostly about other people's cases. Once
    // someone has posted the template, the rest only counts as an update.
    const reply = i > 0 && !part.topLevel;
    if (!templates[i] && (reply || hasTemplate) && !ownUpdate(text)) continue;
    const markers = [...text.matchAll(/\b(?:edit|update|updated|upd)\b/g)];
    const ctx = { ...part, lastEditMarker: markers.length ? markers[markers.length - 1].index : -1 };
    // "Any approvals for April 14th??" asks about other people's cases.
    const r = extractEvents(blankHearsay(text), ctx);
    const t = templates[i];
    if (t) {
      for (const k of t.fields) delete r.ev[k];
      Object.assign(r.ev, t.ev);
      for (const k of t.meta.approx) r.meta.approx.add(k);
      if (t.meta.yearInferred) r.meta.yearInferred = true;
      if (t.meta.outOfRange) r.meta.outOfRange = true;
      if (t.premium != null) templatePremium = t.premium;
      if (t.pendingAsOf) pendingAsOf = t.pendingAsOf;
    }
    if (r.ddmm) flags.add('day_month_order');
    if (r.meta.yearInferred) flags.add('year_inferred');
    if (r.meta.outOfRange || r.meta.nearFuture) flags.add('date_out_of_range');
    for (const k of r.said) said.add(k);
    for (const [k, v] of Object.entries(r.ev)) {
      if (events[k] && EARLY.has(k)) continue;
      events[k] = v;
      if (r.meta.approx.has(k)) approx.add(k);
      else approx.delete(k);
    }
  }

  // Their own template said "not approved yet" on that day.
  if (pendingAsOf && events.approved && events.approved < pendingAsOf) delete events.approved;

  const all = texts.join('\n');
  const type = detectType(all);
  if (type.inferred) flags.add(type.defaulted ? 'type_assumed' : 'type_inferred');
  let premium = templatePremium ?? detectPremium(all);
  if (premium == null && events.premium_upgrade) premium = true;
  if (premium === false) delete events.premium_upgrade;
  const { method, center } = detectMethod(all);

  const problems = orderingProblems(events);
  if (problems.length) flags.add('inconsistent_order');

  let status = 'pending';
  if (events.denied || said.has('denied')) status = 'denied';
  else if (events.rejected || said.has('rejected')) status = 'rejected';
  else if (events.card_delivered) status = 'card_delivered';
  else if (events.card_mailed) status = 'card_mailed';
  else if (events.card_produced || said.has('card_produced')) status = 'card_produced';
  else if (events.approved || said.has('approved')) status = 'approved';
  else if (events.rfe_response) status = 'rfe_responded';
  else if (events.rfe || said.has('rfe')) status = 'rfe';

  const start = events.received || events.filed || null;
  if (!events.received && events.filed) flags.add('start_from_filed');
  const decided = events.approved || events.denied || null;
  const premiumStart = premium ? events.premium_upgrade || start : null;
  const last = parts[parts.length - 1];

  const derived = {
    start,
    daysToDecision: start && decided ? daysBetween(start, decided) : null,
    daysPremium: premiumStart && decided ? daysBetween(premiumStart, decided) : null,
    daysToCard: events.approved && events.card_produced ? daysBetween(events.approved, events.card_produced) : null,
    daysToDelivery: events.card_delivered && (events.card_mailed || events.card_produced)
      ? daysBetween(events.card_mailed || events.card_produced, events.card_delivered) : null,
  };
  // Premium with no upgrade date: if it took far past the 30-business-day
  // promise, they almost certainly upgraded later, so the clock start is unknown.
  if (premium && !events.premium_upgrade && derived.daysPremium > 60) flags.add('premium_start_unknown');
  if (derived.daysToDecision != null && (derived.daysToDecision < 0 || derived.daysToDecision > 400)) flags.add('implausible_duration');
  // Regular processing has never been under a week; that's a misread date.
  if (!premium && derived.daysToDecision != null && derived.daysToDecision < 7) flags.add('implausible_duration');

  return {
    type: type.type,
    premium,
    method,
    center,
    events,
    approxDates: [...approx],
    status,
    asOf: last.edited || last.created,
    flags: [...flags],
    ...derived,
  };
}

/** A parsed report is worth showing if it pins at least one core milestone to a date. */
export function isReport(r) {
  return ['filed', 'received', 'approved', 'premium_upgrade', 'denied'].some((k) => r.events[k]);
}

export function excerpt(body, max = 320) {
  const clean = redact(body)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join(' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#~]+/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, clean.lastIndexOf(' ', max))}…`;
}

