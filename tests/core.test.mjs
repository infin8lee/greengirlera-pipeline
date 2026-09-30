import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, csv, safeURL, esc, planImport, pipelineData, outreachData, composeDraft, exportRows, nextProspectId, amount, stage } from '../core.js';

// All fixtures are fictional.
const pipelineRows = () => [
  { Priority: '1 - First wave', Company: 'Fairway Tea Co.', 'Name / target': 'Not publicly listed', 'Public email': 'hello@example.com', Category: 'Beverage', Stage: 'Prospect', 'Contact route': 'Shared business inbox', 'Prospect ID': 'T-001', 'Suggested sponsor ask': 'Iced tea for a golf clinic', 'Why it fits GGE': 'Local brand that hosts wellness events', 'Qualification / limits': 'Confirm venue policy' },
  { Priority: '3 - Qualify first', Company: 'Portal Bank', 'Name / target': 'Sponsorship team', 'Public email': '', Category: 'Financial services', Stage: 'Qualify first', 'Contact route': 'Application portal', 'Prospect ID': 'T-002', 'Suggested sponsor ask': 'Commercial sponsorship', 'Why it fits GGE': '' }
];
const outreachRows = () => [
  { Company: 'Fairway Tea Co.', 'Public email': 'hello@example.com', Subject: 'Tea x GGE', 'Initial outreach email': 'Hi team,\n\nLine "two", with commas.\n\nBest,\n[Your name]', 'Follow-up email': 'Following up…', 'Before sending': 'Check', 'Draft status': 'Draft', 'Prospect ID': 'T-001', 'Contact route': 'Shared business inbox', 'Follow-up subject': 'Re: Tea x GGE', Greeting: 'Hi team,' },
  { Company: 'Portal Bank', 'Public email': '33', Subject: 'Bank x GGE', 'Initial outreach email': 'Hello', 'Follow-up email': 'Again', 'Before sending': '', 'Draft status': 'Draft', 'Prospect ID': 'T-002', 'Contact route': 'Form / portal only', 'Follow-up subject': 'Re: Bank x GGE', Greeting: 'Hi Portal Bank team,' }
];

test('CSV round trip keeps multiline drafts, Unicode, commas, quotes and CRLF', () => {
  const rows = [{ Company: 'Green, Girls', 'Prospect ID': 'x-1', Draft: 'Hi "Lee",\nLet’s collaborate! 💚' }, { Company: 'Brand', 'Prospect ID': 'x-2', Draft: 'Hello\r\nTeam' }];
  const back = parseCSV(csv(rows));
  assert.equal(back[0].Draft, rows[0].Draft);
  assert.equal(back[1].Draft, 'Hello\r\nTeam');
  assert.equal(back[0].Company, 'Green, Girls');
});

test('CSV parser rejects malformed files', () => {
  assert.throws(() => parseCSV('a,b\n"unfinished'), /unfinished/);
  assert.throws(() => parseCSV('a,a\n1,2'), /Duplicate/);
  assert.throws(() => parseCSV('a,b\n1,2,3'), /more values/);
  assert.throws(() => parseCSV('a,b\nx"y,2'), /stray quote/);
  assert.deepEqual(parseCSV('a,b\n1,\n\n'), [{ a: '1', b: '' }]);
});

test('export keeps preferred column order and every extra column', () => {
  const text = csv([{ b: '2', a: '1', extra: 'x' }], ['a', 'b']);
  assert.ok(text.startsWith('﻿"a","b","extra"'));
  const rows = exportRows([{ id: 'T-9', company: 'Co', data: { Company: 'Old', Note: 'n' } }]);
  assert.deepEqual(rows[0], { Company: 'Co', Note: 'n', 'Prospect ID': 'T-9' });
});

test('unknown stages are preserved, not lost', () => {
  const d = pipelineData({ Stage: 'Qualify first' });
  assert.equal(d.Stage, 'Prospect');
  assert.equal(d['Imported stage'], 'Qualify first');
  assert.equal(stage({ data: { Stage: 'Won' } }), 'Won');
});

