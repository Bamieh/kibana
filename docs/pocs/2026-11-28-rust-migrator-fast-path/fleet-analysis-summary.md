# Session Pickup Summary: Kibana Core Rust Evaluation & Workstreams

**Date:** 2026-11-28
**Branch:** `explore/rust-migrator-fast-path` (branched from local `main` `243e962bf8b2`)
**Related Canvas:** `/Users/bamieh/.cursor/projects/Users-bamieh-bamieh-elastic-kibana-operational-skills/canvases/kibana-core-rust-analysis.canvas.tsx`

---

## 1. Live Production Telemetry Baseline (Nov 28, 2026 — Production Overview + QA Watchdog + ECH APM)

### Serverless Fleet Resource Profile (1h time-weighted 1-minute concurrent buckets, `metrics-kubernetes.pod-*`)
- **Total Serverless Kibana fleet:** `31,552` avg concurrent pods | **`829.7` continuous CPU cores** | **`16,818.3 GB` (`16.42 TB`) RAM** -> **`20.3 GB` RAM per active CPU core** (overwhelmingly memory-bound):
  - `background_tasks`: `17,195` pods | `615.1` cores (`74.1%`) | `9,666.4 GB` RAM (`57.5%`)
  - `ui`: `14,338` pods | `199.4` cores (`24.0%`) | `7,145.9 GB` RAM (`42.5%`)
  - `migrator` (`kb-migrator-kb`): `18.9` avg concurrent pods (peak `37`/min; `2,473` completions/hr) | `15.2` continuous cores (`1.8%` steady, peak `30.3`/min; bursts to `~200–250+` cores on fleet-wide rollouts/cert rotations) | `6.0 GB` RAM (`0.04%`)

### V8 Heap & Retained State (`kibana.process` OTel 15m + Core audits `#299001`, `#280296`, `#298557`)
- Live Serverless V8 heap (`p50`): `old_space` **`247.7 MB`** (`p95 = 310.5 MB`, `82.2%` of used V8 heap), `large_object_space` `22.8 MB`, `code_space + trusted_space` `30.1 MB`; total RSS `p50 = 502–677 MB` (`p99 = 1,943 MB` on Security BT, `INC-3659`).
- Core idle snapshot attribution (`elastic/kibana#299001` & `#280296`):
  - **Hapi routes + Joi/`@kbn/config-schema`**: `95.1 MiB` (3,321 routes, 119,261 objects, 14.5% of live snapshot)
  - **`zod` schemas**: `91.3–109.7 MiB` (`INC-3172`, `INC-3706`)
  - Raw JS source bundling (`elastic/kibana#298557`, Rspack): `-121.4 MiB` post-GC heap / `-394.8 MiB` RSS (already in flight)

### CPU / Event Loop / HTTP Overhead
- **QA Event Loop Watchdog V8 CPU profiles** (69 blocks `>10 s` in 7d, `INC-3875`, 68/69 during startup):
  - `33` blocks: `@elastic/transport` `doRedact` deep-cloning payloads (JS bug in `@elastic/transport`)
  - `16` blocks (`13–17 s`): `HttpServer.configureRoute` -> `@hapi/call` `internals.sort` (`O(N^2 log N)`) + `@hapi/hoek` `clone`
  - `8` blocks: `@kbn/config-schema`
  - `4` blocks: `@kbn/core-logging` `mergeGlobalContext`
- **Production Watchdog (24h):** `2.16M` blocks `>200 ms` (`514k` startup, `1.63M` steady-state — `96%` `background_tasks`, `92%` `security`).
- **Direct Pod HTTP (`kibana.http.server` OTel, 15m):** `28.9M` reqs / 15m (`32.1k req/s` = `99.6%` of pod HTTP traffic) hit 5 internal endpoints (`/api/_elu_history` `11.29M`, `/api/task_manager/_background_task_utilization` `7.32M`, `/api/status` `5.81M`, `/api/stats` `2.90M`, `/api/task_manager/metrics` `1.58M`).
- **ECH APM (6h, `2.87M` reqs):** `pre-route handler middlewares` `p50 = 4.3 ms` (`25.2%` of HTTP wall time) vs `route handler` `p50 = 3.9 ms`.
- **Migrator no-op ratio (Nov 28 1h, 500 sampled):** `99.4%` finish in `<10 s` (no doc conversion; `p50 = 189 ms`, `44.6% <100 ms`) after `28.9 s p50 / 48.1 s p95` Node boot.

