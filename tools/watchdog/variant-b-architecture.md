# Variant-B dispatcher prototype (not deployable as-is)

This branch contains a pure candidate gate for a future internal Monitor -> Dispatcher split. It is deliberately not a Cloudflare Worker entry point and cannot call GitHub, Cloudflare storage, or any network service. It is not connected to the existing Worker and is not deployed.

## Boundary

- The Monitor retains the current feed checks and computes freshness from actual measurement/product timestamps.
- It may forward a small allowlisted candidate to a Dispatcher through a Cloudflare Service Binding only after successful source retrieval and an actually stale source time.
- The Dispatcher has no public route or `workers.dev` hostname. Only its service binding is configured on the Monitor.
- Only the Dispatcher receives the GitHub App private-key secret. Installation tokens should be repository-scoped and limited to Actions permission. Actions write permission is repository-level; workflow allowlisting is enforced in code, not by a per-workflow GitHub permission.
- Before dispatch, require successful source checks, valid timestamps, an inactive workflow, clear cooldown, available daily quota, and an acquired single-flight lease. Any unavailable guard or ambiguous GitHub response fails closed. A timed-out dispatch is uncertain and must not be retried automatically.
- DWD observations use a 45-minute freshness limit. MOSMIX uses its model issue time with a separate 12-hour limit and must have at least one usable forecast point. RADOLAN-RY and KONRAD3D each use 15 minutes and map to one radar workflow candidate. A component's retrieval time and `derivedAt` are never freshness inputs.
- A failed or unavailable component blocks a candidate rather than dispatching based on partial information.
- The prototype's only positive output is `candidate_only`; it contains no dispatch implementation or secrets.

## Local check

Run:

```sh
node --test dispatcher-prototype.test.mjs
```

This validates the pure decision gate only. It does not establish live Cloudflare CPU, API, lock, or end-to-end dispatch behavior. Existing PR #17 tests and Cloudflare telemetry are separate evidence.

## Cost and limit notes

A Service Binding adds no request fee in Workers Standard pricing, but its internal invocation is a subrequest and CPU from both Workers is aggregated for the invocation. It therefore separates credentials and code, not the 10-ms CPU budget. A separate Dispatcher Cron would isolate the invocation but repeat source checks unless state is safely handed over; it would consume another Cron slot and is not implemented here.
