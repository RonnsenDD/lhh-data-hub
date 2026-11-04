import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import worker, { appToken, assessWeather, decide, evaluateWeatherDispatcher, isEligibleCron, privateKeyPkcs8 } from '../src/worker.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const fresh = {
  schemaVersion: 1, source: 'DWD weather snapshot v2', sourceStatus: 'ok',
  lastAttemptAt: '2026-11-04T11:50:00Z', lastSuccessfulAt: null, snapshotPublishedAt: null,
  derivedAt: '2026-11-04T11:59:59Z',
  observations: {
    temperatureHumidity: { status: 'ok', measuredAt: '2026-11-04T11:45:00Z', retrievedAt: '2026-11-04T11:50:00Z', freshnessThresholdMinutes: 60 },
    wind: { status: 'ok', measuredAt: '2026-11-04T11:40:00Z', retrievedAt: '2026-11-04T11:50:00Z', freshnessThresholdMinutes: 60 },
  },
  forecast: { status: 'ok', issuedAt: '2026-11-04T06:00:00Z', retrievedAt: '2026-11-04T11:50:00Z', validThrough: '2026-11-14T00:00:00Z', hasUsablePoint: true },
};
const stale = {
  ...fresh, lastAttemptAt: '2026-11-04T10:00:00Z',
  observations: { temperatureHumidity: { status: 'stale', measuredAt: '2026-11-04T10:00:00Z', freshnessThresholdMinutes: 60 } },
  forecast: { status: 'stale', issuedAt: '2026-11-03T23:00:00Z', validThrough: '2026-11-04T10:00:00Z', hasUsablePoint: false },
};
const appPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const appEnv = (mode = 'observe') => ({ WEATHER_DISPATCH_MODE: mode, WEATHER_DISPATCH_ENABLED: 'false', GITHUB_APP_ID: '5555433', GITHUB_INSTALLATION_ID: '177220128', GITHUB_APP_PRIVATE_KEY: appPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });

function mockFetch({ snapshot = fresh, runs = [], sidecarStatus = 200, runStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('/access_tokens')) return new Response(JSON.stringify({ token: 'mock-installation-token' }), { status: 201 });
    if (String(url).includes('raw.githubusercontent.com')) return new Response(sidecarStatus === 200 ? JSON.stringify(snapshot) : 'unavailable', { status: sidecarStatus });
    if (String(url).includes('/actions/workflows/')) return new Response(runStatus === 200 ? JSON.stringify({ workflow_runs: runs }) : 'failed', { status: runStatus });
    throw new Error(`unexpected URL ${url}`);
  };
  return { requests, fetchImpl };
}

