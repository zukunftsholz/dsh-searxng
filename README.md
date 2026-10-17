# dsh-searxng

[![dsh-vet](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frogerdigital%2Fdsh-searxng%2Fdsh-vet%2Freport%2F.dsh-vet%2Fbadge.json)](https://github.com/rogerdigital/dsh-searxng/blob/dsh-vet/report/.dsh-vet/report.json)

> **This is a fork.** Upstream is [rogerdigital/dsh-searxng](https://github.com/rogerdigital/dsh-searxng),
> by Roger Deng, MIT-licensed. This fork ports the plugin to DeepSeek Harness **0.2.1-rc.2** and
> makes the deployment mode an explicit choice; it is published from
> [zukunftsholz/dsh-searxng](https://github.com/zukunftsholz/dsh-searxng). The `dsh-vet` badge above
> reports upstream's independent-audit branch, which this fork does not publish.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that registers a
[SearXNG](https://docs.searxng.org/)-backed search provider into the web capability seam
(`ctx.web`), giving your agent `web_search` through a **free, self-hosted, key-less** metasearch
instance — instead of the paid Exa/Perplexity APIs.

SearXNG is never deployed on your behalf. `setup` requires you to choose between an instance you
already run and an explicit opt-in to a Docker-managed one.

## Requirements

Node.js 20 or newer, `dsh`, and `dsh-searxng` 0.5.0, which supports DeepSeek Harness
`0.2.1-rc.2` (`@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-launch-environment` each
`>=0.2.1-rc.2 <0.3.0`). Docker Engine or Docker Desktop with Compose v2 is required only for the
managed path.

## Quick start

`setup` has no default deployment shape. Pass exactly one of:

- `--url <endpoint>` — use an existing SearXNG instance. Never touches Docker.
- `--managed` — explicitly provision a loopback-only, pinned Docker deployment.

```sh
# Use an instance that already answers the SearXNG JSON API.
npx dsh-searxng setup --url http://127.0.0.1:8080
dsh --profile web

# Or opt in to a managed Docker deployment (Docker Engine/Desktop + Compose v2).
npx dsh-searxng setup --managed
dsh --profile web
```

The setup command installs and attaches `dsh-searxng` to the selected profile, so no separate
plugin-install step is required. Both shapes validate before the profile is considered activated:
`setup` runs a real search directly against SearXNG, then writes the profile row and runs a search
through the composed DSH provider configuration. If that last step fails, the row is reverted and
the state commit never happens, so a failed run leaves no half-configured profile.

Omit both flags and `setup` refuses with `E_MODE_REQUIRED` (exit 2) before doing anything — no
Docker call, no profile write, no state lock:

```text
E_MODE_REQUIRED: Invalid CLI arguments: setup requires either --url <endpoint> (use an existing
SearXNG) or --managed (provision one with Docker); it never deploys SearXNG by itself unless asked
Next: Pass --url <endpoint> to use an existing SearXNG, or --managed to provision one with Docker
```

Pass both and it refuses with `E_MODE_MISMATCH` (exit 2).

Use another DSH profile, and for the managed shape a different port:

```sh
npx dsh-searxng setup --managed --profile research --port 9080
dsh --profile research
```

Package installation and plugin activation never start Docker, and neither do `status`, `doctor`,
`tune`, or `remove` without `--service`. Docker resources are created only by `setup --managed`
and destroyed only by `remove --service`; `repair` and `update` act on an already-owned managed
deployment and refuse to touch anything they cannot prove is theirs. On an `external` profile none
of these commands reaches Docker at all.

## Existing SearXNG

An existing local, remote, authenticated, or independently managed SearXNG instance is a
first-class path — no Docker anywhere on the machine:

```sh
npx dsh-searxng setup --profile web --url https://search.example.com
```

The endpoint must be HTTP(S), contain no credentials, query, or fragment, and enable JSON search.
Existing provider options such as `authHeader`, `language`, `engines`, `categories`, and `baseURLs`
in the DSH profile are preserved and used by validation. External mode never invokes Docker, so
`E_DOCKER_MISSING`, `E_DOCKER_OFFLINE`, and `E_COMPOSE_UNSUPPORTED` cannot occur, `update` and
`remove --service` refuse, and `doctor` reports all three Docker checks as `skip`.

## Managed deployment

`--managed` provisions one loopback-only SearXNG from the packaged deployment catalog: a
digest-pinned image, a generated private secret, and `io.dsh-searxng.*` ownership labels on the
container, network, and volume. Destructive operations run only after those labels match this DSH
home; a same-name resource without them is a foreign resource and is refused with
`E_RESOURCE_FOREIGN`, never adopted or modified.

Repeating `setup --managed` reuses the same owned container, port, configuration, and secret, and
keeps the port recorded in state when `--port` is omitted. Asking for a different port than the
recorded deployment is refused with `E_STATE_INVALID` rather than silently migrated.

## Manual plugin installation

If you manage the DSH profile patch yourself and do not want the setup command to attach it,
install only the plugin package:

```sh
dsh plugin add dsh-searxng
```

With a named profile, use `dsh plugin --profile <name> add dsh-searxng`.

Installing the package is **not** sufficient on its own. The package must also be listed in the
profile manifest's `dsh.profile.bundles`; see [Bundle enrolment](#bundle-enrolment).

## Operations

```sh
# Fast health result; stops at the first failure.
npx dsh-searxng status --profile web

# Ordered environment, mode, Docker, ownership, HTTP, JSON, search, profile, bundle, and provider
# checks, plus the local privacy posture with its explicit out-of-scope limits.
npx dsh-searxng doctor --profile web

# Read-only engine-health probe battery: per-engine reported failures with reasons,
# result contribution, and evidence limits. Writes nothing.
npx dsh-searxng tune --profile web

# Plan and execute ownership-safe repairs for the managed deployment.
npx dsh-searxng repair --profile web

# Move the managed deployment to a packaged version with verified rollback.
npx dsh-searxng update --profile web

# Detach the profile and remove the plugin package from that profile.
npx dsh-searxng remove --profile web

# Also stop and remove the owned service; keep its data and local state.
npx dsh-searxng remove --profile web --service

# Permanently delete the exact owned data volume and managed directory.
npx dsh-searxng remove --profile web --service --purge-data
```

`update` accepts `--deployment-version N` to pin a packaged deployment version. Permanent deletion
prompts on an interactive terminal; automation must add `--yes`, and `--purge-data` requires
`--service`. `--json` is available on setup, status, doctor, tune, repair, update, and remove.
`--help` prints the command summary and cannot be combined with a command or other options.

`repair` and `update` address the managed deployment only. On an `external` profile `update`
refuses with `E_STATE_INVALID` ("external endpoints are read-only"); `repair` never modifies the
instance — it checks endpoint health, failing with `E_SEARCH_FAILED` if the instance is
unreachable, auth-rejected, or TLS-invalid, and otherwise only reattaches a drifted profile row.
`remove --service` on an `external` profile refuses with `E_MODE_MISMATCH`: that profile owns no
Docker service, and succeeding as a no-op would imply a container was removed.

Exit codes: `0` success; `2` when the CLI rejects the command line itself (`E_USAGE`, plus the
`E_MODE_REQUIRED` / `E_MODE_MISMATCH` decisions `setup` makes before any work); `1` for every
operational failure, including an `E_MODE_MISMATCH` raised after the request was accepted — for
example `remove --service` against a profile recorded as `external`.

### Recovery semantics

`repair` and `update` journal their progress under
`$DSH_HOME/dsh-searxng/journal.json` between the first mutation and validated completion; `setup`
and `remove` read that journal to refuse during or clean up after an interruption.

- `setup` refuses to run while an interrupted operation is recorded and points at `repair`. When a matching
  deployment is recorded but unhealthy, it restarts a wedged runtime, or — if the container is gone while the
  recorded bundle survives (the leftover of `remove --service` without `--purge-data`, or a manual
  `docker compose down`) — recreates the runtime from that bundle.
- `repair` takes over when a journal exists: it recomputes the recovery decision from disk (clear
  the journal, validate the target, or resume the rollback) before any ordinary repair. It also
  removes a provably stale `state.lock` left by a dead process — quarantining it under an
  unpredictable name and re-checking the bytes before deleting, so a live lock is never broken —
  and sweeps orphaned `.staging-*` renderer directories that carry this installation's shape.
  `doctor` reports the interrupted operation's id, kind, phase, and age.
- `update` is transactional: the current deployment stays authoritative until the target passes
  readiness, real-search, and provider validation. Any failure after the first Docker mutation
  rolls back to the previous image and configuration and revalidates them; same-version updates
  are rejected with `E_DEPLOYMENT_UNSUPPORTED`.
- `remove --service` clears the journal once the deployment is gone, so a subsequent `setup` is
  not refused. It also removes the labeled leftovers of a container-less deployment by deriving the
  compose file from the bundle recorded in state.

## Provider configuration

The setup command manages the `web-search-searxng` row in
`$DSH_HOME/profiles/<name>/cordis.patch.yml` and writes `mode` and `baseURL` explicitly, so the
profile is self-describing. These optional values can be added to that row:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `external` | Deployment posture: `external` (an instance you run) or `managed` (one this tooling may provision). Selectable in the plugin settings; a closed union. |
| `baseURL` | managed or `--url` endpoint | SearXNG base URL. Falls back to `$SEARXNG_BASE_URL`; empty reads as unavailable. |
| `baseURLs` | none | Failover pool of SearXNG base URLs; the first entry is primary and a non-empty list wins over `baseURL`. |
| `language` | none | SearXNG language, for example `zh-CN` or `en-US`. |
| `engines` | none | Comma-separated engine allowlist. |
| `categories` | none | Comma-separated category filter. |
| `authHeader` | none | Authorization header for a protected external instance. |
| `cacheTtlMs` | 600000 | Cached query result lifetime in milliseconds; `0` disables caching. |
| `minIntervalMs` | 1500 | Minimum spacing between network requests; `0` disables pacing. |
| `queueCapacity` | 8 | Requests that may wait for a pacing slot before the provider rejects with backpressure. |
| `totalBudgetMs` | 15000 | Wall-clock budget for one search call, spanning pacing wait, backoff, and network attempts. |

`mode` does not change how a search executes — only who owns the endpoint. In `managed` mode with no
endpoint recorded yet, the provider is honestly unavailable (state `awaiting-managed-endpoint`),
which `doctor` distinguishes from `external` with no endpoint (`no-endpoint`). Availability is
decided by the endpoint alone in both modes, so an unconfigured profile never sends a search to an
empty URL.

Choosing `managed` records intent; it does not start Docker. Provisioning happens only when the
operator runs `npx dsh-searxng setup --managed`.

Repeated queries are served from an in-process cache scoped to the provider
instance (nothing is written to disk); a cache hit performs no network request.
Concurrent searches pass a token bucket (burst 2, then one request per
`minIntervalMs`), and a full queue rejects immediately with a retryable error
instead of holding the caller. Failed responses and empty result pages are never cached —
a cached empty page would mask upstream recovery for the whole TTL — and an empty result
page is returned as-is: the `engines`/`categories` allowlist is never
silently widened to chase results. When the instance answers HTTP 429, the
provider honors `Retry-After` and retries at most once within the remaining
budget.

### Live settings

Every config field is declared volatile and read through `.get()` at operation time. For the search
knobs the provider snapshots the current settings once per search, so an edit to this row — or a
save in the plugin settings page — takes effect on the *next* search, with no profile remount and no
restart. The provider is never unregistered and re-registered to carry a new value, so the seam's
provider selection cannot flicker.

That covers `baseURL`, `baseURLs`, `language`, `engines`, `categories`, `authHeader`, `cacheTtlMs`,
`minIntervalMs`, `queueCapacity`, and `totalBudgetMs`.

Two limits are worth stating plainly:

- **`mode` is a posture marker, not a search parameter.** It is validated and volatile like the
  rest, but no search reads it: search execution is decided by the endpoint alone. `mode` records
  which shape was chosen, and the CLI acts on the copy recorded in
  `$DSH_HOME/dsh-searxng/state.json` during `setup` (`doctor`'s mode line, `repair`, `update`,
  `remove --service`), cross-checked against the row — a row whose `mode` disagrees with the
  recorded attachment reads as not attached. Saving a different `mode` in the settings page
  therefore neither re-shapes the deployment nor provisions anything, and can make `doctor` report
  a drifted attachment that `repair` then reconciles.
- **The endpoint is part of the profile attachment.** `doctor`, `repair`, and `remove --service`
  compare the recorded endpoint with the row, so change it with `setup --url <endpoint>` (which
  preserves every other key on the row) rather than by editing `baseURL` alone. A hand-edited
  `baseURL` that no longer matches the recorded attachment is reported by `doctor` as a missing or
  outdated attachment and reconciled by `repair`.

### Result limits

The provider applies `request.maxResults` at its own request layer: sources are sliced before the
result leaves the provider, so no more data than requested is handed back. It leaves
`truncated: false`, because the seam sets `truncated: true` only when the *seam* has to cut a
provider's over-long result; flagging it here would tell the model to refine a query that was
already satisfied.

### Bundle enrolment

Installing the package does not by itself mount the provider. A profile mounts it only when both are
true:

1. `dsh-searxng` is listed in the profile manifest's `dsh.profile.bundles`, so its own
   `cordis.patch.yml` runs as a bundle layer and its `insert:` creates the `web-search-searxng`
   entry, and
2. the profile's `cordis.patch.yml` carries the `web-search-searxng` config row.

In DSH 0.2.1-rc.2 a non-insert patch is resolved by id against entries that already exist, and a
miss is only a loader warning. So a profile that lists the package in `dependencies` but not in
`dsh.profile.bundles` drops the config row **silently**: no provider registers, and the first search
fails with `WEB_PROVIDER_CONFIGURED_MISSING` (`configured web provider "searxng" is not registered`).
This is a real failure signature, observed on a real profile — nothing warns you earlier, because
the row reads as present and the endpoint answers.

`setup` therefore enrols the bundle (a no-op when `dsh plugin add` already did) and verifies that the
entry composes before it writes the config row. `doctor` has a `bundle` check for the same state and
reports `E_PROFILE_BUNDLE_MISSING`, whose `bundleMount` detail names the reason:
`not-enrolled`, `package-missing`, `no-bundle-metadata`, `patch-unreadable`, or
`target-not-inserted`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH home; profiles live in `profiles/<name>` and this plugin's state in `dsh-searxng/`. A leading `~` is expanded. |
| `DSH_SEARXNG_DSH_BIN` | `dsh` from `PATH` | The `dsh` executable the CLI shells out to for `plugin add`/`plugin remove`. Set it when DSH was installed Desktop-only: that install carries its CLI inside `resources/app.asar` and exposes no `dsh` command on `PATH`. An empty value means unset. |
| `DSH_SEARXNG_PLUGIN_SPEC` | `dsh-searxng@<running version>` | Package spec `setup` installs, used verbatim. For a packed tarball before publication, a git ref, an alternate registry or dist-tag: `file:./dsh-searxng-0.5.0.tgz`, `github:owner/repo`, `dsh-searxng@next`. |
| `SEARXNG_BASE_URL` | none | Endpoint fallback read when the row has no `baseURL`. |
| `DSH_WEB_SEARCH_PROVIDER` | none | Seam-level provider selection, equivalent to the `web` row's `searchProvider`. |

## Multi-instance failover

List two or more endpoints in `baseURLs` (at most 8, duplicates collapse) to
route searches across them — for example a local managed instance first and a
remote one second:

```yaml
web-search-searxng:
  baseURLs:
    - http://127.0.0.1:8080
    - https://searxng.example.net
```

The first entry is primary. When an attempt fails with a network error, a
timeout, or HTTP 502/503/504/429, the endpoint's health penalty rises and the
next attempt (and the first attempt of later searches) goes to the healthiest
endpoint; penalties decay with a 30 s half-life, so the primary recovers the
first slot about a minute after its last failure, or immediately after a
successful search. Malformed responses (`contract` failures) and other 4xx
statuses never fail over — those are configuration problems on that endpoint
that switching would silently mask. The cache is keyed by the whole pool, the
pacing bucket is per endpoint, and the `totalBudgetMs` deadline spans every
endpoint's attempts; empty result pages are valid answers and never trigger
failover. `setup --url` records a single external endpoint per profile —
configuring a pool is a manual profile-config edit until the CLI follow-up
ships — and `doctor` reports an `endpoint-pool` line whenever `baseURLs` is set,
because the pool outranks the `baseURL` that was just written.

## Per-query controls

SearXNG supports per-query routing inside the query string itself; the provider
passes query syntax through untouched:

- `:zh-CN` / `:en` — select the result language for this query (`:` prefix).
- `!bing` / `!news` — select one engine or category for this query (`!` prefix).
- `site:example.com` — restrict results to one domain (engine-dependent support).

For example, the query `:zh-CN 大模型 排行榜` searches in Chinese regardless of
the profile's `language`, and `!github compose network mapping` uses only the
GitHub engine. Verify engine names against your instance's engine list.

If several DSH search providers are available, select this one with
`DSH_WEB_SEARCH_PROVIDER=searxng` or the corresponding `searchProvider` DSH web configuration.

## Troubleshooting

- `E_MODE_REQUIRED`: pass `--url <endpoint>` or `--managed`; setup never chooses for you.
- `E_PLUGIN_INSTALL_FAILED`: `dsh plugin add` refused the package because it is incompatible with
  the running dsh. This is what a bare registry name resolves to when `latest` is an older line —
  the manager's own diagnostic quotes the requirement that failed. Set
  `DSH_SEARXNG_PLUGIN_SPEC` to a compatible version, dist-tag, git ref, or packed tarball, or
  install a `dsh-searxng` release that supports this runtime. Only an incompatibility gets this
  code; a registry or network failure during the same install still reports `E_PROFILE_WRITE`.
- `E_PROFILE_BUNDLE_MISSING`: the profile's config row will not resolve because the plugin's bundle
  layer does not insert it. See [Bundle enrolment](#bundle-enrolment); run `setup` to enrol, then
  restart dsh.
- `E_DSH_MISSING`: install the dsh CLI on `PATH`
  (`npm install -g @deepseek-ai/dsh@next`), or point `DSH_SEARXNG_DSH_BIN` at an existing dsh
  executable. The `@next` tag matters: a bare install resolves the `latest` dist-tag, which is an
  older line this plugin does not support.
- `E_DOCKER_MISSING` / `E_DOCKER_OFFLINE`: managed mode only. Install or start Docker.
- `E_COMPOSE_UNSUPPORTED`: managed mode only. Enable Docker Compose v2.
- `E_JSON_DISABLED`: add `json` to SearXNG `search.formats`.
- `E_AUTH_FAILED`: check the external instance's `authHeader` configuration.
- `E_TLS_FAILED`: the endpoint's TLS certificate failed validation; check the certificate chain
  and retry.
- `E_RATE_LIMITED`: adjust the instance limiter or upstream engine selection.
- `E_RESOURCE_FOREIGN`: a same-name Docker resource does not carry this installation's ownership
  labels; it is never modified automatically.
- `E_BUNDLE_DAMAGED`: the generated configuration bundle is incomplete or mismatched; `repair`
  rebuilds it from the packaged assets while preserving the existing secret.
- `E_DEPLOYMENT_UNSUPPORTED`: the packaged deployment catalog cannot satisfy the request (unknown
  or same version requested, or an entry incompatible with the current state); upgrade
  dsh-searxng or choose an available version.
- `E_PROFILE_CONCURRENT_MODIFICATION`: the DSH profile changed during the operation; review it and
  retry.
- `E_REMOVE_BLOCKED`: `remove --service` is blocked because other managed profiles still use the
  deployment, or the owned Docker resources are absent or incomplete.

`doctor --json` returns the complete ordered check list (`journal`, `environment`, `mode`, `docker`,
`ownership`, `container`, `http`, `json`, `search`, `profile`, `bundle`, `provider`) with actionable
error codes, plus the `privacy` posture and any `interruptedOperation`. In external mode the three
Docker checks report `skip`, not `pass`. `status` runs the same chain, stops at the first failure,
and omits the journal and privacy sections, so it stays a fast health result.

## Upgrading from 0.4.0

- **New harness line.** 0.5.0 targets DeepSeek Harness `0.2.1-rc.2`
  (`@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-launch-environment` each
  `>=0.2.1-rc.2 <0.3.0`, `@deepseek-ai/cordis` `^4.0.5`,
  `@deepseek-ai/schemastery` `~3.18.5`). It no longer supports the `0.1.x` harness line. Install a
  matching dsh first: `npm install -g @deepseek-ai/dsh@next`.
- **`setup` now requires an explicit mode.** `npx dsh-searxng setup` no longer deploys SearXNG by
  itself; use `setup --url <endpoint>` for an existing instance or `setup --managed` to keep a
  managed deployment. An existing `managed` deployment is adopted by `setup --managed`.
- **Settings apply live.** Provider config is volatile and read through `.get()` at operation time;
  editing the search knobs on the row or in the settings page no longer needs a remount or a
  restart. `mode` is validated and volatile like the rest, but it is a posture marker the CLI acts
  on, not a search parameter.
- **Result limits are applied at the provider.** `maxResults` now trims results before they leave
  the provider and reports `truncated: false`.
- **Profiles get a `mode` key.** Rows written by earlier releases have none and read as `external`;
  re-run `setup` to record the shape explicitly.
- **Install path is pinned.** The CLI installs `dsh-searxng@<running version>` instead of the bare
  registry name, and reports `E_PLUGIN_INSTALL_FAILED` when the plugin manager rejects the resolved
  package.

## Runtime support

- Node.js: 20 and newer. The CI matrix covers Ubuntu, macOS, and Windows at Node 20 and 24.
- CLI, tests, build, and packed artifact: `pnpm verify` runs in each of those jobs.
- Managed Docker journey (including repair and update rollback) and Docker adapter integration:
  opt-in Linux CI with Docker Engine and Compose v2. That job also exercises the release
  certification runner with a stub `dsh`; it is a runner check, not a formal certification.
- **Certified** Docker environments per release: only those with a complete passing report from
  the release tarball in [docs/release-certification.md](docs/release-certification.md) — one
  each from macOS + Docker Desktop, Windows + Docker Desktop + WSL2, and Linux + Docker Engine +
  Compose v2.
- **0.5.0 is uncertified.** No certification report exists for it on any platform, and the
  certification runner has not been executed on real hardware for `0.5.0` — its mechanics are
  covered by tests against an in-process replica of its own harness, which is not a Docker host.
  The records under [docs/certification/](docs/certification/) were produced from the 0.3.0 and
  0.4.0 tarballs against the previous harness line and are historical evidence only; they do not
  carry forward.
- Docker Desktop on Windows is compatible with the managed path (same engine, same Compose v2
  plugin) but uncertified until its report exists for a given release.
- External SearXNG mode does not require Docker and works on any platform with Node.js 20+.
- Podman and Podman Compose are not supported in the managed path.

Test status, measured in this tree on Windows with Node 24.19.0: **1024 tests, 1002 passed, 22
skipped, 0 failed**. Typecheck (`tsc --noEmit`) is clean.

Four of the skipped tests cover the symlink-refusal guarantee: the plugin must never follow a
symlinked profile manifest, profile patch, staging entry, or `dsh-searxng` managed directory, and
the bundle renderer must reject symlinked immutable inputs. Creating a symlink on Windows requires
Administrator rights or Developer Mode, so those four tests are **skipped when the host cannot
create one**, and the reported test name carries the reason:

- `test/cli/profile.test.ts` — "rejects symlinked profile files without following or changing them"
- `test/cli/recovery.test.ts` — "refuses to remove a staging entry that is a symlink"
- `test/cli/repair.test.ts` — "refuses to remove a staging entry that is not a safe directory"
- `test/cli/setup.test.ts` — "detects a symlinked executable by real path but never treats an
  ordinary import as main"

The gate is a **measured capability probe, not a platform check**: each module attempts a real file
and directory symlink in a throwaway directory, and skips only where the OS refuses. Those tests
therefore run on every Linux and macOS host (including a hardened container, if it permits links)
and on any Windows host that can create symlinks — Developer Mode enabled or an elevated process.
Coverage is never dropped on a developer machine that could run them, and the refusal behaviour
itself remains implemented and exercised wherever it can be expressed.

`setup --managed` selects the deployment to install from the packaged deployment catalog
(newest entry compatible with the current state schema) and reuses a healthy
existing deployment that is still listed in the catalog; use `update` to move
between deployment versions.

dsh is in developer preview with breaking changes expected. Version 0.5.0 supports
`@deepseek-ai/dsh-web >=0.2.1-rc.2 <0.3.0` and
`@deepseek-ai/dsh-launch-environment >=0.2.1-rc.2 <0.3.0`.

## Development

```sh
pnpm install
pnpm verify
```

On Windows, where the pnpm `.ps1` shim may be blocked by execution policy, use `pnpm.cmd`. If a
plain `pnpm install` fails with `ERR_PNPM_SYMLINK_FAILED`, install with
`pnpm.cmd install --frozen-lockfile --config.node-linker=hoisted`.

The repository Docker example is development-only. The packaged setup path is the supported
quickstart because it pins the image, generates a private secret, labels every owned resource, and
validates the final provider before activation. The opt-in Linux CI job runs both real Docker
release checks:

```sh
DSH_SEARXNG_E2E=1 pnpm test:e2e
DSH_SEARXNG_DOCKER_INTEGRATION=1 pnpm test -- test/cli/docker.integration.test.ts
```

Platform certification of a packed tarball runs on each release host:

```sh
pnpm pack --pack-destination ./node_modules/.cache/pack
pnpm certify:platform -- --tarball ./node_modules/.cache/pack/dsh-searxng-<version>.tgz
```

## License

MIT
