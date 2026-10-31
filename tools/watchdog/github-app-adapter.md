# GitHub App read-only adapter for Watchdog V3

## Status and safety

The adapter is imported by `worker.js` but only called from the scheduled handler when `GITHUB_APP_READ_ENABLED` is exactly the string `"true"`. The setting is absent/off by default. Public HTTP status requests never call it. It does not alter the seven-feed V2 freshness path or create a public endpoint. This PR does not deploy anything or configure secrets.

The adapter has no dispatch, workflow-write, repository-write, or permission-management operation. Its only GitHub API operations are:
- one `POST /app/installations/{installation_id}/access_tokens` to obtain a token restricted to this repository and `actions: read`;
- `GET` requests for the fixed five workflow-run endpoints listed below. Each query requests at most 30 recent runs and rejects response bodies larger than 128 KiB; an oversized response affects only that workflow summary.

The token endpoint POST creates a short-lived credential; it does **not** modify a repository or start a workflow. Workflow reads are isolated by workflow, so a 403/429/5xx/timeout for one run-list query does not change public-feed evaluation or prevent the other workflow summaries.

GitHub's [JWT guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) sets RS256 and limits JWT expiry to ten minutes. Installation access tokens expire after one hour and can be narrowed by repository and permissions ([installation-token API](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10)). This adapter uses a 9-minute JWT lifetime with a 60-second clock-skew allowance and refreshes a cached installation token when fewer than five minutes remain. The cache exists only within a client instance; no token is persisted between Worker invocations.

## Fixed scope

Repository: `RonnsenDD/lhh-data-hub` (repository ID `1424581788`).

The adapter queries only these existing workflows on `main`:

| Workflow file | Expected UTC schedule |
| --- | --- |
| `update-dwd-weather.yml` | `3,18,33,48 * * * *` |
| `update-levels.yml` | `11,26,41,56 * * * *` |
| `update-radolan-ry.yml` | `7,22,37,52 * * * *` |
| `update-graslandfeuerindex.yml` | `15 5 * * *` |
| `update-waldbrandgefahrenstufe-osl.yml` | `20 7 * * *` |

These values were checked against `main` at `762c4a9d41ebc6aca3594810a7f84901a9bfc57d`. Recheck the workflow files before deploying, since schedules can change.

The schedule fields keep separate clocks and meanings:
- `lastAutomaticRunCreatedAt` / `minutesSinceLastAutomaticRunCreated`: age of the scheduled run record from GitHub's `created_at`.
- `lastAutomaticRunStartedAt` / `minutesSinceLastAutomaticRunStarted`: actual runner start from `run_started_at`; these remain null while a run is only queued.
- `latestExpectedScheduleTickAt` and `latestExpectedTickOverdueMinutes`: the latest nominal Cron tick and how long that tick is overdue **if no scheduled run has been created at or after it**. This is not the age of the last run.
- `lastAutomaticScheduleCreationDelayMinutes` and `lastAutomaticRunStartDelayMinutes`: differences from the nearest nominal Cron tick at or before the latest run's `created_at`. The attribution is explicitly marked `inferred_nearest_cron_tick_before_run_creation` because GitHub's runs API does not expose the intended occurrence timestamp.
- `missingExpectedScheduleTicksBetweenLatestAutomaticRuns`: estimated missing Cron ticks between the previous scheduled run and the latest run's inferred tick; null when there is no prior run or the bounded calculation cannot determine it.

This makes run age, current overdue time, inferred start delay, and missed ticks independently inspectable. Workflow success remains separate metadata: it never upgrades the seven public feed freshness states.

## Cloudflare Free budget estimate

Cloudflare documents a Free limit of 100,000 Worker requests/day, 10 ms CPU per HTTP or Cron invocation, 50 external subrequests per invocation, and up to five Cron triggers/account ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

When `GITHUB_APP_READ_ENABLED=true`, each existing five-minute Cron invocation performs one read cycle; otherwise the integration adds zero GitHub requests and zero signing CPU:
- 288 invocations/day;
- six GitHub HTTP requests per enabled cycle (one token request plus five workflow run queries), approximately 1,728 GitHub requests/day or 72/hour averaged across the day;
- with the existing seven public-feed requests, 13 outbound requests in the normal case. With the adapter's one-hop maximum on GitHub redirects and the feed reader's existing three-hop bound, the conservative combined upper bound is 40 outbound requests—below 50.
- run-list reads are capped at 30 runs / 128 KiB each to bound JSON parsing and memory. A larger response is marked as an isolated per-workflow error.

GitHub documents a minimum 5,000 REST requests/hour for an installation token ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)); the estimate is far below that primary limit. GitHub secondary limits and transient API failures remain possible and are handled without retries or dispatch loops.

