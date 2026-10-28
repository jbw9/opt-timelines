// Decoder for the case JSON a reader's own myUSCIS account loads (what people
// call the "silent API"). It runs only in this page; the Content-Security-Policy
// (connect-src 'self') stops it sending data anywhere.

// Code meanings from the NIEM 4.2 BenefitDocumentStatusCategoryCode list.
// USCIS has never published what these codes mean for a particular case.
const NIEM = 'https://niem.github.io/model/4.2/scr/BenefitDocumentStatusCategoryCodeSimpleType/index.html';
const CODES = {
  IAA: 'Receipt notice sent',
  IAF: 'Receipt letter emailed',
  FNB: 'Fingerprints taken',
  FTA0: 'Database checks received',
  HD: 'Correspondence received',
  IK: 'Request for additional evidence sent',
  IKP: 'Premium processing clock stopped, request for evidence sent',
  IKE: 'Initial evidence requested through e-filing',
  FB0: 'Request evidence',
  FA: 'Case returned for additional evidence, notice ordered',
  FBA: 'Initial evidence request notice ordered',
  IP: 'Transfer notice sent',
  FOA: 'File transfer requested, processing not suspended',
  DA: 'Approved, notice ordered',
  DB: 'Approved and certified, notice ordered',
  IEA: 'Approval notice sent',
  LDA: 'Card produced',
  LEA: 'Card mailed to applicant',
  LEC: 'Card given to applicant in person',
  LFA: 'Card returned as undeliverable',
  EA: 'Denial notice ordered',
  EAA: 'Denied in part, notice ordered',
  IFA: 'Denial notice sent',
};
const CAVEATS = {
  IFA: 'People have reported seeing IFA on cases that were not denied, so treat it with caution.',
  FTA0: 'Background checks coming back. It is not a decision.',
};

function p(...parts) {
  const el = document.createElement('p');
  el.append(...parts);
  return el;
}

const link = (href, text) => {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
};

export function mountDecoder(root) {
  const input = root.querySelector('#json-in');
  const out = root.querySelector('#json-out');
  root.querySelector('#json-read').addEventListener('click', () => out.replaceChildren(...decode(input.value)));
  root.querySelector('#json-clear').addEventListener('click', () => { input.value = ''; out.replaceChildren(); });
}

const fmtWhen = (v) => {
  const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  if (Number.isNaN(t)) return String(v);
  return new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
};

// Collect the handful of fields people have documented, wherever they sit.
function collect(node, found = { events: [] }) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  for (const [k, v] of Object.entries(node)) {
    if (['formType', 'statusTitle', 'updatedAt', 'updatedAtTimestamp', 'currentActionCode', 'currentActionCodeDate', 'ackedByAdjudicatorAndCms', 'agencyActionRequired'].includes(k) && found[k] == null && (typeof v !== 'object' || v === null)) {
      found[k] = v;
    }
    if (k === 'events' && Array.isArray(v)) {
      for (const e of v) {
        if (e && typeof e === 'object' && e.eventCode) found.events.push({ code: String(e.eventCode), when: e.eventDateTime ?? e.createdAt ?? e.updatedAt ?? null });
      }
    } else if (v && typeof v === 'object') {
      collect(v, found);
    }
  }
  return found;
}

function codeRow(code, when) {
  const tr = document.createElement('tr');
  const meaning = CODES[code.toUpperCase()];
  for (const text of [when ? fmtWhen(when) : '—', code, meaning ?? 'Not in our list. Look it up in the NIEM code list.']) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  if (CAVEATS[code.toUpperCase()]) tr.lastChild.append(document.createElement('br'), CAVEATS[code.toUpperCase()]);
  return tr;
}

function decode(raw) {
  const text = raw.trim();
  if (!text) return [p('Paste the JSON first.')];
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [p('That isn\'t valid JSON. Paste the whole response, from the first { to the last }.')];
  }
  const f = collect(json);
  const out = [];
  const facts = document.createElement('dl');
  facts.className = 'facts';
  const add = (label, value) => {
    if (value == null || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  };
  add('Form', f.formType);
  add('Status shown', f.statusTitle);
  const updated = f.updatedAt ?? f.updatedAtTimestamp;
  if (updated != null) {
    const t = typeof updated === 'number' ? (updated > 1e12 ? updated : updated * 1000) : Date.parse(updated);
    const ago = Number.isNaN(t) ? '' : `, ${Math.max(0, Math.round((Date.now() - t) / 86400000))} days ago`;
    add('Last updated', `${fmtWhen(updated)}${ago}`);
  }
  if (f.currentActionCode) add('Current action code', `${f.currentActionCode}${CODES[String(f.currentActionCode).toUpperCase()] ? `: ${CODES[String(f.currentActionCode).toUpperCase()]}` : ''}${f.currentActionCodeDate ? ` (${fmtWhen(f.currentActionCodeDate)})` : ''}`);
  if (f.ackedByAdjudicatorAndCms != null) add('ackedByAdjudicatorAndCms', `${f.ackedByAdjudicatorAndCms}. Not documented; one tracker reports it is set on nearly every case.`);
  if (f.agencyActionRequired != null) add('agencyActionRequired', `${f.agencyActionRequired}. Not documented.`);
  if (facts.childElementCount) out.push(facts);

  if (f.events.length) {
    const table = document.createElement('table');
    table.className = 'compare';
    table.innerHTML = '<thead><tr><th scope="col">When</th><th scope="col">Code</th><th scope="col">NIEM meaning</th></tr></thead>';
    const body = document.createElement('tbody');
    const sorted = [...f.events].sort((a, b) => String(a.when).localeCompare(String(b.when)));
    body.append(...sorted.map((e) => codeRow(e.code, e.when)));
    table.append(body);
    out.push(table);
  }
  if (!out.length) return [p('No fields we recognize were found. We look for updatedAt, statusTitle, currentActionCode and an events list.')];
  out.push(p(link(NIEM, 'Code meanings come from the NIEM list'), '. USCIS has never published them.'));
  return out;
}
