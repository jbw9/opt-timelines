// Synthetic comments covering the formats seen in OPT timeline threads.
// These are test fixtures only; the site never displays them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { excerpt, isReport, parseReport, redact } from '../scripts/lib/parse.mjs';

const parse = (body, created = '2026-03-20', edited = null) => parseReport([{ id: 't', body, created, edited, url: '' }]);

test('labelled template with full dates', () => {
  const r = parse('Type: Initial OPT\nApplied: 01/05/2026\nReceived: 01/06/2026\nApproved: 03/02/2026\nCard produced: 03/04/2026\nPremium: No');
  assert.deepEqual(r.events, { filed: '2026-01-05', received: '2026-01-06', approved: '2026-03-02', card_produced: '2026-03-04' });
  assert.equal(r.type, 'opt');
  assert.equal(r.premium, false);
  assert.equal(r.daysToDecision, 55);
  assert.equal(r.daysToCard, 2);
  assert.equal(r.status, 'card_produced');
});

test('pipe separated, yearless dates infer the year from the post date', () => {
  const r = parse('STEM OPT | Online | Received 12/29 | Approved 2/27 | Card produced 3/1 | No premium');
  assert.equal(r.events.received, '2025-12-29');
  assert.equal(r.events.approved, '2026-02-27');
  assert.equal(r.type, 'stem');
  assert.equal(r.method, 'online');
  assert.ok(r.flags.includes('year_inferred'));
});

test('free-form sentences with month names', () => {
  const r = parse('Applied on Jan 5 and got approved on Feb 20. Card produced Feb 23, delivered Feb 28. IOE, no PP.');
  assert.deepEqual(r.events, { filed: '2026-01-05', approved: '2026-02-20', card_produced: '2026-02-23', card_delivered: '2026-02-28' });
  assert.equal(r.center, 'IOE');
  assert.equal(r.premium, false);
  assert.ok(r.flags.includes('start_from_filed'));
});

test('date-before-label style', () => {
  const r = parse('1/5 - applied, 1/6 - received, 3/2 - approved');
  assert.deepEqual(r.events, { filed: '2026-01-05', received: '2026-01-06', approved: '2026-03-02' });
});

test('day/month order detected from an unambiguous date', () => {
  const r = parse('Received: 15/01/2026, Approved: 03/03/2026');
  assert.equal(r.events.received, '2026-01-15');
  assert.equal(r.events.approved, '2026-03-03');
  assert.ok(r.flags.includes('day_month_order'));
});

test('day/month order inferred when month/day would put a date in the future', () => {
  const r = parse('Received: 05/01/2026, Approved: 03/02/2026');
  assert.equal(r.events.received, '2026-01-05');
  assert.equal(r.events.approved, '2026-02-03');
});

test('premium upgrade gives a separate premium clock', () => {
  const r = parse('Filed 12/20 online, upgraded to premium on 2/1, approved 2/10');
  assert.equal(r.premium, true);
  assert.equal(r.events.premium_upgrade, '2026-02-01');
  assert.equal(r.daysPremium, 9);
  assert.equal(r.daysToDecision, 52);
});

test('negated milestones are not dated', () => {
  const r = parse('Still waiting for approval since 1/5, received 1/6. No premium. STEM.');
  assert.equal(r.events.approved, undefined);
  assert.equal(r.events.received, '2026-01-06');
  assert.equal(r.status, 'pending');
});

test('chained labels share a date', () => {
  const r = parse('Approved and card produced 3/2! Applied 1/10 (regular processing)');
  assert.equal(r.events.approved, '2026-03-02');
  assert.equal(r.events.card_produced, '2026-03-02');
  assert.equal(r.premium, false);
});

test('abbreviated labels', () => {
  const r = parse('RD: 1/8\nAD: 3/5\nCP: 3/7');
  assert.deepEqual(r.events, { received: '2026-01-08', approved: '2026-03-05', card_produced: '2026-03-07' });
});

test('markdown tables', () => {
  const r = parse('| Applied | Received | Approved |\n|---|---|---|\n| 1/5 | 1/6 | 3/2 |');
  assert.deepEqual(r.events, { filed: '2026-01-05', received: '2026-01-06', approved: '2026-03-02' });
});

test('"today" uses the post date and is marked approximate', () => {
  const r = parse('Approved today!! received jan 9, it took 3-4 weeks for my friend');
  assert.equal(r.events.approved, '2026-03-20');
  assert.deepEqual(r.approxDates, ['approved']);
  assert.equal(r.events.received, '2026-01-09'); // "3-4 weeks" is not a date
});

