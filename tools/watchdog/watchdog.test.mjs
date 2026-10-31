import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  WORKFLOWS, automationState, claimDispatch, createAppJwt, decisionForWorkflow, evaluateFeed,
  isWildfireSourceCurrent, reportStatus, runScheduledCheck, workflowAvailability
} from './worker.mjs';

const weather = WORKFLOWS.find(item => item.key === 'weather');
const levels = WORKFLOWS.find(item => item.key === 'levels');
const radar = WORKFLOWS.find(item => item.key === 'radar');
const grassland = WORKFLOWS.find(item => item.key === 'grassland');
const wildfire = WORKFLOWS.find(item => item.key === 'wildfire');

function scheduledRun(file, startedAt, extra = {}) {
  return { path: '.github/workflows/' + file, event: 'schedule', created_at: startedAt, run_started_at: startedAt, status: 'completed', conclusion: 'success', ...extra };
}

function freshWeather(now) {
  const measured = new Date(now - 10 * 60000).toISOString();
  return {
    status: 'ok',
    lastAttemptAt: new Date(now).toISOString(),
    observations: Object.fromEntries(['temperatureHumidity', 'wind', 'windGust', 'precipitation', 'stationPressure'].map(key => [
      key, { status: 'ok', measuredAt: measured, retrievedAt: new Date(now).toISOString() }
    ])),
    forecast: { status: 'ok', issuedAt: new Date(now - 60 * 60000).toISOString(), retrievedAt: new Date(now).toISOString() }
  };
}

class MemoryDb {
  constructor() { this.guard = new Map(); this.control = new Map(); this.status = new Map(); this.events = []; }
  prepare(sql) {
    const db = this;
    return {
      params: [],
      bind(...params) { this.params = params; return this; },
      async first() {
        if (sql.includes('SELECT until_ms')) return db.control.has('github-backoff') ? { until_ms: db.control.get('github-backoff').until } : null;
        if (sql.includes('SELECT last_dispatch_at_ms')) return db.guard.get(this.params[0]) || null;
        return null;
      },
      async all() {
        if (sql.includes('INSERT INTO dispatch_guard')) {
          const [key, lease, last, day, now, oldestAllowed, today, cap] = this.params;
          const old = db.guard.get(key);
          const ok = !old || (Number(old.lease_until_ms) <= now && (old.last_dispatch_at_ms == null || Number(old.last_dispatch_at_ms) <= oldestAllowed) && (old.dispatch_day_utc !== today || Number(old.dispatch_count) < cap));
          if (!ok) return { results: [] };
          const count = !old || old.dispatch_day_utc !== day ? 1 : Number(old.dispatch_count) + 1;
          db.guard.set(key, { workflow_key: key, lease_until_ms: lease, last_dispatch_at_ms: last, dispatch_day_utc: day, dispatch_count: count });
          return { results: [{ workflow_key: key }] };
        }
        return { results: [] };
      },
      async run() {
        if (sql.includes('INSERT INTO watchdog_control')) db.control.set('github-backoff', { until: this.params[0], reason: this.params[1] });
        if (sql.includes('INSERT INTO watchdog_status')) db.status.set(this.params[0], JSON.parse(this.params[4]));
        if (sql.includes('INSERT INTO watchdog_events')) db.events.push({ type: this.params[2], detail: JSON.parse(this.params[3]) });
        if (sql.includes('DELETE FROM watchdog_status')) for (const [key, value] of db.status) if (value.checkedAtMs < this.params[0]) db.status.delete(key);
        return { success: true };
      }
    };
  }
  async batch(statements) { for (const statement of statements) await statement.run(); return []; }
}

test('DWD-Messzeit, MOSMIX-Zeit und Abrufzeit werden getrennt bewertet', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  const payload = freshWeather(now);
  assert.equal(evaluateFeed(weather.feeds[0], payload, now).dataStatus, 'current');
  payload.observations.wind.measuredAt = new Date(now - 46 * 60000).toISOString();
  const report = evaluateFeed(weather.feeds[0], payload, now);
  assert.equal(report.dataStatus, 'stale');
  assert.equal(report.sourceTimestamp, new Date(now - 46 * 60000).toISOString());
  assert.equal(report.publishedAt, null);
  assert.equal(report.retrievedAt, new Date(now).toISOString());
});

test('beide Pegel benutzen measuredAtUtc, nicht retrievedAt', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  const spec = levels.feeds[0];
  const base = { status: 'ok', retrievedAt: new Date(now).toISOString(), latestMeasurement: { measuredAtUtc: new Date(now - 46 * 60000).toISOString() } };
  assert.equal(evaluateFeed(spec, base, now).dataStatus, 'stale');
  base.latestMeasurement.measuredAtUtc = new Date(now - 30 * 60000).toISOString();
  assert.equal(evaluateFeed(spec, base, now).dataStatus, 'current');
});

