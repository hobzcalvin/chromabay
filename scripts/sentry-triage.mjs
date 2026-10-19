#!/usr/bin/env node
// Turn a "Report a problem" submission into one readable dossier: what the person said, what the
// app was doing (breadcrumbs, logs, errors, the session replay), and what their devices were doing
// at the same moment (the DIAGNOSTICS attachment from feedback.ts, and the device's own Sentry
// events and logs, joined on device_id and on the trace the app hands the device per connection).
//
//   SENTRY_TRIAGE_TOKEN=... node scripts/sentry-triage.mjs --list            # recent reports
//   SENTRY_TRIAGE_TOKEN=... node scripts/sentry-triage.mjs --issue <id>      # write the dossier
//   SENTRY_TRIAGE_TOKEN=... node scripts/sentry-triage.mjs --comment <id> <file.md>  # findings back onto the report
//
// Output: triage/<issue>.md (and .json with everything fetched), gitignored. Reports hold
// people's words, device ids and app state: they stay on this machine or in Sentry, never in this
// (public) repository or its CI logs. documentation/PROBLEM_REPORTS.md has the whole flow.
//
// The token needs org:read, project:read and event:read; --comment also needs event:write. A
// Sentry personal token or internal integration. Everything but --comment is read-only.
//
// Environment (defaults are this repo's Sentry setup):
//   SENTRY_ORG          revolt-labs
//   SENTRY_PROJECT      4511695305900032   the app's project (feedback lands here)
//   SENTRY_PROJECT_FW   4511939078782976   the firmware's project
//   SENTRY_API_URL      https://us.sentry.io/api/0
//   SENTRY_UI_URL       https://<org>.sentry.io
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (k, d) => process.env[k] || d;
const ORG = env('SENTRY_ORG', 'revolt-labs');
const APP = env('SENTRY_PROJECT', '4511695305900032');
const FW = env('SENTRY_PROJECT_FW', '4511939078782976');
const API = env('SENTRY_API_URL', 'https://us.sentry.io/api/0');
const UI = env('SENTRY_UI_URL', `https://${ORG}.sentry.io`);
const BEFORE_MIN = 15, AFTER_MIN = 2; // the window around a report that is pulled in

// ---- Sentry API ----------------------------------------------------------------------------

async function api(p, { raw = false, method = 'GET', body } = {}) {
  const token = process.env.SENTRY_TRIAGE_TOKEN;
  if (!token) throw new Error('SENTRY_TRIAGE_TOKEN is not set (needs org:read, project:read, event:read)');
  const url = p.startsWith('http') ? p : `${API}${p}`;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return raw ? r : r.json();
}
const qs = (o) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v == null ? [] : [[k, String(v)]]))).toString();

export async function listReports({ days = 14 } = {}) {
  return api(`/organizations/${ORG}/issues/?${qs({ project: APP, query: 'issue.category:feedback', statsPeriod: `${days}d`, sort: 'date', limit: 25 })}`);
}

async function projectSlugs() {
  const list = await api(`/organizations/${ORG}/projects/`);
  return Object.fromEntries(list.map((p) => [String(p.id), p.slug]));
}

async function attachmentsOf(slug, eventId) {
  const list = await api(`/projects/${ORG}/${slug}/events/${eventId}/attachments/`);
  const out = [];
  for (const a of list) {
    let text = null;
    if (/json|text/.test(a.mimetype || '') || /\.(json|txt)$/.test(a.name)) {
      const r = await api(`/projects/${ORG}/${slug}/events/${eventId}/attachments/${a.id}/?download=1`, { raw: true });
      text = await r.text();
    }
    out.push({ name: a.name, mimetype: a.mimetype, size: a.size, text });
  }
  return out;
}

async function discover(dataset, fields, query, projects, start, end, sort = 'timestamp') {
  const r = await api(`/organizations/${ORG}/events/?${qs({ dataset, field: fields, query, project: projects, start, end, sort, per_page: 100 })}`);
  return r.data || [];
}

