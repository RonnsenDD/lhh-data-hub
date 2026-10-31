const OWNER = 'RonnsenDD';
const REPO = 'lhh-data-hub';
const API = 'https://api.github.com';
const OBSERVE = 'observe';
const DISPATCH = 'dispatch';

export const WORKFLOWS = [
  {
    key: 'weather', file: 'update-dwd-weather.yml', expectedUtcMinutes: [3, 18, 33, 48],
    graceMinutes: 30, minDispatchMinutes: 60, maxDispatchesPerDay: 3,
    feeds: [{
      key: 'weather', url: 'https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather.json',
      kind: 'weather', maxAgeMinutes: 45, forecastMaxAgeHours: 12
    }]
  },
  {
    key: 'levels', file: 'update-levels.yml', expectedUtcMinutes: [11, 26, 41, 56],
    graceMinutes: 30, minDispatchMinutes: 60, maxDispatchesPerDay: 3,
    feeds: [
      { key: 'level-lauchhammer', url: 'https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-lauchhammer.json', kind: 'level', maxAgeMinutes: 45 },
      { key: 'level-biehlen-1', url: 'https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-biehlen-1.json', kind: 'level', maxAgeMinutes: 45 }
    ]
  },
  {
    key: 'radar', file: 'update-radolan-ry.yml', expectedUtcMinutes: [7, 22, 37, 52],
    graceMinutes: 30, minDispatchMinutes: 60, maxDispatchesPerDay: 3,
    feeds: [
      { key: 'radolan-ry', url: 'https://ronnsendd.github.io/lhh-data-hub/radar/latest.json', kind: 'radar', maxAgeMinutes: 15 },
      { key: 'konrad3d', url: 'https://ronnsendd.github.io/lhh-data-hub/konrad3d/latest.json', kind: 'konrad', maxAgeMinutes: 15 }
    ]
  },
  {
    key: 'grassland', file: 'update-graslandfeuerindex.yml', expectedUtcDaily: '05:15',
    graceMinutes: 120, minDispatchMinutes: 360, maxDispatchesPerDay: 1,
    feeds: [{
      key: 'grassland', url: 'https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/graslandfeuerindex.json',
      kind: 'grassland', maxAgeHours: 36
    }]
  },
  {
    key: 'wildfire', file: 'update-waldbrandgefahrenstufe-osl.yml', expectedUtcDaily: '07:20',
    graceMinutes: 60, minDispatchMinutes: 360, maxDispatchesPerDay: 1,
    feeds: [{
      key: 'wildfire-osl', url: 'https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/waldbrandgefahrenstufe-osl.json',
      kind: 'wildfire', validityTimeZone: 'Europe/Berlin', validityStartHour: 8
    }]
  }
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoAgeMinutes(timestamp, nowMs) {
  if (typeof timestamp !== 'string') return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return (nowMs - parsed) / 60000;
}

function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addIsoDay(date, days) {
  const parts = String(date).split('-').map(Number);
  if (parts.length !== 3 || parts.some(v => !Number.isInteger(v))) return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days)).toISOString().slice(0, 10);
}

function berlinParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const value = {};
  for (const part of parts) if (part.type !== 'literal') value[part.type] = part.value;
  return {
    date: value.year + '-' + value.month + '-' + value.day,
    hour: Number(value.hour), minute: Number(value.minute),
    minutes: Number(value.hour) * 60 + Number(value.minute)
  };
}

function validIsoDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date;
}

