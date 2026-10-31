# GitHub App read-only adapter for Watchdog V3

## Status and safety

This adapter is intentionally separate and is **not imported by `worker.js`**. It does not run as part of the current Worker, does not alter the seven-feed V2 observation path, and does not create a public endpoint. This PR does not deploy anything, configure secrets, or display workflow status in the Worker. A later reviewed integration change is required before live use.

The adapter has no dispatch, workflow-write, repository-write, or permission-management operation. Its only GitHub API operations are:
- one `POST /app/installations/{installation_id}/access_tokens` to obtain a token restricted to this repository and `actions: read`;
- `GET` requests for the fixed five workflow-run endpoints listed below.

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

These values were checked against `main` at `557ac3fe1d9ed9ae1780b7d10aa5048dc56f6b61`. Recheck the workflow files before integrating this adapter, since schedules can change.

The summary distinguishes latest run, latest success, latest failure, queued/in-progress runs, last scheduled start, minutes since that start, expected schedule tick, and schedule delay. Workflow success is separate metadata: it never upgrades the seven public feed freshness states.

## Cloudflare Free budget estimate

Cloudflare documents a Free limit of 100,000 Worker requests/day, 10 ms CPU per HTTP or Cron invocation, 50 external subrequests per invocation, and up to five Cron triggers/account ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

If a future integration performs one read cycle per existing five-minute Cron:
- 288 invocations/day;
- six GitHub HTTP requests per cycle (one token request plus five workflow run queries), approximately 1,728 GitHub requests/day or 72/hour averaged across the day;
- with the current seven public-feed requests, 13 outbound requests in the normal case. With the adapter's one-hop maximum on GitHub redirects and the feed reader's existing three-hop bound, the conservative combined upper bound is 39 outbound requests—below 50.

GitHub documents a minimum 5,000 REST requests/hour for an installation token ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)); the estimate is far below that primary limit. GitHub secondary limits and transient API failures remain possible and are handled without retries or dispatch loops.

A local Node benchmark (50 ephemeral 2048-bit test-key JWT operations, including key import on every operation) measured about 0.66 ms process CPU per operation. This is a conservative local reference, **not** a Cloudflare CPU measurement. The Worker adapter caches its imported key during a client lifetime, but Cloudflare's 10 ms limit must be verified from actual Worker invocation metrics after a separately approved live integration. Network waiting time is not Worker CPU time.

## Configuration prepared (not set)

The adapter expects these environment entries:
- `GITHUB_APP_ID` — non-secret variable; current App ID: `5555433`.
- `GITHUB_INSTALLATION_ID` — non-secret variable; current installation ID: `177220128`.
- `GITHUB_APP_PRIVATE_KEY` — Cloudflare Secret containing the PEM private key.

The code has no default for the private key and fails closed if configuration is absent or invalid. The key was not read, copied, logged, committed, or set by this change.

### Safe setup after separate approval

Do not set these values for the current deployment: the adapter is not wired into `worker.js`, so they are not needed yet.

After a separately reviewed integration PR and explicit deployment approval:
1. Open Cloudflare Dashboard → **Workers & Pages** → `feuerwehr-lauchhammer-watchdog` → **Settings** → **Variables and Secrets**.
2. Add `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` as variables.
3. Add `GITHUB_APP_PRIVATE_KEY` as a **Secret**, paste the PEM directly in the secret-value field, and save. Never put it in `wrangler.toml/jsonc`, source, GitHub, a normal variable, issue/comment, terminal command, or log.
4. Do not change the App installation, permissions, Cron, or Worker entrypoint. Do not deploy until the integration review is approved.
5. After deployment, confirm that the first Cron invocation reports five read-only workflow summaries and the seven feed statuses continue independently. Verify request methods are only one token POST plus GETs to the fixed workflow-run paths; verify no dispatch endpoint appears. Confirm status fields against GitHub Actions UI and inspect Cloudflare CPU/subrequest metrics.

For a more cautious first live test, a future integration should provide a non-public, scheduled-event-only feature flag that defaults off, and produce summaries only in the existing scheduled logs or an explicitly approved read-only status presentation. This PR creates neither the flag nor a new endpoint.

## Test command

From `tools/watchdog`:
```sh
node --check github-app-adapter.js
node --test *.test.mjs
```

The tests use only generated ephemeral keys and mocked HTTP responses; they never contact GitHub or Cloudflare and never use the real App private key.
