import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/cpu-test-worker.js";

test("isolated test endpoint returns disabled without reading inputs or making requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected-network-request"); };
  try {
    const response = await worker.fetch(new Request("https://test.invalid/cpu-test?mode=dispatch", {
      method: "POST",
      headers: { authorization: "Bearer should-not-be-read" },
      body: "WEATHER_DISPATCH_MODE=dispatch",
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.dispatch, false);
    assert.equal(result.reason, "disabled");
    assert.equal(result.errorStatus, "none");
    assert.ok(Number.isFinite(Date.parse(result.decisionTime)));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all non-POST or non-test paths are unavailable", async () => {
  for (const request of [
    new Request("https://test.invalid/", { method: "GET" }),
    new Request("https://test.invalid/cpu-test", { method: "GET" }),
    new Request("https://test.invalid/dispatch", { method: "POST" }),
  ]) {
    assert.equal((await worker.fetch(request)).status, 404);
  }
});
