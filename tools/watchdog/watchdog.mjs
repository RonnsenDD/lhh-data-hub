export const SOURCE_CONFIG = [
  {
    id: "weather",
    name: "Wetter",
    workflow: "update-dwd-weather.yml",
    producerJob: "update-weather",
    kind: "weather",
    dataUrls: ["https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/dwd-weather.json"],
    publicationPaths: ["data/generated/dwd-weather.json"],
    cadenceMinutes: 15,
    maxScheduleGapMinutes: 20,
    dispatchCooldownMinutes: 60,
    maxPublicationAgeMinutes: 45,
  },
  {
    id: "levels",
    name: "Pegel Lauchhammer und Biehlen 1",
    workflow: "update-levels.yml",
    producerJob: "update",
    kind: "levels",
    dataUrls: [
      "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-lauchhammer.json",
      "https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/pegel-biehlen-1.json",
    ],
    publicationPaths: [
      "data/generated/pegel-lauchhammer.json",
      "data/generated/pegel-biehlen-1.json",
    ],
    cadenceMinutes: 15,
    maxScheduleGapMinutes: 20,
    dispatchCooldownMinutes: 60,
    maxPublicationAgeMinutes: 45,
  },
  {
    id: "radar",
    name: "RADOLAN-RY und KONRAD3D",
    workflow: "update-radolan-ry.yml",
    producerJob: "publish",
    kind: "radar",
    dataUrls: [
      "https://ronnsendd.github.io/lhh-data-hub/radar/latest.json",
      "https://ronnsendd.github.io/lhh-data-hub/konrad3d/latest.json",
    ],
    publicationPaths: [],
    cadenceMinutes: 15,
    maxScheduleGapMinutes: 20,
    dispatchCooldownMinutes: 60,
    maxPublicationAgeMinutes: 45,
  },
  {
    id: "grassland",
    name: "Graslandfeuerindex",
    workflow: "update-graslandfeuerindex.yml",
    producerJob: "update",
    kind: "grassland",
    dataUrls: ["https://raw.githubusercontent.com/RonnsenDD/lhh-data-hub/main/data/generated/graslandfeuerindex.json"],
    publicationPaths: ["data/generated/graslandfeuerindex.json"],
    cadenceMinutes: 1440,
    maxScheduleGapMinutes: 1500,
    dispatchCooldownMinutes: 360,
    maxPublicationAgeMinutes: 30 * 60,
  },
];

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