test('1 disabled is the default and makes no network requests', async () => {
  let calls = 0;
  const result = await evaluateWeatherDispatcher({}, async () => { calls++; throw new Error('unexpected'); }, now);
  assert.equal(result.reason, 'disabled'); assert.equal(calls, 0);
});
test('2 disabled explicit mode also makes no requests', async () => {
  const result = await evaluateWeatherDispatcher({ WEATHER_DISPATCH_MODE: 'disabled' }, async () => assert.fail(), now);
  assert.equal(result.dispatch, false); assert.equal(result.reason, 'disabled');
});
test('3 observe reads public sidecar and workflow history but never writes dispatch', async () => {
  const { requests, fetchImpl } = mockFetch();
  const result = await evaluateWeatherDispatcher(appEnv('observe'), fetchImpl, now);
  assert.equal(result.reason, 'data-fresh'); assert.equal(result.dispatch, false);
  assert.ok(requests.some((x) => x.url.includes('raw.githubusercontent.com')));
  assert.ok(requests.some((x) => x.url.includes('/actions/workflows/update-dwd-weather.yml/runs')));
  assert.equal(requests.some((x) => x.url.endsWith('/dispatches')), false);
  const tokenRequest = requests.find((x) => x.url.includes('/access_tokens'));
  assert.deepEqual(JSON.parse(tokenRequest.init.body), { repositories: ['lhh-data-hub'], permissions: { actions: 'read' } });
});
test('4 fresh measured data prevents a hypothetical dispatch', () => {
  const result = decide({ mode: 'observe', assessment: assessWeather(fresh, now), runs: [], now });
  assert.equal(result.reason, 'data-fresh'); assert.equal(result.wouldDispatch, undefined);
});
test('5 old measured values remain stale even when derivedAt and retrieval are recent', () => {
  const old = { ...fresh, lastAttemptAt: '2026-11-04T10:00:00Z', derivedAt: new Date(now).toISOString(), observations: { t: { status: 'ok', measuredAt: '2026-11-04T10:00:00Z', retrievedAt: new Date(now).toISOString(), freshnessThresholdMinutes: 60 } } };
  assert.equal(assessWeather(old, now).stale, true);
  assert.equal(assessWeather(old, now).derivedAtUsedForFreshness, false);
});
test('6 stale source and old attempt produce observe-only would-dispatch decision', () => {
  const result = decide({ mode: 'observe', assessment: assessWeather(stale, now), runs: [], now });
  assert.equal(result.reason, 'would-dispatch'); assert.equal(result.wouldDispatch, true); assert.equal(result.dispatch, false);
});
test('7 missing measurement time fails closed', () => {
  const bad = structuredClone(fresh); delete bad.observations.wind.measuredAt;
  assert.equal(assessWeather(bad, now).valid, false);
});
test('8 malformed measurement time fails closed', () => {
  const bad = structuredClone(fresh); bad.observations.wind.measuredAt = 'yesterday';
  assert.equal(assessWeather(bad, now).reason, 'observation-time-invalid');
});
test('9 future measurement timestamps fail closed', () => {
  const bad = structuredClone(fresh); bad.observations.wind.measuredAt = '2026-11-04T13:00:00Z';
  assert.equal(assessWeather(bad, now).reason, 'observation-time-in-future-or-invalid');
});
test('10 stale generatedAt cannot make missing or old original data fresh', () => {
  const bad = structuredClone(fresh); bad.derivedAt = '2026-11-04T11:59:59Z'; bad.forecast.issuedAt = '2026-11-03T00:00:00Z';
  assert.equal(assessWeather(bad, now).stale, true);
});
test('11 declared freshness cannot silently exceed the existing 60-minute threshold', () => {
  const bad = structuredClone(fresh); bad.observations.wind.freshnessThresholdMinutes = 90;
  assert.equal(assessWeather(bad, now).reason, 'observation-threshold-invalid');
});
test('12 forecast horizon and usability are checked separately from issue time', () => {
  const bad = structuredClone(fresh); bad.forecast.hasUsablePoint = false;
  assert.equal(assessWeather(bad, now).stale, true);
});
test('13 declared MOSMIX threshold cannot exceed 12 hours', () => {
  const bad = structuredClone(fresh); bad.forecast.freshnessThresholdMinutes = 800;
  assert.equal(assessWeather(bad, now).reason, 'forecast-threshold-invalid');
});
test('14 active queued or in-progress workflow prevents observation dispatch', () => {
  for (const status of ['queued', 'in_progress']) {
    const result = decide({ mode: 'observe', assessment: assessWeather(stale, now), runs: [{ status, created_at: '2026-11-04T11:55:00Z' }], now });
    assert.equal(result.reason, 'workflow-active');
  }
});
test('15 recent workflow run prevents duplicate start', () => {
  const result = decide({ mode: 'observe', assessment: assessWeather(stale, now), runs: [{ status: 'completed', event: 'schedule', created_at: '2026-11-04T11:45:00Z' }], now });
  assert.equal(result.reason, 'workflow-start-cooldown'); assert.equal(result.workflowEvent, 'schedule');
});
test('16 malformed or missing GitHub run history fails closed', () => {
  const assessment = assessWeather(stale, now);
  assert.equal(decide({ mode: 'observe', assessment, runs: null, now }).dispatch, false);
  assert.equal(decide({ mode: 'observe', assessment, runs: [{ status: 'queued' }], now }).reason, 'workflow-history-invalid');
});
test('17 GitHub API failures fail closed without dispatch', async () => {
  const { requests, fetchImpl } = mockFetch({ runStatus: 403 });
  const result = await evaluateWeatherDispatcher(appEnv('observe'), fetchImpl, now);
  assert.equal(result.reason, 'github-workflow-history-unavailable'); assert.equal(result.dispatch, false);
  assert.equal(requests.some((x) => x.url.endsWith('/dispatches')), false);
});
test('18 unavailable public sidecar fails closed', async () => {
  const { fetchImpl } = mockFetch({ sidecarStatus: 503 });
  const result = await evaluateWeatherDispatcher(appEnv('observe'), fetchImpl, now);
  assert.equal(result.reason, 'public-sidecar-unavailable'); assert.equal(result.dispatch, false);
});
test('19 invalid JSON and invalid source identity fail closed', async () => {
  const { fetchImpl } = mockFetch({ snapshot: { source: 'other' } });
  const result = await evaluateWeatherDispatcher(appEnv('observe'), fetchImpl, now);
  assert.equal(result.reason, 'source-or-attempt-time-invalid'); assert.equal(result.dispatch, false);
});
test('20 missing GitHub App secret is reported without exposing a value', async () => {
  const { fetchImpl } = mockFetch();
  const result = await evaluateWeatherDispatcher({ WEATHER_DISPATCH_MODE: 'observe', GITHUB_APP_ID: '5555433', GITHUB_INSTALLATION_ID: '177220128' }, fetchImpl, now);
  assert.equal(result.reason, 'github-app-config-missing'); assert.equal(result.dispatch, false);
});
test('21 dispatch mode is fail-closed without explicit gate and cross-invocation lock', async () => {
  const { requests, fetchImpl } = mockFetch({ snapshot: stale });
  const env = appEnv('dispatch'); env.WEATHER_DISPATCH_ENABLED = 'true';
  const result = await evaluateWeatherDispatcher(env, fetchImpl, now);
  assert.equal(result.reason, 'atomic-dispatch-lock-not-configured'); assert.equal(result.dispatch, false);
  assert.equal(requests.some((x) => x.url.endsWith('/dispatches')), false);
  const tokenBody = JSON.parse(requests.find((x) => x.url.includes('/access_tokens')).init.body);
  assert.deepEqual(tokenBody.permissions, { actions: 'read' });
});
test('22 malformed mode does not access network', async () => {
  let count = 0;
  const result = await evaluateWeatherDispatcher({ WEATHER_DISPATCH_MODE: 'enabled' }, async () => { count++; }, now);
  assert.equal(result.reason, 'mode-invalid'); assert.equal(count, 0);
});
test('23 GitHub JWT is RS256 signed and installation token is repository-scoped read-only', async () => {
  const pem = appPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  let captured;
  const token = await appToken({ GITHUB_APP_ID: '5555433', GITHUB_INSTALLATION_ID: '177220128', GITHUB_APP_PRIVATE_KEY: pem }, async (url, init) => {
    captured = { url, init }; return new Response(JSON.stringify({ token: 'mock-token' }), { status: 201 });
  }, 'read', 1793793600);
  assert.equal(token, 'mock-token');
  assert.equal(new URL(captured.url).pathname, '/app/installations/177220128/access_tokens');
  assert.deepEqual(JSON.parse(captured.init.body), { repositories: ['lhh-data-hub'], permissions: { actions: 'read' } });
  const jwt = captured.init.headers.authorization.slice(7).split('.');
  const verify = createVerify('RSA-SHA256'); verify.update(`${jwt[0]}.${jwt[1]}`); verify.end();
  assert.equal(verify.verify(appPair.publicKey, Buffer.from(jwt[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')), true);
  assert.ok(privateKeyPkcs8(pem).byteLength > 0);
});
test('24 Cron decision is restricted to four quarter-hour offsets and no public fetch handler exists', () => {
  for (const minute of [8, 23, 38, 53]) assert.equal(isEligibleCron({ scheduledTime: Date.parse(`2026-11-04T12:${String(minute).padStart(2, '0')}:00Z`) }), true);
  for (const minute of [3, 18, 33, 48, 9]) assert.equal(isEligibleCron({ scheduledTime: Date.parse(`2026-11-04T12:${String(minute).padStart(2, '0')}:00Z`) }), false);
  assert.equal(typeof worker.fetch, 'undefined');
});
test('25 observe decision includes UTC time and original-source age, not retrieval age', () => {
  const result = decide({ mode: 'observe', assessment: assessWeather(fresh, now), runs: [{ status: 'completed', event: 'schedule', created_at: '2026-11-04T11:00:00Z' }], now });
  assert.equal(result.decisionTime, '2026-11-04T12:00:00.000Z');
  assert.equal(result.weatherAgeMinutes, 20); assert.equal(result.workflowEvent, 'schedule');
});
test('26 dispatch mode with closed gate requests read-only token and cannot dispatch', async () => {
  const { requests, fetchImpl } = mockFetch({ snapshot: stale });
  const env = appEnv('dispatch');
  const result = await evaluateWeatherDispatcher(env, fetchImpl, now);
  assert.equal(result.reason, 'dispatch-gate-disabled'); assert.equal(result.dispatch, false);
  assert.deepEqual(JSON.parse(requests.find((x) => x.url.includes('/access_tokens')).init.body).permissions, { actions: 'read' });
  assert.equal(requests.some((x) => x.url.endsWith('/dispatches')), false);
});
test('27 invalid sidecar JSON fails closed', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('raw.githubusercontent.com')) return new Response('{not-json', { status: 200 });
    throw new Error('GitHub must not be queried after unusable source document');
  };
  const result = await evaluateWeatherDispatcher(appEnv('observe'), fetchImpl, now);
  assert.equal(result.reason, 'public-sidecar-invalid'); assert.equal(result.errorStatus, 'sidecar-json-invalid');
});
test('28 scheduled logs contain no app key or installation token values', async () => {
  const savedFetch = globalThis.fetch;
  const savedLog = console.log;
  const savedError = console.error;
  const captured = [];
  const env = appEnv('observe');
  const privateValue = env.GITHUB_APP_PRIVATE_KEY;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/access_tokens')) return new Response(JSON.stringify({ token: 'secret-installation-token' }), { status: 201 });
    if (String(url).includes('raw.githubusercontent.com')) return new Response(JSON.stringify(fresh), { status: 200 });
    if (String(url).includes('/actions/workflows/')) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    throw new Error('unexpected request');
  };
  console.log = (...args) => captured.push(args.join(' '));
  console.error = (...args) => captured.push(args.join(' '));
  try { await worker.scheduled({ scheduledTime: Date.parse('2026-11-04T12:08:00Z') }, env); }
  finally { globalThis.fetch = savedFetch; console.log = savedLog; console.error = savedError; }
  const logs = captured.join('\n');
  assert.ok(logs.includes('data-fresh'));
  assert.equal(logs.includes(privateValue), false);
  assert.equal(logs.includes('secret-installation-token'), false);
});