---

## 2. Core Component Rust Ranking

1. **#1 Fleet-Cost Winner: Core HTTP Server + Router + Compiled Request/Schema Validation Engine** (`src/core/packages/http` + declarative `@kbn/config-schema` / `@kbn/zod` route validation)
   - Attacks the #1 Core memory consumer (`~80–130 MiB/pod` = `2.5–4.0 TB` of standing `16.42 TB` RAM), eliminates the `13–17 s` `@hapi/call` boot block, offloads `32.1k req/s` probes + TLS off V8's event loop (stopping probe-kill outages `INC-3502`/`3773`/`3836`), and replaces unmaintained Hapi 21 DoS surface (`kibana-team#2785`). Narrow surface: only `3` `registerAuth` files and `39` lifecycle-hook files.
2. **#2 Greenfield / Lowest-FFI Winner (PoC built in this folder): Standalone Rust Migrator Fast-Path (`kibana-migrator-rs`)**
   - Verified in Linux `aarch64` Docker (`poc/` + `benchmark-results.md`): `1.3 MB` binary, `26 KB` manifest for `193` real SO types across `7` indices, `35.5 ms` p50 wall / `25.3 ms` CPU / `9.47 MiB` Max RSS vs `65.8 ms` / `63.7 ms` / `82.8 MiB` in bare Node 24 and `28.9 s` / `~25 s` CPU / `345 MiB` in prod. Eliminates `~200–250+` core rollout/rotation bursts and `28.9 s` post-rollout latency; saves `~15` continuous steady-state cores.
3. **Avoid for Rust:** Saved Objects Runtime (I/O-bound + JS hooks/FFI tax), Elasticsearch Client (trivial JS fixes; TLS/zlib/`JSON.parse` already C++), Plugin System (V8 JS loading), Logging/Config/i18n (small JS fixes).

---

## 3. Parallel Local JS Quick-Win Worktrees (Local Only, Not Pushed)

- **Core Logging Hot-Path:** `/Users/bamieh/bamieh/elastic/kibana-core-logging-perf` · branch `perf/core-logging-hotpath` · commit `e73b160c97f1` · notes in `docs/pocs/2026-11-28-core-logging-hotpath/explore.md` (short-circuits `mergeGlobalContext` when level disabled + native `Date` ECS timestamp replacing `moment-timezone`).
- **Core ES Client Hot-Path:** `/Users/bamieh/bamieh/elastic/kibana-core-es-client-perf` · branch `perf/core-es-client-hotpath` · commit `0abb3cbb36aa` · notes in `docs/pocs/2026-11-28-core-es-client-hotpath/explore.md` (`project_routing` fast-path guard in `stripProjectRoutingNdjsonBody` + shared bound `KibanaTransport` class).

---

## 4. Files in This Folder & Next Steps

- `explorations.md` — 8-direction exploration map + all 5 lens challenges (`progress/*.md`)
- `benchmark-results.md` — verified Linux `aarch64` benchmarks + fleet math
- `native-modules-policy.md` — history of `check_prod_native_modules` + approval/packaging paths
- `poc/` — compilable Rust crate (`kibana-migrator-rs`), real 7-index `migrator-manifest.json`, real `serverless*.yml` configs, mock ES + Node 24 contender + `Dockerfile.bench`
- **Next session pickup options:**
  1. Run `/dev:build-poc` on `docs/pocs/2026-11-28-rust-migrator-fast-path/` to settle the 5 lens challenges (role-scoped rollout flag, OTLP flush, `DataStreams` skip, vs `runtime-pod-migration-probe` / `controller-job-hash-decoupling`).
  2. Or pivot to a PoC + benchmark for the #1 RAM-saving component: **Core HTTP Server + Router + Build-Compiled Rust Schema Validator** (targeting `2.5–4.0 TB` of standing fleet RAM).