function berlinWallTimeToUtc(date, hour, minute = 0) {
  if (!validIsoDay(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const zoned = berlinParts(wallClockAsUtc);
  const observedWallClockAsUtc = Date.UTC(year, month - 1, day, zoned.hour, zoned.minute);
  return wallClockAsUtc - (observedWallClockAsUtc - wallClockAsUtc);
}

export function isWildfireSourceCurrent(sourceDate, nowMs, startHour = 8) {
  if (!validIsoDay(sourceDate)) return false;
  const local = berlinParts(nowMs);
  const nextDate = addIsoDay(sourceDate, 1);
  const startMinute = startHour * 60;
  return (local.date === sourceDate && local.minutes >= startMinute) ||
    (local.date === nextDate && local.minutes < startMinute);
}

function result(status, fields = {}) {
  return { dataStatus: status, ...fields };
}

export function evaluateFeed(spec, payload, nowMs) {
  if (!record(payload)) return result('unavailable', { reason: 'JSON-Wurzel fehlt oder ist ungültig.' });
  const publishedAt = payload.publishedAt || null;
  const retrievedAt = payload.retrievedAt || null;
  const lastSuccessfulAt = payload.lastSuccessfulAt || null;
  const lastAttemptAt = payload.lastAttemptAt || null;
  if (spec.kind === 'weather') {
    const observations = record(payload.observations) ? payload.observations : {};
    const required = ['temperatureHumidity', 'wind', 'windGust', 'precipitation', 'stationPressure'];
    const used = required.map(key => observations[key]).filter(record);
    if (!used.length) return result('unavailable', { reason: 'Erforderliche DWD-Messprodukte fehlen.', publishedAt });
    if (payload.status === 'error' || used.some(item => item.status === 'error')) {
      return result('error', { reason: 'DWD-Messabruf meldet einen Fehler.', publishedAt });
    }
    if (used.some(item => !['ok', 'partial'].includes(item.status))) return result('unavailable', { reason: 'Unbekannter DWD-Messproduktstatus.', publishedAt, retrievedAt, lastSuccessfulAt, lastAttemptAt });
    const ages = used.map(item => isoAgeMinutes(item.measuredAt, nowMs));
    if (ages.some(age => age === null || age < -5)) return result('unavailable', { reason: 'DWD-Messzeit fehlt oder liegt unplausibel in der Zukunft.', publishedAt });
    const oldestAge = Math.max(...ages);
    const feedSaysStale = payload.status === 'stale' || used.some(item => item.status === 'stale');
    const forecast = payload.forecast;
    const forecastAge = record(forecast) ? isoAgeMinutes(forecast.issuedAt, nowMs) : null;
    const forecastStale = !record(forecast) || !['ok', 'partial'].includes(forecast.status) || forecastAge === null || forecastAge < -5 ||
      forecastAge > (spec.forecastMaxAgeHours || 12) * 60 || ['stale', 'error', 'unavailable'].includes(forecast.status);
    const isStale = feedSaysStale || oldestAge > spec.maxAgeMinutes || forecastStale;
    const times = used.map(item => item.measuredAt).filter(value => typeof value === 'string').sort();
    return result(isStale ? 'stale' : 'current', {
      retrievedAt: used.map(item => item.retrievedAt).filter(Boolean).sort().slice(-1)[0] || retrievedAt,
      publishedAt, lastSuccessfulAt, lastAttemptAt,
      reason: isStale ? 'Mess- oder Vorhersagezeit überschreitet die Dashboard-Frischegrenze.' : 'DWD-Messwerte und MOSMIX-Zeit liegen innerhalb ihrer Frischegrenzen.',
      sourceTimestamp: times[0] || null, publishedAt, ageMinutes: oldestAge,
      forecastIssuedAt: record(forecast) ? forecast.issuedAt || null : null
    });
  }
  if (spec.kind === 'level') {
    const measured = payload.latestMeasurement?.measuredAtUtc || payload.latestMeasurement?.measuredAt;
    const age = isoAgeMinutes(measured, nowMs);
    if (payload.status === 'error') return result('error', { reason: payload.statusReason || 'Pegelabruf meldet einen Fehler.', sourceTimestamp: measured || null, publishedAt });
    if (!['ok', 'stale'].includes(payload.status)) return result('unavailable', { reason: 'Unbekannter Pegelstatus.' , sourceTimestamp: measured || null, publishedAt, retrievedAt, lastSuccessfulAt, lastAttemptAt });
    if (age === null || age < -5) return result('unavailable', { reason: 'Pegel-Messzeit fehlt oder ist ungültig.', sourceTimestamp: measured || null, publishedAt });
    const stale = payload.status === 'stale' || age > spec.maxAgeMinutes;
    return result(stale ? 'stale' : 'current', { retrievedAt, publishedAt, lastSuccessfulAt, lastAttemptAt, reason: stale ? 'Pegel-Messzeit überschreitet die Frischegrenze.' : 'Pegel-Messzeit liegt innerhalb der Frischegrenze.', sourceTimestamp: measured, publishedAt, ageMinutes: age });
  }
  if (spec.kind === 'radar' || spec.kind === 'konrad') {
    const measured = spec.kind === 'radar' ? payload.productTime : payload.referenceTime;
    const age = isoAgeMinutes(measured, nowMs);
    const unavailable = age === null || age < -5 || payload.status === 'unavailable' || !['current', 'stale'].includes(payload.status);
    if (unavailable) return result('unavailable', { reason: 'Radar-Produktzeit fehlt oder ist ungültig.', sourceTimestamp: measured || null, publishedAt });
    const stale = payload.status === 'stale' || age > spec.maxAgeMinutes;
    return result(stale ? 'stale' : 'current', { retrievedAt, publishedAt, lastSuccessfulAt, lastAttemptAt, reason: stale ? 'Radar-Produktzeit überschreitet 15 Minuten.' : 'Radar-Produktzeit ist aktuell.', sourceTimestamp: measured, publishedAt, ageMinutes: age });
  }
  if (spec.kind === 'grassland') {
    const sourceTime = payload.source?.dataAsOf;
    const age = isoAgeMinutes(sourceTime, nowMs);
    const todayBerlin = berlinParts(nowMs).date;
    const hasToday = Array.isArray(payload.days) && payload.days.filter(day => day?.date === todayBerlin && Number.isInteger(day?.index) && day.index >= 1 && day.index <= 5).length === 1;
    if (payload.status === 'error') return result('error', { reason: payload.statusReason || 'DWD-Abruf meldet einen Fehler.', sourceTimestamp: sourceTime || null, publishedAt });
    if (!hasToday || age === null || age < -5) return result('unavailable', { reason: 'Tagesprognose oder echte DWD-Produktzeit fehlt.', sourceTimestamp: sourceTime || null, publishedAt, ageMinutes: age });
    const stale = payload.status !== 'ok' || age > (spec.maxAgeHours || 36) * 60;
    return result(stale ? 'stale' : 'current', { retrievedAt, publishedAt, lastSuccessfulAt, lastAttemptAt, reason: stale ? 'DWD-Produktzeit überschreitet 36 Stunden oder Produzentenstatus ist nicht aktuell.' : 'Tagesprognose und DWD-Produktzeit sind aktuell.', sourceTimestamp: sourceTime, publishedAt, ageMinutes: age });
  }
  if (spec.kind === 'wildfire') {
    const sourceDate = payload.sourceDate;
    if (payload.fetchStatus === 'error') return result('error', { reason: payload.lastError || 'MLEUV-Abruf meldet einen Fehler.', sourceTimestamp: sourceDate || null, publishedAt });
    if (payload.fetchStatus !== 'success') return result('unavailable', { reason: 'MLEUV-Abrufstatus ist nicht als erfolgreich bestätigt.', sourceTimestamp: sourceDate || null, publishedAt, retrievedAt, lastSuccessfulAt, lastAttemptAt });
    const level = Number(payload.level);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sourceDate || '')) || !Number.isInteger(level) || level < 1 || level > 5) {
      return result('unavailable', { reason: 'MLEUV-Quelldatum oder Gefahrenstufe fehlt.', sourceTimestamp: sourceDate || null, publishedAt });
    }
    const current = isWildfireSourceCurrent(sourceDate, nowMs, spec.validityStartHour || 8);
    return result(current ? 'current' : 'stale', {
      reason: current ? 'Offizielle Stufe liegt im 08:00–08:00-Intervall Europe/Berlin.' : 'Offizielle Tagesgültigkeit ist abgelaufen oder der heutige Stand fehlt.',
      sourceTimestamp: sourceDate, retrievedAt, publishedAt, lastSuccessfulAt, lastAttemptAt, ageMinutes: berlinWallTimeToUtc(sourceDate, spec.validityStartHour || 8) === null ? null : (nowMs - berlinWallTimeToUtc(sourceDate, spec.validityStartHour || 8)) / 60000, level
    });
  }
  return result('unavailable', { reason: 'Unbekannter Datenfeed-Typ.', publishedAt });
}