test('paper filing with mailed application and mailed card', () => {
  const r = parse('Mailed my application 12/28, delivered to USCIS 12/30, receipt notice 1/4 (YSC). Approved 3/1, card mailed 3/5, delivered 3/9');
  assert.equal(r.events.filed, '2025-12-28');
  assert.equal(r.events.received, '2025-12-30');
  assert.equal(r.events.card_mailed, '2026-03-05');
  assert.equal(r.events.card_delivered, '2026-03-09');
  assert.equal(r.method, 'paper');
  assert.equal(r.center, 'YSC');
});

test('RFE timeline', () => {
  const r = parse('Got RFE on 2/10, responded to RFE 2/15, approved 3/1. Received date 1/3. Premium? no');
  assert.equal(r.events.rfe, '2026-02-10');
  assert.equal(r.events.rfe_response, '2026-02-15');
  assert.equal(r.premium, false);
});

test('struck-through and quoted text are ignored', () => {
  const r = parse('> approved 2/1\nReceived 1/10, ~~pending~~ approved 3/1');
  assert.equal(r.events.approved, '2026-03-01');
});

test('durations are not mistaken for dates', () => {
  const r = parse('Received 1/10. Took 2/3 months for friends. Expect 60-90 days.');
  assert.deepEqual(r.events, { received: '2026-01-10' });
});

test('contradictory dates are flagged, not silently trusted', () => {
  const r = parse('Approved: 01/02/2026\nReceived: 03/15/2026', '2026-03-20');
  assert.ok(r.flags.includes('inconsistent_order'));
});

test('follow-up replies by the author update the report', () => {
  const r = parseReport([
    { id: 'a', body: 'Received 1/12, STEM, no premium. Still pending.', created: '2026-02-01', edited: null, url: '' },
    { id: 'b', body: 'Update: approved today!', created: '2026-03-03', edited: null, url: '' },
  ]);
  assert.equal(r.events.received, '2026-01-12');
  assert.equal(r.events.approved, '2026-03-03');
  assert.equal(r.daysToDecision, 50);
  assert.equal(r.asOf, '2026-03-03');
});

test('questions without dates are not reports', () => {
  assert.equal(isReport(parse('Is premium processing worth it for STEM?')), false);
  assert.equal(isReport(parse('When did you guys get approved?')), false);
});

test('receipt numbers and A-numbers are redacted', () => {
  assert.equal(redact('IOE0912345678 and A123456789'), 'IOE•••••••••• and A•••••••••');
  assert.ok(!excerpt('my case IOE 0912345678 approved').includes('0912345678'));
});

test('a yearless date just after the post is dropped, not moved back a year', () => {
  const r = parse('Received 10/10. Approval expected 11/20', '2026-10-27');
  assert.equal(r.events.received, '2026-10-10');
  assert.equal(r.events.approved, undefined);
  assert.ok(!r.flags.includes('inconsistent_order'));
});

test('the r/f1visa 2026 megathread template', () => {
  const body = '* **Type:** Initial POST‑COMPLETION OPT\n* **Premium Processing:** NO\n* **Date Applied:**  01/12/2026\n\n\n\n* **Biometrics Requested:** N/A\n\n* **Date Approved:** 03/09/2026\n* **Date Card Produced:** 03/11/2026\n* **Date Card Received:** 03/16/2026';
  const r = parse(body, '2026-03-17');
  assert.deepEqual(r.events, { filed: '2026-01-12', approved: '2026-03-09', card_produced: '2026-03-11', card_delivered: '2026-03-16' });
  assert.equal(r.type, 'opt');
  assert.ok(!r.flags.includes('type_inferred') && !r.flags.includes('type_assumed'));
  assert.equal(r.premium, false);
  assert.equal(r.daysToDecision, 56);
});

test('template with biometrics and STEM', () => {
  const r = parse('Type: STEM OPT EXTENSION\nPremium Processing: YES\nDate Applied: 02/02/2026\nBiometrics Requested: 02/10/2026\nDate Approved: 03/06/2026', '2026-03-07');
  assert.equal(r.type, 'stem');
  assert.equal(r.premium, true);
  assert.equal(r.events.biometrics_requested, '2026-02-10');
  assert.equal(r.daysPremium, 32);
});

test('an untouched template type line is not read as STEM', () => {
  const r = parse('Type: Initial POST‑COMPLETION OPT / STEM OPT EXTENSION\nDate Applied: 02/02/2026', '2026-03-07');
  assert.equal(r.type, 'opt');
  assert.ok(r.flags.includes('type_assumed'));
});

test('a near-future yearless date does not flip the whole comment to day/month', () => {
  const r = parse('STEM OPT here, received on Mar 14, still waiting. upgraded to premium on 4/9. IOE', '2026-03-15');
  assert.equal(r.events.received, '2026-03-14');
  assert.equal(r.events.premium_upgrade, undefined);
  assert.ok(!r.flags.includes('day_month_order'));
});