/** Everything about one report, fetched. */
export async function fetchReport(issueId) {
  const event = await api(`/organizations/${ORG}/issues/${issueId}/events/latest/`);
  const slugs = await projectSlugs();
  const t = new Date(event.dateCreated || event.dateReceived);
  const start = new Date(t - BEFORE_MIN * 60e3).toISOString(), end = new Date(+t + AFTER_MIN * 60e3).toISOString();
  const tags = Object.fromEntries((event.tags || []).map((x) => [x.key, x.value]));
  const deviceIds = (tags.device_ids || tags.device_id || '').split(',').filter(Boolean);
  const trace = event.contexts?.trace?.trace_id;
  const safe = async (what, fn) => { try { return await fn(); } catch (e) { return { error: `${what}: ${e.message}` }; } };

  const attachments = await safe('attachments', () => attachmentsOf(slugs[String(event.projectID)] || slugs[APP], event.eventID));
  const devQuery = deviceIds.length ? `device_id:[${deviceIds.join(',')}]` : null;
  const logFields = ['timestamp', 'message', 'severity', 'project', 'trace'];
  const result = {
    issueId, event, tags, deviceIds, trace, window: { start, end }, attachments,
    appLogs: await safe('app logs', () => discover('logs', logFields, trace ? `trace:${trace}` : '', [APP], start, end)),
    deviceLogs: await safe('device logs', () => discover('logs', logFields, [trace && `trace:${trace}`, devQuery].filter(Boolean).join(' OR ') || '', [FW], start, end)),
    appErrors: await safe('app errors', () => discover('errors', ['id', 'title', 'timestamp', 'level', 'project'], devQuery ? devQuery : trace ? `trace:${trace}` : '', [APP], start, end)),
    deviceEvents: devQuery ? await safe('device events', () => discover('errors', ['id', 'title', 'timestamp', 'level', 'project', 'release'], devQuery, [FW], start, end)) : [],
  };
  return result;
}

// ---- The dossier (pure: tested by src/lib/tests/sentry-triage.test.ts) ----------------------

const fence = (s) => '```\n' + s + '\n```';
const short = (s, n = 160) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 23) : '');

/** Device events (millis since boot) on the report's clock: `up` was read when the form opened. */
export function deviceTimeline(diag, readAtIso) {
  if (!diag?.events?.length) return [];
  const readAt = Date.parse(readAtIso);
  return diag.events.map(([ms, text]) => ({
    at: Number.isFinite(readAt) && typeof diag.up === 'number' ? new Date(readAt - (diag.up - ms)).toISOString() : null,
    ms, text,
  }));
}