function latestSlotAtOrBefore(nowMs, spec) {
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (Array.isArray(spec.expectedUtcMinutes)) {
    const mins = [...spec.expectedUtcMinutes].sort((a, b) => a - b);
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();
    for (let hour = currentHour; hour >= 0; hour -= 1) {
      for (let i = mins.length - 1; i >= 0; i -= 1) {
        if (hour < currentHour || mins[i] <= currentMinute) return dayStart + hour * 3600000 + mins[i] * 60000;
      }
    }
    return dayStart - 86400000 + 23 * 3600000 + mins[mins.length - 1] * 60000;
  }
  const parts = String(spec.expectedUtcDaily || '').split(':').map(Number);
  if (parts.length !== 2 || parts.some(v => !Number.isInteger(v))) return null;
  const slot = dayStart + (parts[0] * 60 + parts[1]) * 60000;
  return nowMs >= slot ? slot : slot - 86400000;
}
function workflowMatchesRun(run, workflow) {
  return (workflow.id !== undefined && run.workflow_id === workflow.id) ||
    (typeof run.path === 'string' && run.path.endsWith(workflow.file));
}

function latestScheduledRun(runs, workflow) {
  return runs.filter(run => workflowMatchesRun(run, workflow) && run.event === 'schedule' && run.created_at)
    .sort((a, b) => Date.parse(b.run_started_at || b.created_at) - Date.parse(a.run_started_at || a.created_at))[0] || null;
}

function workflowRuns(runs, workflow) {
  return runs.filter(run => workflowMatchesRun(run, workflow))
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
}

