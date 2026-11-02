const WORKFLOWS = Object.freeze({
  weather: "update-dwd-weather.yml",
  radar: "update-radolan-ry.yml",
});

const FRESHNESS_MS = Object.freeze({ weather: 45 * 60_000, radar: 15 * 60_000 });
const MAX_CLOCK_SKEW_MS = 2 * 60_000;

function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pure, side-effect-free prototype for the internal Monitor -> Dispatcher handoff.
 * It deliberately cannot call GitHub, Cloudflare storage, or any network endpoint.
 */
export function planInternalDispatch(input, now = Date.now()) {
  const blocked = (reason) => ({ action: "none", reason });

  if (!input || typeof input !== "object" || Array.isArray(input)) return blocked("invalid_input");
  const { source, fetchStatus, sourceTimes, workflowActive, cooldownClear, quotaAvailable, leaseAcquired } = input;
  if (typeof source !== "string" || !Object.hasOwn(WORKFLOWS, source)) return blocked("source_not_allowlisted");
  if (!Number.isFinite(now)) return blocked("clock_invalid");
  if (fetchStatus !== "success") return blocked("source_fetch_not_successful");
  if (!Array.isArray(sourceTimes) || sourceTimes.length === 0) return blocked("source_time_missing");
  if (sourceTimes.length > 10) return blocked("source_time_count_invalid");
  if (![workflowActive, cooldownClear, quotaAvailable, leaseAcquired].every((v) => typeof v === "boolean")) {
    return blocked("guard_state_incomplete");
  }

  const parsed = sourceTimes.map(validTimestamp);
  if (parsed.some((time) => time === null)) return blocked("source_time_invalid");
  if (parsed.some((time) => time > now + MAX_CLOCK_SKEW_MS)) return blocked("source_time_in_future");

  // Weather uses the oldest required actual measurement time; radar groups
  // RADOLAN-RY and KONRAD3D into one candidate.
  const oldestSourceTime = Math.min(...parsed);
  const ageMs = now - oldestSourceTime;
  const limitMs = FRESHNESS_MS[source];
  if (ageMs <= limitMs) return { action: "none", reason: "source_current", ageMs };
  if (workflowActive) return { action: "none", reason: "workflow_already_active", ageMs };
  if (!cooldownClear) return { action: "none", reason: "cooldown", ageMs };
  if (!quotaAvailable) return { action: "none", reason: "daily_quota", ageMs };
  if (!leaseAcquired) return { action: "none", reason: "lease_not_acquired", ageMs };

  return {
    action: "candidate_only",
    workflow: WORKFLOWS[source],
    source,
    ageMs,
    sourceTime: new Date(oldestSourceTime).toISOString(),
    note: "No dispatch is performed by this prototype.",
  };
}

export const dispatcherPrototypeConfig = Object.freeze({
  publicRoute: false,
  dispatchEnabledByDefault: false,
  allowedWorkflows: Object.freeze(Object.values(WORKFLOWS)),
  requires: Object.freeze(["successful_source_fetch", "valid_source_time", "inactive_workflow", "cooldown_clear", "quota_available", "lease_acquired"]),
});