A local Node benchmark (50 ephemeral 2048-bit test-key JWT operations, including key import on every operation) measured about 0.66 ms process CPU per operation. This is a conservative local reference, **not** a Cloudflare CPU measurement. The Worker adapter caches its imported key during a client lifetime, but Cloudflare's 10 ms limit must be verified from actual Worker invocation metrics after a separately approved live integration. Network waiting time is not Worker CPU time.

## Reproducible single-file deployment artifact

The production source uses a static ES-module import. For the existing Cloudflare dashboard editor workflow, the repository also provides a generated single-file ES-module artifact at `tools/watchdog/worker.bundle.js`. The build tool uses Node.js built-ins only: it wraps the adapter in a private closure and keeps the Worker `export default` entrypoint. It adds no npm packages, account resources, bindings, routes, or Cron triggers. The bundle contains no credentials and works when all GitHub App variables and secrets are absent because the read flag defaults off.

From the repository root, regenerate and verify the exact artifact:

```sh
node tools/watchdog/build-editor-bundle.mjs
node --check tools/watchdog/worker.bundle.js
node tools/watchdog/build-editor-bundle.mjs --check
node --test tools/watchdog/*.test.mjs
shasum -a 256 tools/watchdog/worker.bundle.js
```

The test suite loads the generated bundle itself as an ES module, calls its actual `/status` and scheduled handlers with mocked feeds, verifies all seven feeds remain present, and confirms no GitHub API call occurs with the flag off and no secrets configured. It never contacts Cloudflare or GitHub.

### Manual Cloudflare editor procedure (after release approval)

1. Generate the bundle and run all checks above. Confirm the source hash in its generated header and the file checksum recorded for the reviewed release.
2. In **Workers & Pages** → `feuerwehr-lauchhammer-watchdog` → **Edit code**, replace the entire editor content with `tools/watchdog/worker.bundle.js`. This is the single module script; do not paste only `worker.js` or add a second module.
3. Keep `GITHUB_APP_READ_ENABLED` unset or `false`; do not add App variables or a private-key Secret for this first deployment. Save/deploy only through the operator's approved Cloudflare workflow.
4. Verify the existing Cron is still exactly `*/5 * * * *`; do not create another trigger. Read-only GET `/status` must still report seven feeds. After one scheduled run, its existing feed log must include all seven sources and there must be no GitHub workflow-observation event while the flag is off.

This is a manual release procedure, not an automated deployment. PR changes and tests do not publish the bundle.

## Configuration prepared (not set)

The adapter expects these environment entries:
- `GITHUB_APP_READ_ENABLED` — non-secret feature switch; unset or any value other than the exact string `true` disables GitHub reads.
- `GITHUB_APP_ID` — non-secret variable; current App ID: `5555433`.
- `GITHUB_INSTALLATION_ID` — non-secret variable; current installation ID: `177220128`.
- `GITHUB_APP_PRIVATE_KEY` — Cloudflare Secret containing the PEM private key.

The code has no default for the private key and fails closed if configuration is absent or invalid. The key was not read, copied, logged, committed, or set by this change.

### Safe setup after separate approval

Do not set these values until the separate deployment approval. The flag defaults off, so adding credentials while disabled is unnecessary.

After the PR is reviewed and merged, and deployment is explicitly approved:
1. Open Cloudflare Dashboard → **Workers & Pages** → `feuerwehr-lauchhammer-watchdog` → **Settings** → **Variables and Secrets**.
2. Add `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` as variables.
3. Add `GITHUB_APP_PRIVATE_KEY` as a **Secret**, paste the PEM directly in the secret-value field, and save. Never put it in `wrangler.toml/jsonc`, source, GitHub, a normal variable, issue/comment, terminal command, or log.
4. Keep the existing Cron `*/5 * * * *`, App installation, permissions, and Worker entrypoint unchanged. Deploy only through the approved release process.
5. After deployment, confirm that the first Cron invocation reports five read-only workflow summaries and the seven feed statuses continue independently. Verify request methods are only one token POST plus GETs to the fixed workflow-run paths; verify no dispatch endpoint appears. Confirm status fields against GitHub Actions UI and inspect Cloudflare CPU/subrequest metrics.

For the first controlled live test, use the existing scheduled-event-only flag and existing Cron. GitHub summaries appear only as a separate structured scheduled log; the public `/status` response remains feed-only. The private key remains unset until separately approved.

## Test command

From the repository root:
```sh
node tools/watchdog/build-editor-bundle.mjs --check
node --check tools/watchdog/worker.js
node --check tools/watchdog/github-app-adapter.js
node --check tools/watchdog/worker.bundle.js
node --test tools/watchdog/*.test.mjs
```

The tests use only generated ephemeral keys and mocked HTTP responses; they never contact GitHub or Cloudflare and never use the real App private key.