export function automationState(runs, workflow, nowMs) {
  const matching = workflowRuns(runs, workflow);
  const latest = matching[0] || null;
  const latestAutomatic = latestScheduledRun(runs, workflow);
  const slot = latestSlotAtOrBefore(nowMs, workflow);
  const dueAfterGrace = slot !== null && nowMs >= slot + workflow.graceMinutes * 60000;
  const pending = matching.some(run => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status));
  const automaticCreated = latestAutomatic ? Date.parse(latestAutomatic.created_at) : 0;
  const automaticStarted = latestAutomatic ? Date.parse(latestAutomatic.run_started_at || latestAutomatic.created_at) : 0;
  const overdue = dueAfterGrace && !pending && automaticCreated < slot;
  let startDelayMinutes = null;
  if (latestAutomatic) {
    const latestRunSlot = latestSlotAtOrBefore(automaticCreated, workflow);
    if (latestRunSlot !== null) startDelayMinutes = (automaticStarted - latestRunSlot) / 60000;
  }
  const lastResult = latest ? (latest.conclusion || latest.status || 'unknown') : 'none';
  const scheduledRuns = runs.filter(run => run.path?.endsWith(workflow.file) && run.event === 'schedule' && run.run_started_at)
    .sort((a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at));
  const latestStartedAt = scheduledRuns[0] ? Date.parse(scheduledRuns[0].run_started_at) : null;
  const priorStartedAt = scheduledRuns[1] ? Date.parse(scheduledRuns[1].run_started_at) : null;
  const scheduleGapMinutes = latestStartedAt !== null && priorStartedAt !== null ? (latestStartedAt - priorStartedAt) / 60000 : null;
  const expectedGapMinutes = Array.isArray(workflow.expectedUtcMinutes) ? 15 : 1440;
  const largeGap = scheduleGapMinutes !== null && scheduleGapMinutes > expectedGapMinutes + workflow.graceMinutes;
  const state = latest?.conclusion === 'failure' ? 'producer_failed' :
    overdue ? 'overdue' :
    latestAutomatic && startDelayMinutes > workflow.graceMinutes || largeGap ? 'late' :
    pending ? 'pending' :
    latestAutomatic ? 'healthy' :
    dueAfterGrace ? 'no_run' : 'not_yet_run';
  return {
    latestRunAt: latest?.run_started_at || latest?.created_at || null, latestRunEvent: latest?.event || null, latestRunResult: lastResult,
    lastAutomaticRunAt: latestAutomatic?.run_started_at || latestAutomatic?.created_at || null, lastAutomaticRunResult: latestAutomatic?.conclusion || latestAutomatic?.status || null,
    scheduleSlotAt: slot === null ? null : new Date(slot).toISOString(),
    scheduleStartDelayMinutes: startDelayMinutes === null ? null : Math.round(startDelayMinutes),
    scheduleGapMinutes: scheduleGapMinutes === null ? null : Math.round(scheduleGapMinutes),
    pending, overdue, state
  };
}

export function workflowAvailability(entries, workflow) {
  const match = entries.find(entry => entry.path?.endsWith(workflow.file));
  if (!match) return { active: false, workflowActive: false, workflowDefinitionState: 'missing', availabilityReason: 'Workflow ist in der GitHub-API nicht registriert.' };
  return {
    active: match.state === 'active',
    workflowActive: match.state === 'active',
    workflowDefinitionState: match.state || 'unknown',
    availabilityReason: match.state === 'active' ? 'Workflow ist aktiv.' : 'Workflow ist nicht aktiv; der Watchdog ändert den Aktivierungszustand nicht.'
  };
}

export function reportStatus(feed, automation) {
  if (feed.fetchError || feed.dataStatus === 'error' || feed.dataStatus === 'unavailable') return 'Abruf fehlgeschlagen';
  if (automation.producerFailed || automation.state === 'producer_failed' || automation.workflowActive !== true || automation.repositoryDefaultBranch !== 'main' || automation.overdue || automation.state === 'late' || automation.state === 'no_run') return 'Automatik ausgefallen';
  if (feed.dataStatus !== 'current') return 'veraltet';
  return 'aktuell';
}

export function decisionForWorkflow(workflow, feedReports, automation, nowMs, mode) {
  const running = automation.pending;
  const unknownFeed = feedReports.some(report => report.fetchError || ['error', 'unavailable'].includes(report.dataStatus));
  const due = automation.overdue || automation.state === 'producer_failed' ||
    feedReports.some(report => report.dataStatus === 'stale' && !report.fetchError);
  return {
    shouldDispatch: mode === DISPATCH && due && !unknownFeed && !running && automation.workflowActive === true && automation.repositoryDefaultBranch === 'main',
    reason: mode !== DISPATCH ? 'observe_only' : automation.workflowActive !== true ? 'workflow_missing_or_disabled' : automation.repositoryDefaultBranch !== 'main' ? 'default_branch_is_not_main' : running ? 'workflow_already_queued_or_running' : unknownFeed ? 'feed_status_unknown' : !due ? 'feeds_and_schedule_within_limits' : 'feed_or_schedule_requires_refresh'
  };
}

function base64Url(bytesOrText) {
  const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : new Uint8Array(bytesOrText);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derLength(length) {
  if (length < 128) return new Uint8Array([length]);
  const octets = [];
  let remaining = length;
  while (remaining > 0) {
    octets.unshift(remaining & 255);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | octets.length, ...octets]);
}