test('a premium upgrade before the received date is a contradiction', () => {
  const r = parse('Received: 2026-03-14\nUpgraded to premium on 2026-02-01\nApproved: 2026-03-20', '2026-03-21');
  assert.ok(r.flags.includes('inconsistent_order'));
});

test('a date followed by "waiting for ... approval" is not an approval date', () => {
  const r = parse('anyone from April 14 waiting for STEM OPT approval, please let me know. no API update as well.', '2026-10-21');
  assert.equal(r.events.approved, undefined);
  assert.equal(r.events.silent_update, undefined);
});

// Shapes taken from real megathread comments that the free-text pass misread.
test('megathread template: premium "YES | date" is the upgrade date', () => {
  const r = parse('• Type: STEM OPT EXTENSION • Premium Processing: YES | 09/09/2026 • Date Applied: 04/02/2026 • Request for Initial Evidence (RFIE): NO • Biometrics Requested: YES • Biometrics Completed: YES • Notice of Intent to Deny (NOID): NO • Date Approved: 10/11/2026 • Date Card Produced: 10/16/2026 • Date Card Received: MM/DD/YYYY', '2026-10-20');
  assert.equal(r.premium, true);
  assert.equal(r.events.premium_upgrade, '2026-09-09');
  assert.equal(r.events.approved, '2026-10-11');
  assert.equal(r.daysPremium, 32);
  assert.equal(r.type, 'stem');
});

test('megathread template: "Premium Processing: NO" wins over later mentions of PP', () => {
  const r = parse('Type: STEM OPT EXTENSION\nPremium Processing: NO\nDate Applied: 04/07/2026\nRequest for Evidence (RFE): 10/11/2026\nRFE response: 10/14/2026\nAPI update: 10/19/2026\nDate Approved: 10/21/2026\nThinking I should have paid for PP', '2026-10-22');
  assert.equal(r.premium, false);
  assert.deepEqual(r.events, { filed: '2026-04-07', rfe: '2026-10-11', rfe_response: '2026-10-14', silent_update: '2026-10-19', approved: '2026-10-21' });
});

test('megathread template: a silent API date under Date Approved is not an approval', () => {
  const r = parse('Type: Initial POST-COMPLETION OPT Premium Processing: NO Date Applied: 04/29/2026 Biometrics Requested: 2026-06-23, Biometrics Completed: 2026-06-23, Date Approved: Silent API Update 2026-10-15, 5:15:21 a.m. Date Card Produced: MM/DD/YYYY', '2026-10-16');
  assert.equal(r.events.silent_update, '2026-10-15');
  assert.equal(r.events.approved, undefined);
  assert.equal(r.events.filed, '2026-04-29');
});

test('megathread template: placeholder dates are ignored', () => {
  const r = parse('Type: Initial POST-COMPLETION OPT\nPremium Processing: YES/NO\nDate Applied: 03/01/2026\nBiometrics Requested: YES/NO | MM/DD/YYYY (if applicable)\nDate Approved: MM/DD/YYYY', '2026-04-01');
  assert.deepEqual(r.events, { filed: '2026-03-01' });
});

test('premium with no upgrade date and a long wait has an unknown clock start', () => {
  const r = parse('Type: OPT\nPremium Processing: YES\nDate Applied: 03/15/2026\nDate Approved: 10/06/2026', '2026-10-07');
  assert.ok(r.flags.includes('premium_start_unknown'));
});

test('questions about other cases are not reports', () => {
  assert.equal(isReport(parse('Any non PP stem Opt approval for April 14th ??', '2026-10-20')), false);
});

test('a service request date is not the filing date', () => {
  const r = parse('Got an email for the service request submitted on Oct 17 saying approval notice was mailed. Applied on - April 13, 2026. Approved Oct 20', '2026-10-21');
  assert.equal(r.events.filed, '2026-04-13');
  assert.equal(r.events.approved, '2026-10-20');
});

test('replies about other cases are ignored, short own updates count', () => {
  const tpl = { id: 'a', body: 'Type: OPT\nPremium Processing: NO\nDate Applied: 02/23/2026\nDate Approved: TBD', created: '2026-04-01', edited: null, url: '', topLevel: true };
  const reply = (id, body, created) => ({ id, body, created, edited: null, url: '' });
  const r = parseReport([tpl,
    reply('b', 'Since Feb 10 11 12 folks are getting approved right now I would consider PP', '2026-04-19'),
    reply('c', 'You should be approved by May 2', '2026-04-20'),
    reply('d', 'approved on 3rd may', '2026-05-04')]);
  assert.equal(r.events.approved, '2026-05-03');
  assert.equal(r.events.filed, '2026-02-23');
});
