/**
 * Standalone DWD weather dispatcher preparation.
 * Default mode is disabled. There is no HTTP handler or public control endpoint.
 */
const OWNER = "RonnsenDD";
const REPO = "lhh-data-hub";
const WORKFLOW = "update-dwd-weather.yml";
const SIDECAR = "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather-freshness.json";
const API = "https://api.github.com";
const RUN_COOLDOWN_MINUTES = 20;
const OBSERVATION_MAX_MINUTES = 60;
const MOSMIX_MAX_MINUTES = 12 * 60;
const CHECK_MINUTES_UTC = new Set([8, 23, 38, 53]);
const API_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const utf8 = (value) => new TextEncoder().encode(value);

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag, value) {
  const length = derLength(value.length);
  const result = new Uint8Array(1 + length.length + value.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.length);
  return result;
}

export function privateKeyPkcs8(pem) {
  const match = /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----([\s\S]+?)-----END \1-----$/.exec(String(pem || "").trim());
  if (!match) throw new Error("github-app-key-format-unsupported");
  const raw = Uint8Array.from(atob(match[2].replace(/\s/g, "")), (char) => char.charCodeAt(0));
  if (match[1] === "PRIVATE KEY") return raw;
  const algorithm = der(0x30, Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00));
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateOctets = der(0x04, raw);
  const content = new Uint8Array(version.length + algorithm.length + privateOctets.length);
  content.set(version);
  content.set(algorithm, version.length);
  content.set(privateOctets, version.length + algorithm.length);
  return der(0x30, content);
}

function validInstant(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function ageMinutes(value, now) {
  if (!validInstant(value)) return null;
  const age = (now - Date.parse(value)) / 60000;
  return age < -5 ? null : Math.max(0, age);
}

function newestRun(runs) {
  return runs.reduce((latest, run) => !latest || Date.parse(run.created_at) > Date.parse(latest.created_at) ? run : latest, null);
}

/** Re-evaluate original observation/model times; derivedAt is intentionally ignored. */
export function assessWeather(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return { valid: false, reason: "snapshot-invalid" };
  if (snapshot.source !== "DWD weather snapshot v2" || !validInstant(snapshot.lastAttemptAt)
    || !["ok", "partial", "stale", "error", "unavailable"].includes(snapshot.sourceStatus)) return { valid: false, reason: "source-or-attempt-time-invalid" };
  if (ageMinutes(snapshot.lastAttemptAt, now) === null) return { valid: false, reason: "source-attempt-time-in-future-or-invalid" };
  const observations = snapshot.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations) || Object.keys(observations).length === 0) {
    return { valid: false, reason: "observations-missing" };
  }
  let maxObservationAge = 0;
  let observationsStale = false;
  for (const item of Object.values(observations)) {
    if (!item || typeof item !== "object" || !validInstant(item.measuredAt)
      || !["ok", "stale", "partial", "error", "unavailable"].includes(item.status)) return { valid: false, reason: "observation-time-invalid" };
    const age = ageMinutes(item.measuredAt, now);
    if (age === null) return { valid: false, reason: "observation-time-in-future-or-invalid" };
    // Never accept a sidecar that claims a looser limit than the established 60 minutes.
    const declared = item.freshnessThresholdMinutes;
    if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0 || declared > OBSERVATION_MAX_MINUTES) {
      return { valid: false, reason: "observation-threshold-invalid" };
    }
    maxObservationAge = Math.max(maxObservationAge, age);
    if (item.status !== "ok" || age > Math.min(declared, OBSERVATION_MAX_MINUTES)) observationsStale = true;
  }
  const forecast = snapshot.forecast;
  if (!forecast || typeof forecast !== "object" || !validInstant(forecast.issuedAt)
    || !["ok", "stale", "partial", "error", "unavailable"].includes(forecast.status)
    || (forecast.refreshStatus !== undefined && !["success", "error"].includes(forecast.refreshStatus))) return { valid: false, reason: "forecast-time-invalid" };
  const forecastAge = ageMinutes(forecast.issuedAt, now);
  if (forecastAge === null) return { valid: false, reason: "forecast-time-in-future-or-invalid" };
  const forecastLimit = forecast.freshnessThresholdMinutes ?? MOSMIX_MAX_MINUTES;
  if (typeof forecastLimit !== "number" || !Number.isFinite(forecastLimit) || forecastLimit <= 0 || forecastLimit > MOSMIX_MAX_MINUTES) {
    return { valid: false, reason: "forecast-threshold-invalid" };
  }
  if (typeof forecast.hasUsablePoint !== "boolean") return { valid: false, reason: "forecast-usability-unknown" };
  if (forecast.validThrough !== null && forecast.validThrough !== undefined && !validInstant(forecast.validThrough)) return { valid: false, reason: "forecast-horizon-invalid" };
  const horizonExpired = !forecast.validThrough || Date.parse(forecast.validThrough) < now;
  const forecastStale = forecast.status !== "ok"
    || forecast.refreshStatus === "error"
    || !forecast.hasUsablePoint
    || horizonExpired
    || forecastAge > Math.min(forecastLimit, MOSMIX_MAX_MINUTES);
  const stale = observationsStale || forecastStale || snapshot.sourceStatus !== "ok";
  return {
    valid: true,
    stale,
    reason: stale ? "published-source-data-stale" : "published-source-data-fresh",
    sourceStatus: snapshot.sourceStatus,
    weatherAgeMinutes: Math.round(maxObservationAge),
    mosmixAgeMinutes: Math.round(forecastAge),
    lastAttemptAt: snapshot.lastAttemptAt,
    lastSuccessfulAt: validInstant(snapshot.lastSuccessfulAt) ? snapshot.lastSuccessfulAt : null,
    snapshotPublishedAt: validInstant(snapshot.snapshotPublishedAt) ? snapshot.snapshotPublishedAt : null,
    derivedAtUsedForFreshness: false,
  };
}