test('RADOLAN und KONRAD3D nutzen getrennte Produktzeiten und die 15-Minuten-Grenze', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  assert.equal(evaluateFeed(radar.feeds[0], { status: 'current', productTime: new Date(now - 16 * 60000).toISOString(), retrievedAt: new Date(now).toISOString() }, now).dataStatus, 'stale');
  assert.equal(evaluateFeed(radar.feeds[1], { status: 'current', referenceTime: new Date(now - 14 * 60000).toISOString(), publishedAt: new Date(now).toISOString() }, now).dataStatus, 'current');
});

test('GLFI braucht den Berliner Tageswert und eine echte Quelldatenzeit innerhalb 36h', () => {
  const now = Date.parse('2026-10-31T06:00:00Z');
  const payload = { status: 'ok', retrievedAt: new Date(now).toISOString(), source: { dataAsOf: new Date(now - 35 * 3600000).toISOString() }, days: [{ date: '2026-10-31', index: 1 }] };
  assert.equal(evaluateFeed(grassland.feeds[0], payload, now).dataStatus, 'current');
  payload.source.dataAsOf = new Date(now - 37 * 3600000).toISOString();
  assert.equal(evaluateFeed(grassland.feeds[0], payload, now).dataStatus, 'stale');
});

test('Waldbrand-Tagesgültigkeit wird an Sommer- und Winterzeitwechsel korrekt ausgewertet', () => {
  assert.equal(isWildfireSourceCurrent('2026-03-28', Date.parse('2026-03-29T05:59:00Z')), true);
  assert.equal(isWildfireSourceCurrent('2026-03-28', Date.parse('2026-03-29T06:00:00Z')), false);
  assert.equal(isWildfireSourceCurrent('2026-03-29', Date.parse('2026-03-29T06:00:00Z')), true);
  assert.equal(isWildfireSourceCurrent('2026-10-24', Date.parse('2026-10-25T06:59:00Z')), true);
  assert.equal(isWildfireSourceCurrent('2026-10-24', Date.parse('2026-10-25T07:00:00Z')), false);
  assert.equal(isWildfireSourceCurrent('2026-10-25', Date.parse('2026-10-25T07:00:00Z')), true);
  assert.equal(isWildfireSourceCurrent('2026-02-31', Date.parse('2026-10-25T07:00:00Z')), false);
  const spec = wildfire.feeds[0];
  assert.equal(evaluateFeed(spec, { sourceDate: '2026-03-29', level: 2, fetchStatus: 'success' }, Date.parse('2026-03-29T06:30:00Z')).ageMinutes, 30);
  assert.equal(evaluateFeed(spec, { sourceDate: '2026-10-25', level: 2, fetchStatus: 'success' }, Date.parse('2026-10-25T07:30:00Z')).ageMinutes, 30);
});

test('Waldbrandstatus ignoriert das gespeicherte Statusfeld und verwendet sourceDate', () => {
  const now = Date.parse('2026-10-31T07:30:00Z');
  const current = evaluateFeed(wildfire.feeds[0], { sourceDate: '2026-10-31', level: 1, status: 'stale', fetchStatus: 'success', retrievedAt: new Date(now).toISOString() }, now);
  assert.equal(current.dataStatus, 'current');
  assert.equal(current.ageMinutes, 30);
  const expired = evaluateFeed(wildfire.feeds[0], { sourceDate: '2026-10-30', level: 1, status: 'current', fetchStatus: 'success' }, now);
  assert.equal(expired.dataStatus, 'stale');
});

test('pünktlicher Zeitplan wird erkannt; Startabstand und Verspätung bleiben sichtbar', () => {
  const now = Date.parse('2026-10-31T05:18:40Z');
  const ok = automationState([scheduledRun(weather.file, '2026-10-31T05:18:20Z')], weather, now);
  assert.equal(ok.state, 'healthy');
  assert.equal(ok.overdue, false);
  const delayed = automationState([
    scheduledRun(weather.file, '2026-10-31T05:24:00Z'),
    scheduledRun(weather.file, '2026-10-31T00:18:00Z')
  ], weather, Date.parse('2026-10-31T05:24:20Z'));
  assert.equal(delayed.state, 'late');
  assert.equal(delayed.scheduleGapMinutes, 306);
  assert.equal(reportStatus({ dataStatus: 'current' }, delayed), 'Automatik ausgefallen');
});

test('mehrstündige oder fehlende tägliche Ausführung wird nach Slot plus Grace überfällig', () => {
  const now = Date.parse('2026-10-31T08:21:00Z');
  const auto = { ...automationState([scheduledRun(wildfire.file, '2026-10-30T07:20:00Z')], wildfire, now), workflowActive: true, repositoryDefaultBranch: 'main' };
  assert.equal(auto.overdue, true);
  assert.equal(auto.state, 'overdue');
  assert.equal(reportStatus({ dataStatus: 'current' }, auto), 'Automatik ausgefallen');
});