function parseTime(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function ageMinutes(value, nowMs) {
  const timestamp = parseTime(value);
  if (timestamp === null) return null;
  return Math.max(0, (nowMs - timestamp) / 60000);
}

function maxAge(items, nowMs) {
  const ages = items.map((item) => ageMinutes(item.time, nowMs));
  if (ages.some((age) => age === null)) {
    return { error: "Zeitstempel fehlt oder ist ungültig", ageMinutes: null };
  }
  return { ageMinutes: Math.max(...ages), error: null };
}

function evaluateWeather(data, nowMs) {
  if (!data || typeof data !== "object" || !data.observations || !data.forecast) {
    return { state: "Abruf fehlgeschlagen", reason: "Wetterdatenstruktur unvollständig", sourceAgeMinutes: null };
  }
  const items = [];
  for (const [key, item] of Object.entries(data.observations)) {
    if (!item || ["error", "unavailable"].includes(item.status)) {
      return { state: "Abruf fehlgeschlagen", reason: "Beobachtung " + key + " meldet " + (item?.status || "keinen Status"), sourceAgeMinutes: null };
    }
    const threshold = Number(item.freshnessThresholdMinutes || 60);
    items.push({ time: item.measuredAt, threshold, label: key });
  }
  const forecast = data.forecast;
  if (["error", "unavailable"].includes(forecast.status)) {
    return { state: "Abruf fehlgeschlagen", reason: "DWD-Vorhersage meldet " + forecast.status, sourceAgeMinutes: null };
  }
  items.push({ time: forecast.issuedAt, threshold: 12 * 60, label: "MOSMIX" });
  const measured = maxAge(items, nowMs);
  if (measured.error) {
    return { state: "Abruf fehlgeschlagen", reason: measured.error, sourceAgeMinutes: null };
  }
  const tooOld = items.find((item) => {
    const age = ageMinutes(item.time, nowMs);
    return age > item.threshold;
  });
  if (tooOld || data.status === "stale") {
    return { state: "veraltet", reason: tooOld ? tooOld.label + " überschreitet " + tooOld.threshold + " Minuten" : (data.statusReason || "Feed als stale markiert"), sourceAgeMinutes: measured.ageMinutes };
  }
  if (data.status !== "ok") {
    return { state: "Abruf fehlgeschlagen", reason: "Unbekannter Wetterfeed-Status: " + String(data.status), sourceAgeMinutes: measured.ageMinutes };
  }
  return { state: "aktuell", reason: "Quelldaten innerhalb ihrer Frischegrenzen", sourceAgeMinutes: measured.ageMinutes };
}

function evaluateLevels(dataList, nowMs) {
  const items = [];
  for (const data of dataList) {
    if (!data || !data.latestMeasurement || ["error", "unavailable"].includes(data.status)) {
      return { state: "Abruf fehlgeschlagen", reason: "Pegelantwort oder letzter Messwert fehlt", sourceAgeMinutes: null };
    }
    const time = data.latestMeasurement.measuredAtUtc || data.latestMeasurement.measuredAt;
    const threshold = Number(data.freshnessThresholdMinutes || 45);
    if (data.status !== "ok" && data.status !== "stale") {
      return { state: "Abruf fehlgeschlagen", reason: "Unbekannter Pegelstatus: " + String(data.status), sourceAgeMinutes: null };
    }
    items.push({ time, threshold, label: data.station || "Pegel" });
  }
  const measured = maxAge(items, nowMs);
  if (measured.error) {
    return { state: "Abruf fehlgeschlagen", reason: measured.error, sourceAgeMinutes: null };
  }
  const tooOld = items.find((item) => ageMinutes(item.time, nowMs) > item.threshold);
  if (tooOld || dataList.some((data) => data.status === "stale")) {
    return { state: "veraltet", reason: tooOld ? tooOld.label + " überschreitet " + tooOld.threshold + " Minuten" : "Pegelquelle meldet stale", sourceAgeMinutes: measured.ageMinutes };
  }
  return { state: "aktuell", reason: "Beide Messstellen innerhalb ihrer Frischegrenzen", sourceAgeMinutes: measured.ageMinutes };
}

function evaluateRadar(manifests, nowMs) {
  const products = [];
  for (const manifest of manifests) {
    if (!manifest || manifest.status === "unavailable") {
      return { state: "Abruf fehlgeschlagen", reason: "Radar-Manifest nicht verfügbar", sourceAgeMinutes: null };
    }
    if (!["current", "stale"].includes(manifest.status)) {
      return { state: "Abruf fehlgeschlagen", reason: "Unbekannter Radarstatus", sourceAgeMinutes: null };
    }
    const time = manifest.productTime || manifest.referenceTime;
    if (!time || !manifest.publishedAt) {
      return { state: "Abruf fehlgeschlagen", reason: "Produkt- oder Veröffentlichungszeit fehlt", sourceAgeMinutes: null };
    }
    products.push({ time, threshold: 15, label: manifest.product || "Radarprodukt" });
  }
  const measured = maxAge(products, nowMs);
  if (measured.error) {
    return { state: "Abruf fehlgeschlagen", reason: measured.error, sourceAgeMinutes: null };
  }
  const tooOld = products.find((product) => ageMinutes(product.time, nowMs) > product.threshold);
  if (tooOld || manifests.some((manifest) => manifest.status === "stale")) {
    return { state: "veraltet", reason: tooOld ? tooOld.label + " älter als 15 Minuten" : "Radar-Manifest meldet stale", sourceAgeMinutes: measured.ageMinutes };
  }
  return { state: "aktuell", reason: "Produktzeitpunkte innerhalb von 15 Minuten", sourceAgeMinutes: measured.ageMinutes };
}

function berlinDate(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return value.year + "-" + value.month + "-" + value.day;
}

function evaluateGrassland(data, nowMs) {
  if (!data || !data.source || !data.today || ["error", "unavailable"].includes(data.status)) {
    return { state: "Abruf fehlgeschlagen", reason: "GLFI-Feed unvollständig oder mit Fehlerstatus", sourceAgeMinutes: null };
  }
  const sourceTime = data.source.dataAsOf || data.source.lastModifiedAt;
  const age = ageMinutes(sourceTime, nowMs);
  if (age === null) {
    return { state: "Abruf fehlgeschlagen", reason: "DWD-Produktzeitpunkt fehlt oder ist ungültig", sourceAgeMinutes: null };
  }
  const today = berlinDate(nowMs);
  if (data.today.date !== today || age > 36 * 60 || data.status === "stale") {
    return {
      state: "veraltet",
      reason: data.today.date !== today ? "Prognose für heute (" + today + ") fehlt" : "DWD-Prognose älter als 36 Stunden oder als stale markiert",
      sourceAgeMinutes: age,
    };
  }
  if (data.status !== "ok") {
    return { state: "Abruf fehlgeschlagen", reason: "Unbekannter GLFI-Status: " + String(data.status), sourceAgeMinutes: age };
  }
  return { state: "aktuell", reason: "DWD-Prognose für den heutigen Tag vorhanden", sourceAgeMinutes: age };
}

function evaluateData(source, payloads, nowMs) {
  if (source.kind === "weather") return evaluateWeather(payloads[0], nowMs);
  if (source.kind === "levels") return evaluateLevels(payloads, nowMs);
  if (source.kind === "radar") return evaluateRadar(payloads, nowMs);
  if (source.kind === "grassland") return evaluateGrassland(payloads[0], nowMs);
  return { state: "Abruf fehlgeschlagen", reason: "Unbekannter Quellentyp", sourceAgeMinutes: null };
}

async function requestJson(fetcher, url, headers) {
  const response = await fetcher(url, { headers, redirect: "follow", signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    const error = new Error("HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function githubJson(fetcher, url, token) {
  return requestJson(fetcher, url, apiHeaders(token));
}

async function getPublicationTimes(source, fetcher, token, owner, repo) {
  if (source.publicationPaths.length === 0) return source.dataUrls.map((path, index) => ({ path, publishedAt: null, manifestPublishedAt: null, payloadIndex: index }));
  const times = [];
  for (const path of source.publicationPaths) {
    const url = API_BASE + "/repos/" + owner + "/" + repo + "/commits?path=" + encodeURIComponent(path) + "&sha=main&per_page=1";
    const commits = await githubJson(fetcher, url, token);
    const date = commits[0]?.commit?.committer?.date || commits[0]?.commit?.author?.date || null;
    times.push({ path, publishedAt: date });
  }
  return times;
}

async function getWorkflowState(source, fetcher, token, owner, repo, nowMs) {
  const url = API_BASE + "/repos/" + owner + "/" + repo + "/actions/workflows/" + encodeURIComponent(source.workflow) + "/runs?branch=main&per_page=100";
  const body = await githubJson(fetcher, url, token);
  if (!Array.isArray(body.workflow_runs)) throw new Error("GitHub workflow-runs-Antwort ungültig");
  const runs = body.workflow_runs;
  const byNewest = (left, right) => (parseTime(right.run_started_at || right.created_at) || 0) - (parseTime(left.run_started_at || left.created_at) || 0);
  const latestScheduled = runs.filter((run) => run.event === "schedule").sort(byNewest)[0] || null;
  const latestProducerRun = runs.filter((run) => ["schedule", "workflow_dispatch"].includes(run.event)).sort(byNewest)[0] || null;
  const activeRuns = runs.filter((run) => run.status !== "completed");
  const runForJobs = latestProducerRun;
  let producerConclusion = null;
  let auditConclusion = null;
  let jobsError = null;
  if (runForJobs) {
    try {
      const jobs = await githubJson(fetcher, API_BASE + "/repos/" + owner + "/" + repo + "/actions/runs/" + runForJobs.id + "/jobs?per_page=100", token);
      const jobList = Array.isArray(jobs.jobs) ? jobs.jobs : [];
      const producer = jobList.find((job) => job.name === source.producerJob);
      const audit = jobList.find((job) => /schedule health/i.test(job.name));
      producerConclusion = producer?.conclusion || (producer?.status === "completed" ? "missing" : null);
      auditConclusion = audit?.conclusion || null;
      if (!producer && runForJobs.status === "completed") producerConclusion = "missing";
    } catch (error) {
      jobsError = "Jobstatus nicht lesbar (HTTP/API-Fehler)";
    }
  }
  const scheduledAt = latestScheduled ? (latestScheduled.run_started_at || latestScheduled.created_at) : null;
  const scheduledAge = ageMinutes(scheduledAt, nowMs);
  const scheduleFailed = !latestScheduled || scheduledAge === null || scheduledAge > source.maxScheduleGapMinutes;
  const producerFailed = producerConclusion !== null && producerConclusion !== "success";
  return {
    runsChecked: runs.length,
    latestScheduledRun: latestScheduled ? {
      id: latestScheduled.id,
      createdAt: latestScheduled.created_at,
      startedAt: latestScheduled.run_started_at,
      conclusion: latestScheduled.conclusion,
      ageMinutes: scheduledAge,
    } : null,
    latestProducerRun: latestProducerRun ? {
      id: latestProducerRun.id,
      event: latestProducerRun.event,
      createdAt: latestProducerRun.created_at,
      startedAt: latestProducerRun.run_started_at,
      conclusion: latestProducerRun.conclusion,
    } : null,
    activeRunIds: activeRuns.map((run) => run.id),
    producerConclusion,
    auditConclusion,
    jobsError,
    scheduleFailed,
    producerFailed,
    apiHealthy: true,
  };
}

function combineStatus(source, dataState, workflowState, apiFailure) {
  if (apiFailure) return { status: "Abruf fehlgeschlagen", reason: apiFailure };
  if (workflowState.producerFailed) return { status: "Abruf fehlgeschlagen", reason: "Letzter Produzentenjob endete mit " + workflowState.producerConclusion };
  if (dataState.state === "Abruf fehlgeschlagen") return { status: dataState.state, reason: dataState.reason };
  if (workflowState.scheduleFailed) {
    return { status: "Automatik ausgefallen", reason: workflowState.latestScheduledRun ? "Letzter geplanter Lauf älter als " + source.maxScheduleGapMinutes + " Minuten" : "Noch kein geplanter Lauf nachgewiesen" };
  }
  if (dataState.state === "veraltet") return { status: "veraltet", reason: dataState.reason };
  if (workflowState.jobsError) return { status: "Abruf fehlgeschlagen", reason: workflowState.jobsError };
  const publicationProblem = workflowState.publicationProblem;
  if (publicationProblem) return { status: "Abruf fehlgeschlagen", reason: publicationProblem };
  return { status: "aktuell", reason: dataState.reason };
}

async function inspectSource(source, context) {
  const payloads = [];
  let dataFailure = null;
  for (const url of source.dataUrls) {
    try {
      payloads.push(await requestJson(context.fetcher, url, { Accept: "application/json", "Cache-Control": "no-cache" }));
    } catch (error) {
      dataFailure = "Datenfeed konnte nicht gelesen werden (" + (error.status ? "HTTP " + error.status : "Netzwerkfehler") + ")";
      break;
    }
  }
  let workflowState = {
    runsChecked: 0,
    latestScheduledRun: null,
    latestProducerRun: null,
    activeRunIds: [],
    producerConclusion: null,
    auditConclusion: null,
    jobsError: null,
    scheduleFailed: true,
    producerFailed: false,
    apiHealthy: false,
  };
  let apiFailure = null;
  if (!context.token) {
    apiFailure = "GitHub-Tokenbinding fehlt; Workflowhistorie kann nicht sicher geprüft werden";
  } else {
    try {
      workflowState = await getWorkflowState(source, context.fetcher, context.token, context.owner, context.repo, context.nowMs);
    } catch (error) {
      apiFailure = error.status ? "GitHub API nicht verfügbar (HTTP " + error.status + ")" : "GitHub API nicht verfügbar (Netzwerkfehler)";
    }
  }
  const dataState = dataFailure
    ? { state: "Abruf fehlgeschlagen", reason: dataFailure, sourceAgeMinutes: null }
    : evaluateData(source, payloads, context.nowMs);
  let publicationTimes;
  if (source.kind === "radar") {
    publicationTimes = payloads.map((item, index) => ({ path: source.dataUrls[index], publishedAt: item?.publishedAt || null }));
  } else if (!apiFailure) {
    try {
      publicationTimes = await getPublicationTimes(source, context.fetcher, context.token, context.owner, context.repo);
    } catch (error) {
      apiFailure = error.status ? "GitHub-Veröffentlichungszeit nicht lesbar (HTTP " + error.status + ")" : "GitHub-Veröffentlichungszeit nicht lesbar (Netzwerkfehler)";
      publicationTimes = [];
    }
  } else {
    publicationTimes = [];
  }
  publicationTimes = publicationTimes.map((item) => ({ ...item, ageMinutes: ageMinutes(item.publishedAt, context.nowMs) }));
  workflowState.publicationProblem = publicationTimes.some((item) => item.ageMinutes === null)
    ? "Veröffentlichungszeit fehlt oder ist ungültig"
    : publicationTimes.some((item) => item.ageMinutes > source.maxPublicationAgeMinutes)
      ? "Letzte Veröffentlichung älter als " + source.maxPublicationAgeMinutes + " Minuten"
      : null;
  const combined = combineStatus(source, dataState, workflowState, apiFailure);
  return {
    id: source.id,
    name: source.name,
    status: combined.status,
    reason: combined.reason,
    dataStatus: dataState.state,
    dataReason: dataState.reason,
    sourceAgeMinutes: dataState.sourceAgeMinutes,
    workflow: {
      file: source.workflow,
      cadenceMinutes: source.cadenceMinutes,
      maxScheduleGapMinutes: source.maxScheduleGapMinutes,
      latestScheduledRun: workflowState.latestScheduledRun,
      latestProducerRun: workflowState.latestProducerRun,
      producerJobConclusion: workflowState.producerConclusion,
      scheduleAuditConclusion: workflowState.auditConclusion,
      scheduleAuditIsSeparate: true,
      activeRunIds: workflowState.activeRunIds,
      apiHealthy: workflowState.apiHealthy,
      error: apiFailure || workflowState.jobsError,
    },
    publicationTimes,
    observedAt: new Date(context.nowMs).toISOString(),
    _internal: { source, workflowState, apiFailure, dataFailure },
  };
}

async function dispatchWorkflow(source, context) {
  const url = API_BASE + "/repos/" + context.owner + "/" + context.repo + "/actions/workflows/" + encodeURIComponent(source.workflow) + "/dispatches";
  const response = await context.fetcher(url, {
    method: "POST",
    signal: AbortSignal.timeout(4000),
    headers: {
      ...apiHeaders(context.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (response.status !== 204) {
    const error = new Error("workflow_dispatch HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
}

export async function runWatchdog(options) {
  const nowMs = options.nowMs ?? Date.now();
  const fetcher = options.fetcher || fetch;
  const storage = options.storage;
  const owner = options.owner || "RonnsenDD";
  const repo = options.repo || "lhh-data-hub";
  const token = options.token || "";
  const context = { nowMs, fetcher, storage, owner, repo, token };
  const results = [];

  const inspected = await Promise.all(SOURCE_CONFIG.map(async (source) => {
    const result = await inspectSource(source, context);
    const workflowState = result._internal.workflowState;
    let dispatch = { state: "not-needed", reason: null };
    const recoverable = result.status !== "aktuell";
    if (recoverable && !result._internal.apiFailure && workflowState.apiHealthy && !workflowState.jobsError) {
      if (workflowState.activeRunIds.length > 0) {
        dispatch = { state: "skipped-running", reason: "Ein Workflowlauf ist bereits aktiv" };
      } else {
        const key = "lastDispatch:" + source.id;
        const lastDispatch = await storage.get(key);
        const lastDispatchMs = parseTime(lastDispatch);
        const cooldownMs = source.dispatchCooldownMinutes * 60000;
        if (lastDispatchMs !== null && nowMs - lastDispatchMs < cooldownMs) {
          dispatch = { state: "skipped-cooldown", reason: "Abklingzeit noch nicht abgelaufen", lastDispatchAt: lastDispatch };
        } else {
          // Persist before dispatch: a timeout after GitHub accepted the request must not cause a retry loop.
          const attemptedAt = new Date(nowMs).toISOString();
          await storage.put(key, attemptedAt);
          try {
            await dispatchWorkflow(source, context);
            dispatch = { state: "requested", requestedAt: attemptedAt, note: "Auslösung bestätigt; dies ist kein Erfolgsnachweis der Datenaktualisierung" };
          } catch (error) {
            dispatch = { state: "failed", attemptedAt, reason: error.status ? "GitHub workflow_dispatch lehnte ab (HTTP " + error.status + ")" : "GitHub workflow_dispatch Netzwerkfehler" };
          }
        }
      }
    }
    result.dispatch = dispatch;
    delete result._internal;
    console.log(JSON.stringify({ type: "watchdog-source", ...result }));
    return result;
  }));
  results.push(...inspected);

  const report = {
    schemaVersion: 1,
    checkedAt: new Date(nowMs).toISOString(),
    repository: owner + "/" + repo,
    sources: results,
    note: "workflow_dispatch-Annahme und Datenproducer-Erfolg werden getrennt bewertet.",
  };
  await storage.put("latestReport", report);
  return report;
}

export { evaluateData };