test('outreach import keeps pipeline route/email and ignores invalid email values', () => {
  const { data, warnings } = outreachData(outreachRows()[1], { 'Contact route': 'Application portal', 'Public email': '' });
  assert.equal(data['Outreach contact route'], 'Form / portal only');
  assert.ok(!('Contact route' in data));
  assert.ok(!('Public email' in data));
  assert.match(warnings[0], /non-email/);
});

test('pipeline then outreach import joins every record by Prospect ID', () => {
  const p = planImport([], pipelineRows());
  assert.equal(p.kind, 'pipeline');
  assert.equal(p.creates.length, 2);
  const records = p.creates.map(r => ({ ...r, version: 1 }));
  const o = planImport(records, outreachRows());
  assert.equal(o.kind, 'outreach');
  assert.equal(o.updates.length, 2);
  const tea = o.updates.find(u => u.id === 'T-001');
  assert.equal(tea.data['Initial outreach email'], outreachRows()[0]['Initial outreach email']);
  assert.equal(tea.data.Priority, '1 - First wave');
  assert.equal(tea.version, 1);
});

test('outreach before pipeline, duplicates and missing IDs are refused', () => {
  assert.throws(() => planImport([], outreachRows()), /pipeline first/);
  assert.throws(() => planImport([], [pipelineRows()[0], pipelineRows()[0]]), /repeats/);
  assert.throws(() => planImport([], [{ Company: 'X' }]), /Prospect ID/);
  assert.throws(() => planImport([], [{ Company: 'X', 'Prospect ID': 'bad id!' }]), /letters/);
});

test('fill mode protects edited values; overwrite mode replaces them', () => {
  const existing = [{ id: 'T-001', company: 'Fairway Tea Co.', version: 4, data: { ...pipelineRows()[0], Stage: 'In conversation', 'Next action': 'Call back' } }];
  const row = { ...pipelineRows()[0], 'Next action': 'Send deck' };
  const fill = planImport(existing, [row], { mode: 'fill' });
  assert.equal(fill.updates.length, 0);
  assert.equal(fill.unchanged, 1);
  const over = planImport(existing, [row], { mode: 'overwrite' });
  assert.equal(over.updates[0].data['Next action'], 'Send deck');
  assert.equal(over.updates[0].data.Stage, 'Prospect');
  assert.equal(over.updates[0].version, 4);
});

test('composer uses only saved facts, leaves placeholders and avoids em dashes', () => {
  const c = composeDraft({ ...pipelineRows()[0], Greeting: 'Hi team,' }, { organization: 'Green Girl Era', description: 'A community — for women.', signature: '[Your name]' });
  assert.match(c.subject, /^Fairway Tea Co\. x Green Girl Era: iced tea for a golf clinic$/);
  assert.match(c.body, /^Hi team,/);
  assert.match(c.body, /local brand that hosts wellness events/);
  assert.match(c.body, /\[Add confirmed audience details/);
  assert.match(c.body, /\[Add the sponsor benefits you can confirm\.\]/);
  assert.doesNotMatch(c.body + c.followupBody + c.subject, /[—–]/);
  assert.equal(c.followupSubject, 'Re: ' + c.subject);
  assert.ok(c.checks.some(x => /Confirm venue policy/.test(x)));
  const portal = composeDraft(pipelineRows()[1], {});
  assert.match(portal.body, /official request channel/);
  assert.match(portal.body, /\[Add one sentence on why Portal Bank fits/);
  assert.ok(portal.checks.some(x => /form or portal/.test(x)));
});

test('composer greets named contacts by first name and teams otherwise', () => {
  assert.match(composeDraft({ Company: 'Co', 'Name / target': 'Jordan Rivera' }).body, /^Hi Jordan,/);
  assert.match(composeDraft({ Company: 'Co', 'Name / target': 'Not publicly listed' }).body, /^Hi Co team,/);
});

test('safety helpers', () => {
  assert.equal(safeURL('javascript:alert(1)'), '');
  assert.equal(safeURL('https://example.com'), 'https://example.com/');
  assert.equal(esc('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
  assert.equal(amount('$1,500'), 1500);
  assert.equal(amount(''), 0);
  assert.equal(nextProspectId([{ id: 'GGE-060' }, { id: 'X' }]), 'GGE-061');
});