export function decide({ mode, assessment, runs, now = Date.now(), dispatchEnabled = false }) {
  const decisionTime = new Date(now).toISOString();
  const base = {
    decisionTime,
    weatherAgeMinutes: assessment?.weatherAgeMinutes ?? null,
    mosmixAgeMinutes: assessment?.mosmixAgeMinutes ?? null,
    lastSuccessfulAt: assessment?.lastSuccessfulAt ?? null,
    snapshotPublishedAt: assessment?.snapshotPublishedAt ?? null,
    lastWorkflowStart: null,
    workflowStatus: null,
    workflowEvent: null,
    dispatch: false,
    errorStatus: "none",
  };
  if (mode === "disabled" || !mode) return { ...base, reason: "disabled" };
  if (mode !== "observe" && mode !== "dispatch") return { ...base, reason: "mode-invalid", errorStatus: "configuration-invalid" };
  if (!assessment?.valid) return { ...base, reason: assessment?.reason || "source-state-unknown", errorStatus: "source-state-invalid" };
  if (!Array.isArray(runs) || runs.some((run) => !run || !validInstant(run.created_at) || ageMinutes(run.created_at, now) === null || !["queued", "in_progress", "completed"].includes(run.status))) {
    return { ...base, reason: "workflow-history-invalid", errorStatus: "workflow-history-invalid" };
  }
  const latest = newestRun(runs);
  if (latest) Object.assign(base, { lastWorkflowStart: latest.created_at, workflowStatus: latest.status, workflowEvent: typeof latest.event === "string" ? latest.event : null });
  if (!assessment.stale) return { ...base, reason: "data-fresh" };
  if (runs.some((run) => run.status === "queued" || run.status === "in_progress")) return { ...base, reason: "workflow-active" };
  if (runs.some((run) => (now - Date.parse(run.created_at)) / 60000 < RUN_COOLDOWN_MINUTES)) return { ...base, reason: "workflow-start-cooldown" };
  const attemptAge = ageMinutes(assessment.lastAttemptAt, now);
  if (attemptAge === null) return { ...base, reason: "source-attempt-time-invalid", errorStatus: "source-state-invalid" };
  if (attemptAge < RUN_COOLDOWN_MINUTES) return { ...base, reason: "publication-attempt-cooldown" };
  if (mode === "observe") return { ...base, reason: "would-dispatch", wouldDispatch: true };
  if (!dispatchEnabled) return { ...base, reason: "dispatch-gate-disabled" };
  return { ...base, reason: "dispatch-eligible", dispatch: true };
}

