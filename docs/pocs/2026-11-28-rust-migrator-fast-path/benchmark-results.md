# Benchmark Results: Standalone Rust Migrator Fast-Path (`kibana-migrator-rs`)

**Date:** 2026-11-28
**Branch:** `explore/rust-migrator-fast-path` (off local `main` `243e962bf8b2`)
**Runtime Environment:** Linux `aarch64` container (`node:24-bookworm-slim` + `libssl3`, built with `rust:bookworm`, matching ARM64 Serverless containers)
**Dataset:** Real Kibana Saved Objects manifest extracted from this repo's live `SavedObjectTypeRegistry` via `node scripts/snapshot_plugin_types.js snapshot`: **7 active `.kibana*` indices**, **193 real SO types**, **34 removed types**, **13 base root mappings**, plus real `config/serverless*.yml` configs (`serverless: security`, `product_tier: complete`).

---

## 1. Artifacts & Verification

- **Compiled release binary (`kibana-migrator-rs`, LTO + stripped):** `1,315,768` bytes (**1.3 MB**)
- **Dynamic TLS linkage (`ldd`):** `libssl.so.3` + `libcrypto.so.3` (system OpenSSL 3 — same FIPS 140-3 path used in Wolfi `chainguard-base-fips`)
- **Version-only manifest (`migrator-manifest.json`):** `25,857` bytes (**26 KB**) vs `11 MB` for the full-mappings snapshot (**445x smaller**)
- **Unit tests (`cargo test --release`):** **9 / 9 passed** (0 compiler warnings)
  - `config::tests::tier_overlay_overrides_kibana_yml`
  - `zdt::tests::{exact_noop_passes_fast_path, missing_version_alias_falls_back, rollback_lesser_passes_without_alias_requirement, unknown_meta_type_fails_closed_to_fallback, model_version_bump_falls_back, changed_root_mapping_falls_back, missing_index_falls_back, multi_index_alias_falls_back}`
- **End-to-end Linux container verification (5 / 5 passed):**
  1. Warm ES no-op -> `fast-noop`, 7 indices checked in `7 ms` (`37 ms` total), exit `0`.
  2. Rollback (`lesser`) -> `fast-noop`, 7 indices checked in `7 ms` (`36 ms` total), no alias write required, exit `0`.
  3. ModelVersion bump (`.kibana_analytics`) -> `execvp` fallback replaced process image cleanly (`CALLER_PID=74 == FALLBACK_EXEC_INVOKED pid=74`, passthrough args intact, exit `42`).
  4. Unknown `_meta` key (`untracked_plugin_so_type`) -> fail-closed `execvp` fallback (`unknown_meta_mapping_type:.kibana:untracked_plugin_so_type`).
  5. Missing index (`.kibana_ingest`) -> fail-closed `execvp` fallback (`missing_index:.kibana_ingest`).

---

## 2. Measured Head-to-Head Linux Benchmarks

### Benchmark 1 — Warm ES No-Op (`n = 30` runs each, 2 ms mock ES RTT across 7 concurrent `.kibana*` indices)

| Contender | Wall p50 | Wall p95 | CPU mean (user+sys) | CPU p50 | Max RSS p50 | Max RSS p95 |
|---|---:|---:|---:|---:|---:|---:|
| **Prod `kb-migrator-kb` (full Node.js + 164–188 plugins, Nov 28 prod)** | **28,900 ms** | **48,100 ms** | **~24,000–28,000 ms** | ~25,000 ms | **345.0 MiB** | — |
| **Bare Node.js 24 fast-path (`node_fast_path.mjs`, Linux)** | **65.82 ms** | **67.70 ms** | **63.67 ms** | 60.0 ms | **82.84 MiB** | 83.90 MiB |
| **Rust fast-path (`kibana-migrator-rs`, Linux)** | **35.53 ms** | **37.04 ms** | **25.33 ms** | 30.0 ms | **9.47 MiB** | 9.52 MiB |

*(For local comparison on this macOS host, booting Kibana `preboot()` + `setup()` via `node scripts/snapshot_plugin_types.js snapshot` took `86.69 s` wall, `108.67 s` CPU [`103.70 s` user + `4.97 s` sys], and `5.87 GiB` Max RSS.)*