export function renderDossier(r) {
  const e = r.event;
  const fb = e.contexts?.feedback || {};
  const message = fb.message || e.message || e.title || '(no message)';
  const replayId = fb.replay_id || e.contexts?.replay?.replay_id || r.tags.replayId;
  const lines = [];
  lines.push(`# Problem report ${r.issueId}`, '');
  lines.push(`> ${message.split('\n').join('\n> ')}`, '');
  lines.push(`- **When:** ${e.dateCreated} (window pulled: ${r.window.start} .. ${r.window.end})`);
  lines.push(`- **Where:** ${fb.url || r.tags.url || '?'} · ${r.tags.environment || '?'} · release ${r.tags.release || '?'} · ${r.tags.browser || ''} ${r.tags.os || ''}`.trim());
  lines.push(`- **Devices:** ${r.deviceIds.length ? r.deviceIds.join(', ') : 'none tagged'} · trace ${r.trace || '?'}`);
  lines.push(`- **Links:** [report](${UI}/issues/${r.issueId}/)${replayId ? ` · [session replay](${UI}/replays/${replayId}/)` : ' · no replay'}${r.trace ? ` · [trace](${UI}/explore/traces/trace/${r.trace}/)` : ''}`);
  lines.push('');

  // Device diagnostics, read at the moment the form opened.
  const atts = Array.isArray(r.attachments) ? r.attachments : [];
  const appState = atts.find((a) => a.name === 'app-state.json');
  const readAt = (() => { try { return JSON.parse(appState?.text || '{}').at; } catch { return null; } })() || e.dateCreated;
  lines.push('## Devices at the time of the report', '');
  const devs = atts.filter((a) => /^device-.*\.json$/.test(a.name));
  if (!devs.length) lines.push(Array.isArray(r.attachments) ? '_No device attachments (no device was connected)._' : `_Attachments unavailable: ${r.attachments?.error}_`, '');
  for (const a of devs) {
    let d; try { d = JSON.parse(a.text); } catch { lines.push(`### ${a.name}`, '_unreadable_', ''); continue; }
    const name = d.device?.name || a.name;
    lines.push(`### ${name} (${d.device?.device_id || d.device?.ble_id}, ${d.device?.fw || '?'}, ${d.device?.chip || '?'})`, '');
    if (!d.diagnostics) { lines.push(`_${d.note || 'no diagnostics'}_`, ''); continue; }
    const { events, ...state } = d.diagnostics;
    lines.push(fence(JSON.stringify(state)), '');
    lines.push('Device events (oldest first; wall time derived from its uptime when the form opened):', '');
    lines.push(fence(deviceTimeline(d.diagnostics, readAt).map((x) => `${x.at ? hhmmss(x.at) : '        ?   '}  +${String(x.ms).padStart(8)} ms  ${x.text}`).join('\n')), '');
  }

  const crumbs = (e.entries || []).find((x) => x.type === 'breadcrumbs')?.data?.values || [];
  lines.push(`## App breadcrumbs (last ${Math.min(crumbs.length, 80)} of ${crumbs.length})`, '');
  lines.push(fence(crumbs.slice(-80).map((c) => `${hhmmss(c.timestamp)}  ${(c.level || '').padEnd(7)} ${(c.category || '').padEnd(12)} ${short(c.message || JSON.stringify(c.data || {}), 140)}${c.data && c.message && c.category === 'ble' ? '  ' + short(JSON.stringify(c.data), 120) : ''}`).join('\n') || '(none)'), '');

  const table = (rows, cols) => (Array.isArray(rows) ? (rows.length ? fence(rows.map((x) => cols.map((c) => (c === 'timestamp' ? hhmmss(x[c]) : short(String(x[c] ?? ''), 140))).join('  ')).join('\n')) : '_none in the window_') : `_unavailable: ${rows?.error}_`);
  lines.push('## App logs in the window (same trace)', '', table(r.appLogs, ['timestamp', 'severity', 'message']), '');
  lines.push('## Device logs in the window (same trace or device)', '', table(r.deviceLogs, ['timestamp', 'severity', 'message']), '');
  lines.push('## App errors in the window', '', table(r.appErrors, ['timestamp', 'level', 'title']), '');
  lines.push('## Device events (crashes, resets) in the window', '', table(r.deviceEvents, ['timestamp', 'level', 'release', 'title']), '');
  if (appState?.text) lines.push('## App state when the form opened', '', fence(appState.text), '');
  return lines.join('\n') + '\n';
}

// ---- CLI -------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const out = env('TRIAGE_OUT_DIR', 'triage');
  if (args[0] === '--list') {
    for (const i of await listReports()) console.log(`${i.id}\t${i.lastSeen}\t${short(i.title, 100)}`);
  } else if (args[0] === '--issue' && args[1]) {
    const r = await fetchReport(args[1]);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${args[1]}.json`), JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(out, `${args[1]}.md`), renderDossier(r));
    console.log(path.join(out, `${args[1]}.md`));
  } else if (args[0] === '--comment' && args[1] && args[2]) {
    const text = fs.readFileSync(args[2], 'utf8');
    await api(`/organizations/${ORG}/issues/${args[1]}/comments/`, { method: 'POST', body: { text } });
    console.log(`commented on ${UI}/issues/${args[1]}/`);
  } else {
    console.error('usage: sentry-triage.mjs --list | --issue <id> | --comment <id> <file.md>');
    process.exit(2);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