test('wartender Lauf verhindert einen doppelten Anstoß', () => {
  const now = Date.parse('2026-10-31T08:30:00Z');
  const pending = automationState([
    scheduledRun(wildfire.file, '2026-10-30T07:20:00Z'),
    { path: '.github/workflows/' + wildfire.file, event: 'schedule', created_at: '2026-10-31T08:25:00Z', run_started_at: null, status: 'queued', conclusion: null }
  ], wildfire, now);
  assert.equal(pending.pending, true);
  assert.equal(decisionForWorkflow(wildfire, [], pending, now, 'dispatch').shouldDispatch, false);
});

test('Dispatch wird nur im freigegebenen Modus für einen echten stale Feed erwogen', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  const healthy = { ...automationState([scheduledRun(weather.file, '2026-10-31T06:48:10Z')], weather, now), workflowActive: true, repositoryDefaultBranch: 'main' };
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'current', fetchError: false }], healthy, now, 'dispatch').shouldDispatch, false);
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'stale', fetchError: false }], healthy, now, 'observe').shouldDispatch, false);
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'stale', fetchError: false }], healthy, now, 'dispatch').shouldDispatch, true);
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'error', fetchError: true }], healthy, now, 'dispatch').shouldDispatch, false);
  assert.equal(decisionForWorkflow(levels, [{ dataStatus: 'stale', fetchError: false }, { dataStatus: 'unavailable', fetchError: false }], { ...healthy, pending: false }, now, 'dispatch').shouldDispatch, false);
});

test('D1 atomarer Guard verhindert parallele Dispatch-Ansprüche und begrenzt Tagesstarts', async () => {
  const db = new MemoryDb();
  const workflow = { key: 'test', minDispatchMinutes: 60, maxDispatchesPerDay: 1 };
  const now = Date.parse('2026-10-31T07:00:00Z');
  const claimed = await Promise.all([claimDispatch(db, workflow, now), claimDispatch(db, workflow, now)]);
  assert.equal(claimed.filter(Boolean).length, 1);
  assert.equal(await claimDispatch(db, workflow, now + 61 * 60000), false);
  assert.equal(await claimDispatch(db, workflow, Date.parse('2026-11-01T00:01:00Z')), true);
});

test('GitHub API 429 setzt Backoff und beendet den Lauf ohne Workflow-Dispatch', async () => {
  const db = new MemoryDb();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 'test-token' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/repos/RonnsenDD/lhh-data-hub')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/repos/RonnsenDD/lhh-data-hub')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/actions/workflows?per_page')) return new Response(JSON.stringify({ workflows: [{ id: 7, path: '.github/workflows/' + weather.file, state: 'active' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/actions/workflows/7/runs')) return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429, headers: { 'retry-after': '120' } });
    throw new Error('unexpected request');
  };
  await runScheduledCheck(null, {
    DB: db, GH_APP_ID: 'test', GH_INSTALLATION_ID: 'install', GH_APP_PRIVATE_KEY: privateKey,
    WATCHDOG_MODE: 'dispatch', DISPATCH_ENABLED: 'true'
  }, {}, { nowMs: Date.parse('2026-10-31T07:00:00Z'), workflows: [weather], fetcher });
  assert.equal(calls.some(call => call.url.includes('/dispatches')), false);
  assert.ok(db.control.get('github-backoff').until > Date.parse('2026-10-31T07:00:00Z'));
  assert.equal(db.status.get('weather').status, 'Automatik ausgefallen');
});

test('D1-Ausfall blockiert den Lauf geschlossen', async () => {
  let called = false;
  const db = { prepare() { throw new Error('db offline'); } };
  await runScheduledCheck(null, { DB: db }, {}, { nowMs: Date.now(), workflows: [weather], fetcher: async () => { called = true; } });
  assert.equal(called, false);
});

test('fehlgeschlagener Produzentenlauf bleibt ein Fehler und ist auslöserfähig', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  const failed = { ...automationState([
    scheduledRun(weather.file, '2026-10-31T06:48:00Z', { conclusion: 'failure' })
  ], weather, now), workflowActive: true, repositoryDefaultBranch: 'main' };
  assert.equal(failed.state, 'producer_failed');
  assert.equal(reportStatus({ dataStatus: 'current' }, failed), 'Automatik ausgefallen');
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'current', fetchError: false }], failed, now, 'dispatch').shouldDispatch, true);
});

test('DWD unvollständige oder statuslose Quelle wird nicht als aktuell ausgegeben', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  const payload = freshWeather(now);
  payload.forecast.status = 'unknown';
  assert.notEqual(evaluateFeed(weather.feeds[0], payload, now).dataStatus, 'current');
  delete payload.observations.wind.measuredAt;
  assert.notEqual(evaluateFeed(weather.feeds[0], payload, now).dataStatus, 'current');
});

