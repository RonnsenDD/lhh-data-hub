const API_ORIGIN = "https://api.github.com";
const REPOSITORY_PATH = "/repos/RonnsenDD/lhh-data-hub";
const REPOSITORY_ID = 1424581788;
const API_VERSION = "2026-03-10";
const MAX_TOKEN_BYTES = 65536;
const MAX_RUNS_BYTES = 131072; // Keep five parallel run-list payloads bounded for Workers Free.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const GITHUB_JSON_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const WORKFLOWS = Object.freeze([
  { file: "update-dwd-weather.yml", cron: "3,18,33,48 * * * *", kind: "quarter-hour", minutes: [3, 18, 33, 48] },
  { file: "update-levels.yml", cron: "11,26,41,56 * * * *", kind: "quarter-hour", minutes: [11, 26, 41, 56] },
  { file: "update-radolan-ry.yml", cron: "7,22,37,52 * * * *", kind: "quarter-hour", minutes: [7, 22, 37, 52] },
  { file: "update-graslandfeuerindex.yml", cron: "15 5 * * *", kind: "daily", hour: 5, minute: 15 },
  { file: "update-waldbrandgefahrenstufe-osl.yml", cron: "20 7 * * *", kind: "daily", hour: 7, minute: 20 },
]);

export class GitHubAppAdapterError extends Error {
  /**
   * @param {string} code
   * @param {{stage?: string, status?: number | null, retryAfterSeconds?: number | null, rateLimitRemaining?: number | null, rateLimitResetAt?: string | null}} [details]
   */
  constructor(code, details = {}) {
    const { stage, status, retryAfterSeconds, rateLimitRemaining, rateLimitResetAt } = details;
    super(code);
    this.name = "GitHubAppAdapterError";
    this.code = code;
    this.stage = stage ?? "unknown";
    this.status = status ?? null;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
    this.rateLimitRemaining = rateLimitRemaining ?? null;
    this.rateLimitResetAt = rateLimitResetAt ?? null;
  }
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const parts = [];
  let n = length;
  while (n > 0) {
    parts.unshift(n & 0xff);
    n >>>= 8;
  }
  return Uint8Array.of(0x80 | parts.length, ...parts);
}

function derTlv(tag, content) {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryptionAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7,
    0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  return derTlv(0x30, concatBytes(version, rsaEncryptionAlgorithm, derTlv(0x04, pkcs1)));
}

function pemToPkcs8(pem) {
  if (typeof pem !== "string" || pem.length < 100) {
    throw new GitHubAppAdapterError("INVALID_PRIVATE_KEY", { stage: "key_import" });
  }
  const match = pem.match(/-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!match) throw new GitHubAppAdapterError("INVALID_PRIVATE_KEY", { stage: "key_import" });
  try {
    const raw = atob(match[2].replace(/\s/g, ""));
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    return match[1] === "RSA PRIVATE KEY" ? wrapPkcs1AsPkcs8(bytes) : bytes;
  } catch {
    throw new GitHubAppAdapterError("INVALID_PRIVATE_KEY", { stage: "key_import" });
  }
}

function base64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