**Speedups (Rust fast-path):**
- **vs Prod full Kibana migrator (warm ES):** **813x faster wall time** (~129x at prod's 189 ms ES RTT), **~987x less CPU (-99.9%)**, **36.4x less RSS (-97.3%)**.
- **vs Bare Node.js 24 fast-path (same container, same manifest):** **1.85x faster wall**, **2.51x less CPU**, **8.75x less Max RSS**.

### Benchmark 2 — Cold ES Warmup (ES returns HTTP `503 initializing` for `2,000 ms` before `200`)

| Contender | Wall Time | CPU (user+sys) | Max RSS |
|---|---:|---:|---:|
| **Bare Node.js 24 fast-path** | 3,204.89 ms | 120.0 ms | 94.35 MiB |
| **Rust fast-path (`kibana-migrator-rs`)** | 3,173.24 ms | **40.0 ms** (3.0x less) | **9.47 MiB** (10.0x less) |

### Benchmark 3 — Fallback `execvp` Handoff Overhead (`n = 10` runs, real modelVersion bump)

| Metric | Measured Overhead Before Node.js Starts |
|---|---:|
| Wall time (p50 / mean / max) | **35.70 ms** / 35.89 ms / 40.27 ms (**0.12%** of a 28.9 s fallback boot) |
| CPU time (mean / p50) | **26.0 ms** / 30.0 ms |
| Peak RSS (freed to 0 by kernel on `execvp`) | **9.22 MiB** |

---

## 3. Honest Fleet-Wide Projections (Corrected Time-Weighted Production Baseline)

From Production Overview (`serverless-metrics-*:metrics-kubernetes.pod-*`, 1-minute time-weighted concurrent buckets over 1h, Nov 28 2026):

| Role | Avg Concurrent Pods | Continuous CPU Cores | Fleet CPU Share | Avg Concurrent RAM | Fleet RAM Share |
|---|---:|---:|---:|---:|---:|
| `background_tasks` | 17,195.1 | 615.1 | 74.1% | 9,666.4 GB | 57.5% |
| `ui` | 14,338.2 | 199.4 | 24.0% | 7,145.9 GB | 42.5% |
| `migrator` (`kb-migrator-kb`) | 18.9 (peak 37) | **15.2** (peak 30.3) | **1.8%** | **6.0 GB** | **0.04%** |
| **Total Serverless Kibana Fleet** | **31,552.2** | **829.7 cores** | **100%** | **16,818.3 GB (16.42 TB)** | **100%** |

*(Important metric correction: summing `AVG(cpu)` across all `1,082` distinct migrator pod names over 1h earlier double-counted 30-second ephemeral pods as full-hour pods [`883.5` cores]. Time-weighted 1-minute bucketing gives the true continuous load: `15.2` cores steady-state.)*

### What `kibana-migrator-rs` Actually Wins in Production
1. **Steady-state migrator CPU (`2,473` runs/hr, 99.4% fast-path):** Drops container CPU from **`15.2` continuous cores -> `~0.02` cores** for the migrator process itself (saving **~15 continuous cores** steady-state; ~0.04 cores under bare Node.js 24).
2. **Rollout & rotation burst storms (the biggest operational win):** On stateless weekly rollouts or cluster-wide `uiam-shared-secrets`/CA rotations touching ~16,500 projects over ~30 minutes, `kb-migrator-kb` spawns thousands of pods requesting `125m` CPU but burning `998m` (8x burst) -> **~200–250+ concurrent burst cores** competing with co-located `ui`/`background_tasks` pods. Rust cuts that burst from **~230 cores -> ~0.2 cores** (a **~1,000x burst reduction**).
3. **Post-rollout completion latency:** Cuts `kb-migrator-kb` duration from **28.9 s p50 / 48.1 s p95 -> ~0.2–0.5 s** (at real prod ES RTT), shortening `RolloutReporting.ReconciliationCompleted`.
4. **Memory honesty:** Cuts per-pod working set **36.4x** (`345 MiB -> 9.47 MiB`), but **does not meaningfully reduce the 16.42 TB standing fleet RAM bill** (`migrator` is `0.04%` of fleet RAM, and k8s pod limits must remain `2 GiB` while in-container `execvp` fallback runs Node.js).

---

## 4. Reproducing Locally

```bash
cd /Users/bamieh/bamieh/elastic/kibana/docs/pocs/2026-11-28-rust-migrator-fast-path/poc
docker build -f Dockerfile.bench -t kibana-migrator-rs-bench .
docker run --rm -e BENCH_ITERATIONS=30 kibana-migrator-rs-bench
```