test('Worker besitzt keinen öffentlichen fetch-Handler', async () => {
  const worker = (await import('./worker.mjs')).default;
  assert.equal(worker.fetch, undefined);
  assert.equal(typeof worker.scheduled, 'function');
});

test('GitHub-App-JWT akzeptiert PKCS#1 Private Key und signiert RS256', async () => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const jwt = await createAppJwt('12345', pair.privateKey, Date.parse('2026-10-31T07:00:00Z'));
  const pieces = jwt.split('.');
  assert.equal(pieces.length, 3);
  const header = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.iss, '12345');
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(verifySignature('RSA-SHA256', Buffer.from(pieces[0] + '.' + pieces[1]), createPublicKey(pair.publicKey), Buffer.from(pieces[2], 'base64url')), true);
});

test('GitHub API 5xx wird mit Backoff geschlossen behandelt', async () => {
  const db = new MemoryDb();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 'test-token' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/actions/workflows?per_page')) return new Response(JSON.stringify({ workflows: [{ id: 7, path: '.github/workflows/' + weather.file, state: 'active' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/actions/workflows/7/runs')) return new Response('{}', { status: 503 });
    throw new Error('unexpected request');
  };
  const now = Date.parse('2026-10-31T07:00:00Z');
  await runScheduledCheck(null, { DB: db, GH_APP_ID: 'test', GH_INSTALLATION_ID: 'install', GH_APP_PRIVATE_KEY: privateKey }, {}, { nowMs: now, workflows: [weather], fetcher });
  assert.equal(calls.some(url => url.includes('/dispatches')), false);
  assert.ok(db.control.get('github-backoff').until >= now + 5 * 60000);
});

test('fehlender oder deaktivierter Workflow wird erkannt, aber nicht automatisch aktiviert oder ausgelöst', () => {
  const missing = workflowAvailability([], weather);
  const disabled = workflowAvailability([{ path: '.github/workflows/' + weather.file, state: 'disabled_inactivity' }], weather);
  const active = workflowAvailability([{ path: '.github/workflows/' + weather.file, state: 'active' }], weather);
  assert.equal(missing.active, false);
  assert.equal(disabled.active, false);
  assert.equal(active.active, true);
  assert.equal(active.workflowActive, true);
  const late = { pending: false, overdue: true, state: 'overdue', workflowActive: false, repositoryDefaultBranch: 'main' };
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'stale' }], late, Date.now(), 'dispatch').shouldDispatch, false);
});

test('geänderter Default-Branch sperrt den Dispatch', () => {
  const now = Date.parse('2026-10-31T07:00:00Z');
  const state = { pending: false, overdue: true, state: 'overdue', workflowActive: true, repositoryDefaultBranch: 'develop' };
  assert.equal(decisionForWorkflow(weather, [{ dataStatus: 'stale', fetchError: false }], state, now, 'dispatch').shouldDispatch, false);
});

test('freigegebener Dispatch nutzt main und der persistente Cooldown verhindert den nächsten Start', async () => {
  const db = new MemoryDb();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const dispatches = [];
  const now = Date.parse('2026-10-31T05:19:00Z');
  const fetcher = async (url, init = {}) => {
    if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 'short-lived' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/repos/RonnsenDD/lhh-data-hub')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/actions/workflows?per_page')) return new Response(JSON.stringify({ workflows: [{ id: 7, path: '.github/workflows/' + weather.file, state: 'active' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/actions/workflows/7/runs')) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/dispatches')) {
      dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url === weather.feeds[0].url) {
      const measured = new Date(now - 50 * 60000).toISOString();
      return new Response(JSON.stringify({
        status: 'ok', lastAttemptAt: new Date(now).toISOString(),
        observations: Object.fromEntries(['temperatureHumidity', 'wind', 'windGust', 'precipitation', 'stationPressure'].map(key => [
          key, { status: 'ok', measuredAt: measured, retrievedAt: new Date(now).toISOString() }
        ])),
        forecast: { status: 'ok', issuedAt: new Date(now - 60 * 60000).toISOString() }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected request');
  };
  const env = {
    DB: db, GH_APP_ID: 'test', GH_INSTALLATION_ID: 'install', GH_APP_PRIVATE_KEY: privateKey,
    WATCHDOG_MODE: 'dispatch', DISPATCH_ENABLED: 'true'
  };
  await runScheduledCheck(null, env, {}, { nowMs: now, workflows: [weather], fetcher });
  await runScheduledCheck(null, env, {}, { nowMs: now + 5 * 60000, workflows: [weather], fetcher });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0], { ref: 'main' });
  assert.ok(db.status.get('weather').nextAllowedDispatchAt);
});