export async function appToken(env, fetchImpl = fetch, permission = "read", nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("github-app-config-missing");
  const header = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(utf8(JSON.stringify({ iat: nowSeconds - 30, exp: nowSeconds + 540, iss: env.GITHUB_APP_ID })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", privateKeyPkcs8(env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(signingInput));
  const jwt = `${signingInput}.${b64url(signature)}`;
  const response = await fetchImpl(`${API}/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`, {
    method: "POST",
    headers: { ...API_HEADERS, authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ repositories: [REPO], permissions: { actions: permission } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`github-token-http-${response.status}`);
  const result = await response.json();
  if (typeof result.token !== "string" || !result.token) throw new Error("github-token-response-invalid");
  return result.token;
}

async function getJson(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { ...API_HEADERS, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`github-api-http-${response.status}`);
  return response.json();
}

async function fetchSnapshot(fetchImpl = fetch) {
  const response = await fetchImpl(SIDECAR, { cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`sidecar-http-${response.status}`);
  try { return await response.json(); } catch { throw new Error("sidecar-json-invalid"); }
}

export async function evaluateWeatherDispatcher(env, fetchImpl = fetch, now = Date.now()) {
  const mode = env.WEATHER_DISPATCH_MODE || "disabled";
  if (mode === "disabled") return { dispatch: false, reason: "disabled", decisionTime: new Date(now).toISOString(), errorStatus: "none" };
  if (mode !== "observe" && mode !== "dispatch") return { dispatch: false, reason: "mode-invalid", decisionTime: new Date(now).toISOString(), errorStatus: "configuration-invalid" };
  let assessment;
  try { assessment = assessWeather(await fetchSnapshot(fetchImpl), now); }
  catch (error) {
    const http = /^sidecar-http-(\d{3})$/.exec(error.message);
    return { dispatch: false, reason: http ? "public-sidecar-unavailable" : "public-sidecar-invalid", decisionTime: new Date(now).toISOString(), errorStatus: http ? `sidecar-http-${http[1]}` : error.message === "sidecar-json-invalid" ? "sidecar-json-invalid" : "sidecar-request-failed" };
  }
  let token;
  // This preparation branch never requests Actions: write. A future approved
  // implementation must add a reviewed lock path before it can request that scope.
  try { token = await appToken(env, fetchImpl, "read"); }
  catch (error) {
    return { ...decide({ mode, assessment, runs: null, now }), dispatch: false, wouldDispatch: false, reason: error.message === "github-app-config-missing" ? "github-app-config-missing" : "github-authentication-unavailable", errorStatus: error.message.startsWith("github-token-http-") ? error.message : "github-authentication-failed" };
  }
  let runs;
  try {
    const payload = await getJson(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=20`, token, fetchImpl);
    runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : null;
  } catch (error) {
    return { ...decide({ mode, assessment, runs: null, now }), dispatch: false, wouldDispatch: false, reason: "github-workflow-history-unavailable", errorStatus: error.message.startsWith("github-api-http-") ? error.message : "github-api-request-failed" };
  }
  const decision = decide({ mode, assessment, runs, now, dispatchEnabled: env.WEATHER_DISPATCH_ENABLED === "true" });
  if (!decision.dispatch) return decision;
  // No persistent atomic lock is provisioned for this standalone Worker. Even
  // with all source/run checks passing, do not POST until a separate approved
  // coordination mechanism exists. GitHub concurrency alone cannot prevent
  // duplicate dispatch requests from being queued.
  return { ...decision, dispatch: false, reason: "atomic-dispatch-lock-not-configured" };
}

export function isEligibleCron(controller) {
  if (!controller || !Number.isFinite(controller.scheduledTime)) return false;
  return CHECK_MINUTES_UTC.has(new Date(controller.scheduledTime).getUTCMinutes());
}

export default {
  async scheduled(controller, env) {
    if (!isEligibleCron(controller)) return;
    const now = controller.scheduledTime;
    try {
      const result = await evaluateWeatherDispatcher(env, fetch, now);
      console.log(JSON.stringify({ component: "dwd-weather-dispatcher", outcome: result.dispatch ? "dispatch-accepted" : result.wouldDispatch ? "would-dispatch" : "observe", ...result }));
    } catch {
      // Do not log exception text, request URLs, headers, tokens, or bodies.
      console.error(JSON.stringify({ component: "dwd-weather-dispatcher", outcome: "error", decisionTime: new Date(now).toISOString(), dispatch: false, reason: "unexpected-runtime-error", errorStatus: "runtime-error" }));
    }
  },
};