async function importSigningKey(privateKeyPem, cryptoImpl) {
  const der = pemToPkcs8(privateKeyPem);
  try {
    return await cryptoImpl.subtle.importKey(
      "pkcs8",
      der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new GitHubAppAdapterError("INVALID_PRIVATE_KEY", { stage: "key_import" });
  } finally {
    der.fill(0);
  }
}

export async function createAppJwt({ appId, privateKeyPem, nowMs = Date.now(), cryptoImpl = crypto }) {
  if (!/^\d+$/.test(String(appId ?? ""))) {
    throw new GitHubAppAdapterError("INVALID_APP_ID", { stage: "jwt" });
  }
  if (!cryptoImpl?.subtle) throw new GitHubAppAdapterError("WEBCRYPTO_UNAVAILABLE", { stage: "jwt" });
  const key = await importSigningKey(privateKeyPem, cryptoImpl);
  return signAppJwt({ appId: String(appId), key, nowMs, cryptoImpl });
}

async function signAppJwt({ appId, key, nowMs, cryptoImpl }) {
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const header = base64Url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(utf8(JSON.stringify({
    iss: appId,
    iat: issuedAt,
    exp: Math.floor(nowMs / 1000) + 540,
  })));
  const message = utf8(header + "." + payload);
  let signature;
  try {
    signature = await cryptoImpl.subtle.sign("RSASSA-PKCS1-v1_5", key, message);
  } catch {
    throw new GitHubAppAdapterError("JWT_SIGN_FAILED", { stage: "jwt" });
  }
  return header + "." + payload + "." + base64Url(new Uint8Array(signature));
}

function getHeaderNumber(headers, name) {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function responseMetadata(headers) {
  const reset = getHeaderNumber(headers, "x-ratelimit-reset");
  return {
    rateLimitRemaining: getHeaderNumber(headers, "x-ratelimit-remaining"),
    rateLimitResetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    retryAfterSeconds: getHeaderNumber(headers, "retry-after"),
  };
}

function classifyHttpError(status, headers, stage) {
  const metadata = responseMetadata(headers);
  if (status === 401) return new GitHubAppAdapterError("GITHUB_UNAUTHORIZED", { stage, status, ...metadata });
  if (status === 403) {
    const rateLimited = metadata.rateLimitRemaining === 0 || metadata.retryAfterSeconds !== null;
    return new GitHubAppAdapterError(rateLimited ? "GITHUB_RATE_LIMITED" : "GITHUB_PERMISSION_DENIED", { stage, status, ...metadata });
  }
  if (status === 429) return new GitHubAppAdapterError("GITHUB_RATE_LIMITED", { stage, status, ...metadata });
  if (status >= 500) return new GitHubAppAdapterError("GITHUB_UPSTREAM_ERROR", { stage, status, ...metadata });
  return new GitHubAppAdapterError("GITHUB_HTTP_ERROR", { stage, status, ...metadata });
}

async function readJsonBounded(response, maxBytes, stage) {
  if (!response.body) throw new GitHubAppAdapterError("GITHUB_INVALID_RESPONSE", { stage, status: response.status });
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GitHubAppAdapterError("GITHUB_RESPONSE_TOO_LARGE", { stage, status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = concatBytes(...chunks);
  try {
    return JSON.parse(GITHUB_JSON_DECODER.decode(bytes));
  } catch {
    throw new GitHubAppAdapterError("GITHUB_INVALID_RESPONSE", { stage, status: response.status });
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 1;

async function fetchJson(fetcher, url, init, { timeoutMs, maxBytes, stage }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const initial = new URL(url);
    if (initial.origin !== API_ORIGIN) {
      throw new GitHubAppAdapterError("GITHUB_REDIRECT_REJECTED", { stage });
    }
    let current = initial;
    let redirects = 0;
    const visited = new Set();
    let response;
    while (true) {
      if (visited.has(current.href)) {
        throw new GitHubAppAdapterError("GITHUB_REDIRECT_REJECTED", { stage });
      }
      visited.add(current.href);
      response = await fetcher(current.href, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // A redirect body is discarded regardless of cancel outcome.
        }
      }
      if (!location || redirects >= MAX_REDIRECTS) {
        throw new GitHubAppAdapterError("GITHUB_REDIRECT_REJECTED", {
          stage,
          status: response.status,
        });
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new GitHubAppAdapterError("GITHUB_REDIRECT_REJECTED", {
          stage,
          status: response.status,
        });
      }
      if (
        next.origin !== API_ORIGIN ||
        next.protocol !== "https:" ||
        next.username ||
        next.password
      ) {
        throw new GitHubAppAdapterError("GITHUB_REDIRECT_REJECTED", {
          stage,
          status: response.status,
        });
      }
      current = next;
      redirects++;
    }
    if (!response.ok) throw classifyHttpError(response.status, response.headers, stage);
    const value = await readJsonBounded(response, maxBytes, stage);
    return { value, headers: response.headers };
  } catch (error) {
    if (error instanceof GitHubAppAdapterError) throw error;
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new GitHubAppAdapterError("GITHUB_TIMEOUT", { stage });
    }
    throw new GitHubAppAdapterError("GITHUB_NETWORK_ERROR", { stage });
  } finally {
    clearTimeout(timer);
  }
}

function validateEnvironment(env) {
  const appId = String(env?.GITHUB_APP_ID ?? "");
  const installationId = String(env?.GITHUB_INSTALLATION_ID ?? "");
  const privateKeyPem = env?.GITHUB_APP_PRIVATE_KEY;
  if (!/^\d+$/.test(appId)) throw new GitHubAppAdapterError("INVALID_APP_ID", { stage: "configuration" });
  if (!/^\d+$/.test(installationId)) throw new GitHubAppAdapterError("INVALID_INSTALLATION_ID", { stage: "configuration" });
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    throw new GitHubAppAdapterError("MISSING_PRIVATE_KEY", { stage: "configuration" });
  }
  return { appId, installationId, privateKeyPem };
}

function expectedTickAtOrBefore(nowMs, workflow) {
  const minute = 60_000;
  if (workflow.kind === "daily") {
    const d = new Date(nowMs);
    d.setUTCHours(workflow.hour, workflow.minute, 0, 0);
    let tick = d.getTime();
    if (tick > nowMs) tick -= 24 * 60 * minute;
    return tick;
  }
  const currentHour = Math.floor(nowMs / (60 * minute)) * (60 * minute);
  let latest = null;
  for (let hoursBack = 0; hoursBack <= 1; hoursBack++) {
    const hourStart = currentHour - hoursBack * 60 * minute;
    for (const value of workflow.minutes) {
      const tick = hourStart + value * minute;
      if (tick <= nowMs && (latest === null || tick > latest)) latest = tick;
    }
  }
  return latest;
}

const MAX_TICK_COUNT_SCAN = 10_000;

function countExpectedTicksBetween(afterMs, throughMs, workflow) {
  if (!Number.isFinite(afterMs) || !Number.isFinite(throughMs) || throughMs <= afterMs) return 0;
  let count = 0;
  if (workflow.kind === "daily") {
    const step = 24 * 60 * 60 * 1000;
    let tick = expectedTickAtOrBefore(afterMs, workflow);
    if (tick <= afterMs) tick += step;
    while (tick <= throughMs) {
      count++;
      if (count > MAX_TICK_COUNT_SCAN) return null;
      tick += step;
    }
    return count;
  }

  const hourMs = 60 * 60 * 1000;
  const firstHour = Math.floor(afterMs / hourMs) * hourMs;
  const lastHour = Math.floor(throughMs / hourMs) * hourMs;
  if ((lastHour - firstHour) / hourMs > MAX_TICK_COUNT_SCAN) return null;
  for (let hourStart = firstHour; hourStart <= lastHour; hourStart += hourMs) {
    for (const minute of workflow.minutes) {
      const tick = hourStart + minute * 60_000;
      if (tick > afterMs && tick <= throughMs) count++;
    }
  }
  return count;
}

function validRunsPayload(value) {
  return value && typeof value === "object" && Array.isArray(value.workflow_runs);
}

function summarizeWorkflow(workflow, runsPayload, nowMs) {
  if (!validRunsPayload(runsPayload)) {
    throw new GitHubAppAdapterError("GITHUB_INVALID_RESPONSE", { stage: "workflow_runs" });
  }
  const runs = runsPayload.workflow_runs
    .filter((run) => run && typeof run === "object" && typeof run.created_at === "string" && Number.isFinite(Date.parse(run.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const lastSuccess = runs.find((run) => run.conclusion === "success");
  const failureConclusions = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);
  const lastFailure = runs.find((run) => failureConclusions.has(run.conclusion));
  const activeStatuses = new Set(["queued", "waiting", "pending", "requested", "in_progress"]);
  const activeRuns = runs
    .filter((run) => activeStatuses.has(run.status))
    .map((run) => ({ id: run.id ?? null, status: run.status, createdAt: run.created_at }))
    .slice(0, 10);
  const automaticRuns = runs.filter((run) => run.event === "schedule");
  const lastAutomatic = automaticRuns[0] ?? null;
  const previousAutomatic = automaticRuns[1] ?? null;
  const lastAutomaticCreatedMs = lastAutomatic ? Date.parse(lastAutomatic.created_at) : Number.NaN;
  const lastAutomaticStartedMs = lastAutomatic && typeof lastAutomatic.run_started_at === "string"
    ? Date.parse(lastAutomatic.run_started_at)
    : Number.NaN;
  const previousAutomaticCreatedMs = previousAutomatic ? Date.parse(previousAutomatic.created_at) : Number.NaN;
  const latestExpectedTick = expectedTickAtOrBefore(nowMs, workflow);
  const lastRunExpectedTick = Number.isFinite(lastAutomaticCreatedMs)
    ? expectedTickAtOrBefore(lastAutomaticCreatedMs, workflow)
    : Number.NaN;
  const latestExpectedTickOverdueMinutes =
    Number.isFinite(lastAutomaticCreatedMs) && lastAutomaticCreatedMs >= latestExpectedTick
      ? 0
      : Math.max(0, Math.floor((nowMs - latestExpectedTick) / 60_000));
  const expectedTicksBetweenRuns =
    Number.isFinite(previousAutomaticCreatedMs) && Number.isFinite(lastRunExpectedTick)
      ? countExpectedTicksBetween(previousAutomaticCreatedMs, lastRunExpectedTick, workflow)
      : null;
  const missingExpectedTicksBetweenRuns =
    expectedTicksBetweenRuns === null ? null : Math.max(0, expectedTicksBetweenRuns - 1);
  const creationDelayMinutes = Number.isFinite(lastAutomaticCreatedMs) && Number.isFinite(lastRunExpectedTick)
    ? Math.max(0, Math.floor((lastAutomaticCreatedMs - lastRunExpectedTick) / 60_000))
    : null;
  const actualStartDelayMinutes = Number.isFinite(lastAutomaticStartedMs) && Number.isFinite(lastRunExpectedTick)
    ? Math.max(0, Math.floor((lastAutomaticStartedMs - lastRunExpectedTick) / 60_000))
    : null;
  return {
    file: workflow.file,
    cron: workflow.cron,
    queryStatus: "OK",
    lastRun: lastRunFields(runs[0]),
    lastSuccess: lastRunFields(lastSuccess),
    lastFailure: lastRunFields(lastFailure),
    activeRuns,
    lastAutomaticRunCreatedAt: lastAutomatic ? lastAutomatic.created_at : null,
    lastAutomaticRunStartedAt: Number.isFinite(lastAutomaticStartedMs)
      ? lastAutomatic.run_started_at
      : null,
    minutesSinceLastAutomaticRunCreated: Number.isFinite(lastAutomaticCreatedMs)
      ? Math.max(0, Math.floor((nowMs - lastAutomaticCreatedMs) / 60_000))
      : null,
    minutesSinceLastAutomaticRunStarted: Number.isFinite(lastAutomaticStartedMs)
      ? Math.max(0, Math.floor((nowMs - lastAutomaticStartedMs) / 60_000))
      : null,
    latestExpectedScheduleTickAt: new Date(latestExpectedTick).toISOString(),
    latestExpectedTickOverdueMinutes,
    lastAutomaticScheduleCreationDelayMinutes: creationDelayMinutes,
    lastAutomaticRunStartDelayMinutes: actualStartDelayMinutes,
    scheduleStartDelayAttribution: "inferred_nearest_cron_tick_before_run_creation",
    missingExpectedScheduleTicksBetweenLatestAutomaticRuns: missingExpectedTicksBetweenRuns,
  };
}

function lastRunFields(run) {
  if (!run) return null;
  return {
    id: run.id ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    event: run.event ?? null,
    createdAt: run.created_at ?? null,
    startedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at ?? null,
    headSha: run.head_sha ?? null,
  };
}

export function createGitHubAppClient(env, {
  fetcher = fetch,
  cryptoImpl = crypto,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const { appId, installationId, privateKeyPem } = validateEnvironment(env);
  let signingKeyPromise;
  let tokenCache;

  async function signingKey() {
    if (!signingKeyPromise) signingKeyPromise = importSigningKey(privateKeyPem, cryptoImpl);
    return signingKeyPromise;
  }

  async function createJwt() {
    const key = await signingKey();
    return signAppJwt({ appId, key, nowMs: now(), cryptoImpl });
  }

  async function accessToken() {
    const nowMs = now();
    if (tokenCache && Date.parse(tokenCache.expiresAt) - nowMs > TOKEN_REFRESH_SKEW_MS) {
      return tokenCache.accessToken;
    }
    const jwt = await createJwt();
    const tokenUrl = API_ORIGIN + "/app/installations/" + installationId + "/access_tokens";
    const { value } = await fetchJson(fetcher, tokenUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + jwt,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({
        repository_ids: [REPOSITORY_ID],
        permissions: { actions: "read" },
      }),
    }, { timeoutMs, maxBytes: MAX_TOKEN_BYTES, stage: "installation_token" });
    if (
      !value ||
      typeof value.token !== "string" ||
      value.token.length < 20 ||
      typeof value.expires_at !== "string" ||
      !Number.isFinite(Date.parse(value.expires_at))
    ) {
      throw new GitHubAppAdapterError("GITHUB_INVALID_TOKEN_RESPONSE", { stage: "installation_token" });
    }
    tokenCache = { accessToken: value.token, expiresAt: value.expires_at };
    return tokenCache.accessToken;
  }

  async function readOneWorkflow(workflow, token) {
    const query = new URLSearchParams({ branch: "main", per_page: "30" });
    const url = API_ORIGIN + REPOSITORY_PATH + "/actions/workflows/" +
      encodeURIComponent(workflow.file) + "/runs?" + query.toString();
    try {
      const { value } = await fetchJson(fetcher, url, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": API_VERSION,
        },
      }, { timeoutMs, maxBytes: MAX_RUNS_BYTES, stage: "workflow_runs" });
      return summarizeWorkflow(workflow, value, now());
    } catch (error) {
      return {
        file: workflow.file,
        cron: workflow.cron,
        queryStatus: "ERROR",
        reasonCode: error.code ?? "GITHUB_UNKNOWN_ERROR",
        httpStatus: error.status ?? null,
        retryAfterSeconds: error.retryAfterSeconds ?? null,
        rateLimitRemaining: error.rateLimitRemaining ?? null,
        rateLimitResetAt: error.rateLimitResetAt ?? null,
      };
    }
  }

  return Object.freeze({
    async getWorkflowSnapshot() {
      const checkedAt = new Date(now()).toISOString();
      let token;
      try {
        token = await accessToken();
      } catch (error) {
        return {
          repository: "RonnsenDD/lhh-data-hub",
          checkedAt,
          queryStatus: "ERROR",
          reasonCode: error.code ?? "GITHUB_UNKNOWN_ERROR",
          httpStatus: error.status ?? null,
          retryAfterSeconds: error.retryAfterSeconds ?? null,
          rateLimitRemaining: error.rateLimitRemaining ?? null,
          rateLimitResetAt: error.rateLimitResetAt ?? null,
          workflows: WORKFLOWS.map(({ file, cron }) => ({ file, cron, queryStatus: "SKIPPED_AUTH_FAILURE" })),
        };
      }
      const workflows = await Promise.all(WORKFLOWS.map((workflow) => readOneWorkflow(workflow, token)));
      return {
        repository: "RonnsenDD/lhh-data-hub",
        checkedAt,
        queryStatus: workflows.every((workflow) => workflow.queryStatus === "OK") ? "OK" : "PARTIAL",
        workflows,
      };
    },
  });
}

export const adapterConstants = Object.freeze({
  apiOrigin: API_ORIGIN,
  repositoryPath: REPOSITORY_PATH,
  repositoryId: REPOSITORY_ID,
  apiVersion: API_VERSION,
  tokenRefreshSkewMs: TOKEN_REFRESH_SKEW_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});



