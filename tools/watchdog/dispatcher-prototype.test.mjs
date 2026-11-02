import test from "node:test";
import assert from "node:assert/strict";
import { dispatcherPrototypeConfig, planInternalDispatch } from "./dispatcher-prototype.mjs";

const now = Date.parse("2026-11-02T00:00:00Z");
const t = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const guards = { workflowActive: false, cooldownClear: true, quotaAvailable: true, leaseAcquired: true };
const input = (overrides = {}) => ({ source: "weather", fetchStatus: "success", sourceTimes: [t(50), t(20)], ...guards, ...overrides });

test("prototype is private/default-off and allowlists fixed workflows", () => {
  assert.equal(dispatcherPrototypeConfig.publicRoute, false);
  assert.equal(dispatcherPrototypeConfig.dispatchEnabledByDefault, false);
  assert.deepEqual(dispatcherPrototypeConfig.allowedWorkflows, ["update-dwd-weather.yml", "update-radolan-ry.yml"]);
});

test("fresh weather produces no candidate using source measurement time", () => {
  assert.equal(planInternalDispatch(input({ sourceTimes: [t(20), t(10)] }), now).reason, "source_current");
});

test("stale weather produces only an allowlisted candidate, never a network dispatch", () => {
  const result = planInternalDispatch(input(), now);
  assert.equal(result.action, "candidate_only");
  assert.equal(result.workflow, "update-dwd-weather.yml");
  assert.equal(result.sourceTime, t(50));
});

test("RADOLAN-RY and KONRAD3D are grouped into one radar workflow candidate", () => {
  const result = planInternalDispatch(input({ source: "radar", sourceTimes: [t(20), t(40)] }), now);
  assert.equal(result.workflow, "update-radolan-ry.yml");
  assert.equal(result.sourceTime, t(40));
});

test("failed or unavailable source never creates a candidate", () => {
  for (const fetchStatus of ["error", "unavailable", "unknown"]) {
    assert.equal(planInternalDispatch(input({ fetchStatus }), now).reason, "source_fetch_not_successful");
  }
});

test("missing, malformed, or future source timestamps fail closed", () => {
  assert.equal(planInternalDispatch(input({ sourceTimes: [] }), now).reason, "source_time_missing");
  assert.equal(planInternalDispatch(input({ sourceTimes: ["bad"] }), now).reason, "source_time_invalid");
  assert.equal(planInternalDispatch(input({ sourceTimes: [new Date(now + 5 * 60_000).toISOString()] }), now).reason, "source_time_in_future");
});

test("unknown sources and incomplete guard state fail closed", () => {
  assert.equal(planInternalDispatch(input({ source: "anything" }), now).reason, "source_not_allowlisted");
  assert.equal(planInternalDispatch(input({ source: "__proto__" }), now).reason, "source_not_allowlisted");
  assert.equal(planInternalDispatch(input({ sourceTimes: Array(11).fill(t(50)) }), now).reason, "source_time_count_invalid");
  assert.equal(planInternalDispatch(input({ leaseAcquired: undefined }), now).reason, "guard_state_incomplete");
  assert.equal(planInternalDispatch(input(), Number.NaN).reason, "clock_invalid");
});

test("active workflow, cooldown, quota, and lease each block a candidate", () => {
  for (const [key, value, expected] of [
    ["workflowActive", true, "workflow_already_active"],
    ["cooldownClear", false, "cooldown"],
    ["quotaAvailable", false, "daily_quota"],
    ["leaseAcquired", false, "lease_not_acquired"],
  ]) assert.equal(planInternalDispatch(input({ [key]: value }), now).reason, expected);
});