function joinBytes(...chunks) {
  const length = chunks.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) { result.set(part, offset); offset += part.length; }
  return result;
}

function pkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const octet = joinBytes(new Uint8Array([0x04]), derLength(pkcs1.length), pkcs1);
  const content = joinBytes(version, algorithm, octet);
  return joinBytes(new Uint8Array([0x30]), derLength(content.length), content);
}

function pemBytes(pem) {
  const label = pem.includes('BEGIN PRIVATE KEY') ? 'pkcs8' : 'pkcs1';
  const encoded = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s/g, '');
  const binary = atob(encoded);
  const raw = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return { format: 'pkcs8', bytes: label === 'pkcs1' ? pkcs1ToPkcs8(raw) : raw };
}

export async function createAppJwt(appId, privateKeyPem, nowMs = Date.now()) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signingInput = header + '.' + payload;
  const keyMaterial = pemBytes(String(privateKeyPem).replace(/\\n/g, '\n'));
  const privateKey = await crypto.subtle.importKey(
    keyMaterial.format, keyMaterial.bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));
  return signingInput + '.' + base64Url(signature);
}

class HttpFailure extends Error {
  constructor(status, retryAtMs, stage) {
    super(stage);
    this.status = status;
    this.retryAtMs = retryAtMs;
    this.stage = stage;
  }
}

function retryTime(response, nowMs) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return nowMs + retryAfter * 1000;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > nowMs / 1000) return reset * 1000;
  return nowMs + (response.status === 401 ? 15 : response.status >= 500 ? 5 : 60) * 60000;
}

async function githubJson(url, token, stage, nowMs, fetcher = fetch, init = {}) {
  const response = await fetcher(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new HttpFailure(response.status, retryTime(response, nowMs), stage);
  return response.status === 204 ? null : response.json();
}

async function mintInstallationToken(env, mode, nowMs, fetcher = fetch) {
  const jwt = await createAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, nowMs);
  const permission = mode === DISPATCH ? 'write' : 'read';
  const response = await fetcher(API + '/app/installations/' + encodeURIComponent(env.GH_INSTALLATION_ID) + '/access_tokens', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + jwt,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ permissions: { actions: permission } }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new HttpFailure(response.status, retryTime(response, nowMs), 'installation_token');
  const body = await response.json();
  if (typeof body.token !== 'string' || !body.token) throw new Error('installation token response missing');
  return body.token;
}

async function readBackoff(db) {
  const row = await db.prepare("SELECT until_ms FROM watchdog_control WHERE key = 'github-backoff'").first();
  return Number(row?.until_ms || 0);
}

async function setBackoff(db, untilMs, reason, nowMs) {
  await db.prepare(
    "INSERT INTO watchdog_control (key, until_ms, reason, updated_at_ms) VALUES ('github-backoff', ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason, updated_at_ms = excluded.updated_at_ms"
  ).bind(untilMs, reason, nowMs).run();
}

async function nextAllowedDispatchAt(db, workflow, nowMs) {
  const row = await db.prepare(
    'SELECT last_dispatch_at_ms, dispatch_day_utc, dispatch_count FROM dispatch_guard WHERE workflow_key = ?'
  ).bind(workflow.key).first();
  if (!row) return new Date(nowMs).toISOString();
  let next = Math.max(nowMs, Number(row.last_dispatch_at_ms || 0) + workflow.minDispatchMinutes * 60000);
  const today = utcDateString(nowMs);
  if (row.dispatch_day_utc === today && Number(row.dispatch_count || 0) >= workflow.maxDispatchesPerDay) {
    const parts = today.split('-').map(Number);
    next = Math.max(next, Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
  }
  return new Date(next).toISOString();
}

export const CLAIM_DISPATCH_SQL = `INSERT INTO dispatch_guard (workflow_key, lease_until_ms, last_dispatch_at_ms, dispatch_day_utc, dispatch_count)
VALUES (?, ?, ?, ?, 1)
ON CONFLICT(workflow_key) DO UPDATE SET
  lease_until_ms = excluded.lease_until_ms,
  last_dispatch_at_ms = excluded.last_dispatch_at_ms,
  dispatch_count = CASE WHEN dispatch_guard.dispatch_day_utc = excluded.dispatch_day_utc THEN dispatch_guard.dispatch_count + 1 ELSE 1 END,
  dispatch_day_utc = excluded.dispatch_day_utc
WHERE dispatch_guard.lease_until_ms <= ?
  AND (dispatch_guard.last_dispatch_at_ms IS NULL OR dispatch_guard.last_dispatch_at_ms <= ?)
  AND (dispatch_guard.dispatch_day_utc != ? OR dispatch_guard.dispatch_count < ?)
RETURNING workflow_key`;

export async function claimDispatch(db, workflow, nowMs) {
  const day = utcDateString(nowMs);
  const leaseUntil = nowMs + workflow.minDispatchMinutes * 60000;
  const statement = db.prepare(CLAIM_DISPATCH_SQL).bind(
    workflow.key, leaseUntil, nowMs, day, nowMs,
    nowMs - workflow.minDispatchMinutes * 60000, day, workflow.maxDispatchesPerDay
  );
  const response = await statement.all();
  return Array.isArray(response.results) && response.results.length === 1;
}

async function saveStatus(db, rows, nowMs) {
  const statements = rows.map(row => db.prepare(
    "INSERT INTO watchdog_status (source_key, workflow_key, checked_at_ms, status, detail_json) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(source_key) DO UPDATE SET workflow_key = excluded.workflow_key, checked_at_ms = excluded.checked_at_ms, " +
    "status = excluded.status, detail_json = excluded.detail_json"
  ).bind(row.sourceKey, row.workflowKey, nowMs, row.status, JSON.stringify(row)));
  statements.push(db.prepare("DELETE FROM watchdog_status WHERE checked_at_ms < ?").bind(nowMs - 30 * 86400000));
  await db.batch(statements);
}

async function saveEvent(db, workflowKey, eventType, detail, nowMs) {
  await db.prepare(
    "INSERT INTO watchdog_events (created_at_ms, workflow_key, event_type, detail_json) VALUES (?, ?, ?, ?)"
  ).bind(nowMs, workflowKey, eventType, JSON.stringify(detail)).run();
  await db.prepare("DELETE FROM watchdog_events WHERE created_at_ms < ?").bind(nowMs - 90 * 86400000).run();
}

async function getJson(url, nowMs, fetcher = fetch) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new HttpFailure(response.status, retryTime(response, nowMs), 'feed');
  return response.json();
}

async function inspectFeeds(workflow, nowMs, fetcher) {
  return Promise.all(workflow.feeds.map(async spec => {
    try {
      const payload = await getJson(spec.url, nowMs, fetcher);
      const evaluated = evaluateFeed(spec, payload, nowMs);
      return { sourceKey: spec.key, feed: evaluated, payloadStatus: payload.status || null, fetchError: false };
    } catch (error) {
      return {
        sourceKey: spec.key,
        feed: result('error', { reason: 'Feedabruf fehlgeschlagen.', sourceTimestamp: null, publishedAt: null }),
        payloadStatus: null, fetchError: true,
        errorStatus: Number.isInteger(error?.status) ? error.status : null
      };
    }
  }));
}

function runStatusForWorkflow(runs, workflow, nowMs) {
  const automation = automationState(runs, workflow, nowMs);
  const matching = workflowRuns(runs, workflow);
  const latest = matching[0] || null;
  return {
    ...automation,
    latestRunConclusion: latest?.conclusion || null,
    lastSuccessfulWorkflowCompletedAt: matching.find(run => run.conclusion === 'success')?.updated_at || null,
    producerFailed: latest?.conclusion === 'failure'
  };
}

export async function runScheduledCheck(controller, env, ctx, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const fetcher = options.fetcher || fetch;
  const workflows = options.workflows || WORKFLOWS;
  const mode = env.WATCHDOG_MODE === DISPATCH && env.DISPATCH_ENABLED === 'true' ? DISPATCH : OBSERVE;
  const db = env.DB;
  if (!db) {
    console.error(JSON.stringify({ event: 'watchdog_disabled', reason: 'd1_binding_missing' }));
    return;
  }
  let backoffUntil;
  try {
    backoffUntil = await readBackoff(db);
  } catch {
    console.error(JSON.stringify({ event: 'watchdog_disabled', reason: 'd1_read_failed' }));
    return;
  }
  if (nowMs < backoffUntil) {
    try {
      await saveStatus(db, workflows.flatMap(workflow => workflow.feeds.map(feed => ({
        sourceKey: feed.key, workflowKey: workflow.key, status: 'Automatik ausgefallen',
        monitorError: 'GitHub-API-Backoff aktiv', nextRetryAt: new Date(backoffUntil).toISOString()
      }))), nowMs);
    } catch { /* Fail closed; status log may itself be unavailable. */ }
    return;
  }
  let token;
  let workflowEntries;
  let runsByWorkflow;
  let repositoryDefaultBranch;
  const missingConfig = ['GH_APP_ID', 'GH_INSTALLATION_ID', 'GH_APP_PRIVATE_KEY'].filter(key => !env[key]);
  if (missingConfig.length) {
    try {
      await saveStatus(db, workflows.flatMap(workflow => workflow.feeds.map(feed => ({
        sourceKey: feed.key, workflowKey: workflow.key, status: 'Automatik ausgefallen',
        monitoringError: 'GitHub-App-Konfiguration fehlt: ' + missingConfig.join(', ')
      }))), nowMs);
    } catch { /* No dispatch without durable monitoring state. */ }
    console.error(JSON.stringify({ event: 'watchdog_disabled', reason: 'github_app_configuration_missing', fields: missingConfig }));
    return;
  }
  try {
    token = await mintInstallationToken(env, mode, nowMs, fetcher);
    const repository = await githubJson(API + '/repos/' + OWNER + '/' + REPO, token, 'repository_metadata', nowMs, fetcher);
    repositoryDefaultBranch = repository?.default_branch || null;
    const workflowResult = await githubJson(API + '/repos/' + OWNER + '/' + REPO + '/actions/workflows?per_page=100', token, 'workflow_list', nowMs, fetcher);
    workflowEntries = Array.isArray(workflowResult?.workflows) ? workflowResult.workflows : [];
    runsByWorkflow = new Map();
    const runLists = await Promise.all(workflows.map(async workflow => {
      const entry = workflowEntries.find(item => item.path?.endsWith(workflow.file));
      if (!entry || entry.state !== 'active') return [workflow.key, []];
      const response = await githubJson(
        API + '/repos/' + OWNER + '/' + REPO + '/actions/workflows/' + encodeURIComponent(entry.id) + '/runs?per_page=100',
        token, 'workflow_runs_' + workflow.key, nowMs, fetcher
      );
      return [workflow.key, Array.isArray(response?.workflow_runs) ? response.workflow_runs : []];
    }));
    for (const [key, values] of runLists) runsByWorkflow.set(key, values);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 0;
    const until = Number.isFinite(error?.retryAtMs) ? error.retryAtMs : nowMs + 5 * 60000;
    try { await setBackoff(db, until, 'github_api_' + status, nowMs); } catch { /* No dispatch without durable state. */ }
    try {
      await saveStatus(db, workflows.flatMap(workflow => workflow.feeds.map(feed => ({
        sourceKey: feed.key, workflowKey: workflow.key, status: 'Automatik ausgefallen',
        monitorError: 'GitHub-API nicht verfügbar (' + status + ')', nextRetryAt: new Date(until).toISOString()
      }))), nowMs);
    } catch { /* Fail closed. */ }
    console.error(JSON.stringify({ event: 'github_api_failure', status, retryAt: until }));
    return;
  }

  const nextAllowed = new Map();
  try {
    for (const workflow of workflows) nextAllowed.set(workflow.key, await nextAllowedDispatchAt(db, workflow, nowMs));
  } catch {
    console.error(JSON.stringify({ event: 'watchdog_disabled', reason: 'd1_dispatch_state_read_failed' }));
    return;
  }
  const rows = [];
  const workflowEvaluations = [];
  for (const workflow of workflows) {
    const workflowRunsForKey = runsByWorkflow.get(workflow.key) || [];
    const runtimeWorkflow = { ...workflow, id: workflowEntries.find(entry => entry.path?.endsWith(workflow.file))?.id };
    const automation = { ...runStatusForWorkflow(workflowRunsForKey, runtimeWorkflow, nowMs), ...workflowAvailability(workflowEntries, workflow), repositoryDefaultBranch };
    const inspected = await inspectFeeds(workflow, nowMs, fetcher);
    const reports = inspected.map(item => {
      const feed = item.feed;
      const status = item.fetchError || feed.dataStatus === 'error' || feed.dataStatus === 'unavailable'
        ? 'Abruf fehlgeschlagen'
        : automation.producerFailed || automation.state === 'producer_failed' || automation.workflowActive !== true || automation.repositoryDefaultBranch !== 'main' || automation.overdue || automation.state === 'late' || automation.state === 'no_run'
          ? 'Automatik ausgefallen'
          : feed.dataStatus === 'current' ? 'aktuell' : 'veraltet';
      const report = {
        sourceKey: item.sourceKey, workflowKey: workflow.key, status, dataStatus: feed.dataStatus,
        checkedAt: new Date(nowMs).toISOString(), workflowFile: workflow.file,
        lastWorkflowStartAt: automation.latestRunAt, lastWorkflowResult: automation.latestRunResult,
        lastAutomaticStartAt: automation.lastAutomaticRunAt, lastAutomaticResult: automation.lastAutomaticRunResult,
        repositoryDefaultBranch: automation.repositoryDefaultBranch, workflowActive: automation.workflowActive, workflowState: automation.workflowDefinitionState, workflowStateReason: automation.availabilityReason,
        scheduleSlotAt: automation.scheduleSlotAt, scheduleStartDelayMinutes: automation.scheduleStartDelayMinutes, scheduleGapMinutes: automation.scheduleGapMinutes,
        sourceTimestamp: feed.sourceTimestamp || null, publishedAt: feed.publishedAt || null, retrievedAt: feed.retrievedAt || null,
        lastSuccessfulSourceAt: feed.lastSuccessfulAt || null, lastSourceAttemptAt: feed.lastAttemptAt || null,
        lastSuccessfulWorkflowCompletedAt: automation.lastSuccessfulWorkflowCompletedAt || null,
        sourceAgeMinutes: Number.isFinite(feed.ageMinutes) ? Math.round(feed.ageMinutes) : null,
        reason: feed.reason, feedHttpStatus: item.errorStatus || null,
        pending: automation.pending, monitoringError: null,
        dispatchMode: mode, dispatchEnabled: mode === DISPATCH, nextAllowedDispatchAt: nextAllowed.get(workflow.key) || null
      };
      rows.push({ sourceKey: item.sourceKey, workflowKey: workflow.key, status, ...report });
      return { ...report, fetchError: item.fetchError };
    });
    const decision = decisionForWorkflow(runtimeWorkflow, reports, automation, nowMs, mode);
    for (const row of rows) if (row.workflowKey === workflow.key) {
      row.dispatchDecision = decision.reason;
      row.dispatchEligible = decision.shouldDispatch;
      row.dispatchDailyLimit = workflow.maxDispatchesPerDay;
      row.dispatchCooldownMinutes = workflow.minDispatchMinutes;
    }
    workflowEvaluations.push({ workflow: runtimeWorkflow, automation, reports, decision });
  }
  try {
    await saveStatus(db, rows, nowMs);
  } catch {
    console.error(JSON.stringify({ event: 'watchdog_disabled', reason: 'd1_write_failed' }));
    return;
  }

  if (mode !== DISPATCH) return;
  for (const item of workflowEvaluations) {
    const decision = item.decision;
    if (!decision.shouldDispatch) continue;
    let claimed;
    try { claimed = await claimDispatch(db, item.workflow, nowMs); }
    catch {
      console.error(JSON.stringify({ event: 'dispatch_blocked', workflow: item.workflow.key, reason: 'd1_lock_failed' }));
      continue;
    }
    if (!claimed) {
      for (const report of item.reports) {
        report.dispatchDecision = 'cooldown_or_daily_limit';
        report.dispatchEligible = false;
      }
      for (const row of rows) if (row.workflowKey === item.workflow.key) {
        row.dispatchDecision = 'cooldown_or_daily_limit';
        row.dispatchEligible = false;
      }
      try { await saveStatus(db, rows.filter(row => row.workflowKey === item.workflow.key), nowMs); }
      catch { console.error(JSON.stringify({ event: 'watchdog_disabled', reason: 'd1_write_failed' })); }
      continue;
    }
    const dispatchUrl = API + '/repos/' + OWNER + '/' + REPO + '/actions/workflows/' + encodeURIComponent(item.workflow.file) + '/dispatches';
    try {
      const response = await fetcher(dispatchUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref: 'main' }),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new HttpFailure(response.status, retryTime(response, nowMs), 'dispatch');
      try {
        await saveEvent(db, item.workflow.key, 'workflow_dispatch_requested', {
          workflowFile: item.workflow.file, ref: 'main', requestedAt: new Date(nowMs).toISOString(),
          note: 'Dispatch-Annahme ist kein Nachweis einer aktualisierten Veröffentlichung.'
        }, nowMs);
      } catch { console.error(JSON.stringify({ event: 'watchdog_event_write_failed', workflow: item.workflow.key })); }
      const allowedAt = new Date(nowMs + item.workflow.minDispatchMinutes * 60000).toISOString();
      for (const report of item.reports) {
        report.nextAllowedDispatchAt = allowedAt;
        report.dispatchRequestedAt = new Date(nowMs).toISOString();
      }
      for (const row of rows) if (row.workflowKey === item.workflow.key) {
        row.nextAllowedDispatchAt = allowedAt;
        row.dispatchRequestedAt = new Date(nowMs).toISOString();
      }
      await saveStatus(db, rows.filter(row => row.workflowKey === item.workflow.key), nowMs);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 0;
      try {
        await saveEvent(db, item.workflow.key, 'workflow_dispatch_failed', {
          workflowFile: item.workflow.file, status, retryAt: error?.retryAtMs || null
        }, nowMs);
      } catch { console.error(JSON.stringify({ event: 'watchdog_event_write_failed', workflow: item.workflow.key })); }
      const allowedAt = new Date(nowMs + item.workflow.minDispatchMinutes * 60000).toISOString();
      for (const report of item.reports) {
        report.nextAllowedDispatchAt = allowedAt;
        report.dispatchFailureStatus = status;
      }
      for (const row of rows) if (row.workflowKey === item.workflow.key) {
        row.nextAllowedDispatchAt = allowedAt;
        row.dispatchFailureStatus = status;
      }
      try { await saveStatus(db, rows.filter(row => row.workflowKey === item.workflow.key), nowMs); } catch { /* fail closed */ }
      if (status === 403 || status === 429) {
        try { await setBackoff(db, error.retryAtMs || nowMs + 60 * 60000, 'dispatch_rate_limit', nowMs); } catch { /* fail closed */ }
      }
      console.error(JSON.stringify({ event: 'workflow_dispatch_failed', workflow: item.workflow.key, status }));
    }
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const task = runScheduledCheck(controller, env, ctx);
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
  }
};