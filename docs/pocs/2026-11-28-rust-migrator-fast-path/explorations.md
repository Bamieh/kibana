# Explorations: Rust Migrator Fast-Path

## Context

### Production cost and behavior of `kb-migrator-kb` (Serverless)
- **True continuous fleet footprint (time-weighted 1-minute buckets):** Live query on Production Overview (`serverless-metrics-*:metrics-kubernetes.pod-*`, 1h window, Nov 28 2026) aggregating active pods per 1-minute bucket across **31,552 avg concurrent Kibana pods** (**`829.7` continuous cores**, **`16,818.3 GB` [16.42 TB] working-set RAM** -> `20.3 GB RAM/core`):
  - `background_tasks`: `17,195` avg concurrent pods | `615.1` continuous cores (`74.1%`) | `9,666.4 GB` RAM (`57.5%`)
  - `ui`: `14,338` avg concurrent pods | `199.4` continuous cores (`24.0%`) | `7,145.9 GB` RAM (`42.5%`)
  - `migrator` (`kb-migrator-kb`): **`18.9` avg concurrent pods** (peak `37` in 1m, `1,082` distinct pods over 1h) | **`15.2` continuous cores (`1.8%` of steady-state fleet CPU; peak `30.3` cores/min)** | **`6.0 GB` RAM (`0.04%` of fleet RAM)**, with each pod pegged at **`996–998m` CPU p50** (8x burst over `125m` request) and `317–346 MB` avg working set. *(Correction: an earlier 1h `BY pod.name` sum overcounted ephemeral 30s migrator pods as full-hour pods at `883.5` cores; the true continuous steady-state load is `15.2` cores, while fleet-wide rollouts or cert/secret rotations across ~16,500 projects over ~30m burst to ~200–250+ concurrent cores.)*
- **Volume and channel:** Live query on Production Overview (`serverless-logging-*:logs-kibana*`, 1h window, Nov 28 2026): **`2,473` migrator completions/hour** (`6,774` migrator pods across `6,218` distinct projects in 6h, 100% on `default` channel: `6,440` `production-noncanary`, `338` `production-canary`).
- **99.4% of migrator runs never perform document migration:** Sampling 500 `"Completed all migrations in <X>ms"` log events from `kb-migrator-kb` in the 1h window (Nov 28 2026):
  - Actual migration execution time: **p50 = `189 ms`**, p90 = `3,680 ms`, p95 = `4,672 ms`, p99 = `6,729 ms`, max = `14,151 ms`.
  - Process uptime at completion: **p50 = `28.9 s`**, p95 = `48.1 s` (Node.js + 164–188 plugin boot takes ~99.3% of pod wall time).
  - Duration breakdown: `<100 ms` (pure no-op) = **`44.6%`** (`223/500`); `100 ms–1 s` = **`13.4%`** (`67/500`); `1 s–5 s` = **`37.8%`** (`189/500`); `5 s–10 s` = **`3.6%`** (`18/500`); `>=10 s` (minimum floor when Zero-Downtime migrations, ZDT, enters document conversion due to two `5 s` `metaPickupSyncDelaySec` sleeps) = **`0.6%`** (`3/500`).
  - Cross-checked against 24h OTel histogram `kibana.saved_objects.migrations.time` (`serverless-metrics-*:metrics-generic.otel-*`, 991,284 index migrations across all roles): `<100 ms` = `45.0%`, `100 ms–1 s` = `5.9%`, `1 s–10 s` = `48.8%`, `>=10 s` = **`0.23%`** (`2,292/991,284`).
  - Concrete prod timelines (`logs-kibana*`): `kb-migrator-kb-24rzh` (`security`) booted 176 plugins over `24.7 s` (including `8.5 s` ES connect wait) and logged `Completed all migrations in 35ms`; `kb-migrator-kb-22mzj` (`vectordb`) booted 164 plugins over `26 s` and completed in `1150ms`; `kb-migrator-kb-25wxv` (`observability`) booted 188 plugins over `35 s` (`21.4 s` ES initializing wait) and completed in `2595ms`.

### How `kibana-controller` triggers, runs, and observes `kb-migrator-kb`
- **No Elasticsearch access in controller:** `/Users/bamieh/bamieh/elastic/kibana-controller/go.mod` has no ES client; `kibana-controller` never queries Elasticsearch before spawning a migrator Job.
- **Trigger and hash:** `reconcileMigrationJob` (`kibana-controller/internal/controllers/kibana/job.go:74-111`) hashes the entire desired `batchv1.Job` (`hash.HashObject(*expectedMigrationJob)`). Because `PodTemplateSpec.Annotations` embeds `kibana.k8s.elastic.co/config-hash` (`deployment.go:98-150` — FNV-32a over `tls.crt`, `autoops.crt`, `uiam.crt` [Unified Identity & Access Management], `cluster-internal-cas`, and the full rendered `kibana.yml` Secret) plus the container image tag and env/resources, **any** project creation, Kibana image bump (including stateless releases with zero Saved Objects [SO] changes), TLS cert rotation, CA bundle update, secret change, or `kibana.yml` override spawns a new `kb-migrator-kb` Job. Deduplication (`Status.ObservedMigration` on the `KibanaAppConfig` CRD) only skips unchanged reconciles and Horizontal/Elastic Pod Autoscaler (HPA/EPA) scaling (`kibana-controller#302`).
- **Ordering relative to UI/BT rollouts:** `job.go:106-108` gates Job creation on `Rollout == False && Migrated == False` — meaning `kb-migrator-kb` runs **after** `ui` and `background_tasks` (BT) Deployments have finished rolling out. Because Serverless `ui`/`background_tasks` pods execute the ZDT index-state phase (`CREATE_TARGET_INDEX` / `UPDATE_INDEX_MAPPINGS` / `UPDATE_ALIASES`), on brand-new projects `ui`/`background_tasks` typically create `<prefix>_1` with matching `mappingVersions` and `docVersions` before `kb-migrator-kb` starts (caveat: default readiness probe `/api/_elu_history` in `helm/values.yaml:56-59` is served by preboot before `savedObjects.start()` unless overridden).
- **Pod contract:** Same `kibana-serverless:git-<sha>` Wolfi multi-arch (`amd64`/`arm64`) image (`pod.go:320`, `src/dev/build/tasks/os_packages/docker_generator/run.ts:53-62`), `Command: nil, Args: nil`, differentiated solely by `NODE_ROLES=["migrator"]` (`pod.go:341`, `node/noderoles.go:29`). Sized at `requests: 1Gi / 125m`, `limits: 2Gi / 1` CPU (`helm/values.yaml:168-174`), with `archive-csi-volume` mounted at `/mnt/elastic/diagnostics` for OOM heap snapshots (`pod.go:206-226,379-381`). Init container `elastic-internal-init-config` (`init_configuration.go:26-79`) copies `serverless*.yml` and symlinks `kibana.yml` into `/usr/share/kibana/config`. **Zero probes** (`StartupProbe`, `LivenessProbe`, `ReadinessProbe` are all `nil`; `pod.go:330-335`, `job.go:50-52`) and no Service routes to migrator pods.
- **Completion observation:** `conditions.go:288-302` checks only `Job.Status.{Active,Succeeded,Failed}` (exit `0` vs non-zero). `kibana-controller` does not inspect pod logs, annotations, or HTTP endpoints, though downstream o11y dashboards and PagerDuty ML alerts do consume `kibana.log` and `generic.otel`. `kibana_controller_status_migration` metric maps `{0: Reset, 1: Pending, 2: Failed, 3: Succeeded}` (`metrics.go:23-32`), and `RolloutReporting.ReconciliationCompleted` (`reconciler.go:476-478,710-715`) fires once `Rollout == False && Migrated == True`. `kibana-controller#776` (startup CPU boost) explicitly excludes migrator Jobs as out of scope.
- **Entrypoint chain:** `Dockerfile:92-211` -> `/bin/tini -- /usr/local/bin/kibana-docker` (`bin/kibana-docker:488-519`, bash script translating `NODE_ROLES` to `--node.roles=["migrator"]`) -> `/usr/share/kibana/bin/kibana` -> Node.js.

### How Kibana `node.roles: ['migrator']` boots, migrates, and exits
- **Full plugin boot:** `Server.#preboot()` + `Server.#setup()` (`src/core/packages/root/server-internal/src/server.ts:229-529`) discovers, imports, and runs `setup()` on **every enabled standard plugin** (164–188 plugins on Serverless) — `node.roles: ['migrator']` skips zero plugins during `setup()` (only `alerting` checks `node.roles.migrator` to skip `AlertsService`, `x-pack/platform/plugins/shared/alerting/server/plugin.ts:375-377`). After `savedObjects.start()` completes in `Server.#start()`, `server.ts:619-626` throws `CriticalError(..., 'MigrationOnlyNode', 0)`, skipping `plugins.start()` and `http.start()`, and exits `0` (`bootstrap.ts:159-173`).
- **ZDT algorithm (Serverless default, `config/serverless.yml:112`; legacy `v2` is default on Elastic Cloud Hosted [ECH] / self-managed):**
  - 8 index prefixes in `saved_objects_index_pattern.ts:17-35` (7 currently used: `.kibana`, `.kibana_task_manager`, `.kibana_ingest`, `.kibana_alerting_cases`, `.kibana_security_solution`, `.kibana_analytics`, `.kibana_usage_counters`). Only prefixes with >=1 registered SO type get a migrator (`get_migrator_configs.ts:19-39`).
  - Lock-free and idempotent: index creation catches `resource_already_exists_exception`; `putMapping` is additive; bulk doc rewrites use `if_seq_no` + `if_primary_term`.
  - No-op path (`mappingVersions == appVersions`, `docVersions == appVersions`, base root fields match): **1 ES call per index** (`GET /<prefix>_*?ignore_unavailable=true`), plus optional `POST /_aliases` if `<prefix>_<kibanaVersion>` alias is missing.
  - Fresh-project path (`!currentIndex`): **3 ES calls per index** (`GET /<prefix>_*`, `PUT /<prefix>_1` with inline aliases + `_meta`, `GET /_cluster/health/<prefix>_1?wait_for_status=green`).
  - Document migration path (`mappingVersions` or `docVersions` older, or V2 takeover): executes `PUT /_mapping`, async `_update_by_query`, `CLEANUP_UNKNOWN_AND_EXCLUDED_DOCS` (runs 4 plugin `excludeOnUpgrade` hooks and `discardUnknownDocs: true`), PIT scan + arbitrary TypeScript `modelVersions`/`migrations` transforms (including `@elastic/node-crypto` decrypt/re-encrypt for 29 Encrypted Saved Objects [ESO] types), bulk overwrite, and `_meta.docVersions` update.
- **SO type registration audit (`src/` and `x-pack/`):**
  - ~160–175 production SO types across ~68 files (7 Core types + plugin types). **100% have static JSON `mappings` objects** (zero dynamic/config-computed ES mappings).
  - **The active set of SO types DOES vary at runtime** by: (1) `plugins.allowlistPluginGroups` (`serverless.{es,oblt,security,vectordb}.yml`), (2) per-tier and per-project `<plugin>.enabled` config overrides (`serverless.oblt.logs_essentials.yml`, `serverless.security.essentials.yml`, project overrides), and (3) **5 conditional SO type registrations** inside plugin `setup()`: `logs_shared` (`!isServerless`), `infra` (`xpack.infra.featureFlags.metricsExplorerEnabled`), `streams` (`xpack.streams.canvas.enabled`), `evals` (`xpack.evals.enabled && mode === 'full'`), and `security_solution` (`experimentalFeatures.responseActionsScriptLibraryManagement`).
  - **Data-loss hazard (`elastic/kibana-team#4557`, `#4565`, open):** While `discardUnknownDocs: true` remains active on Serverless ZDT, omitting any enabled SO type during a document-migration run deletes that type's documents.
- **Non-SO side effect that runs during `kb-migrator-kb`:**
  - `DataStreamsService.start()` (`server.ts:580-582`) runs immediately before `savedObjects.start()` with `lazyCreation: true` across **9 registered data streams** (`workflows_execution_engine`, `significant_events`, `evals`). On brand-new projects (streams do not exist), it is pure read-only 404s. On existing projects where a data stream already exists and `deployedVersion < targetVersion` or lifecycle config changed, it executes `PUT /_index_template`, `_simulate` + `PUT /<writeIndex>/_mapping`, and `PUT /_data_stream/<name>/_lifecycle`. (UI/BT pods also run `DataStreamsService.start()` on startup unless `dataStreams.migrations.skip: true`.)
  - No other plugin ES side effects run in migrator mode: `plugins.start()` never runs and `core.getStartServices()` never resolves.
- **In-flight adjacent work and constraints:**
  - **Unified `v3` SO migration algorithm (`elastic/kibana-team#4480`, PR stack `#303042–#303049`, Nov 2026):** Unifies `v2` and `zdt`, removes `convertingDocuments` and both 5s `metaPickupSyncDelaySec` sleeps, makes up-to-date check 1 ES call, and extracts stateless `KibanaMigrator.initialize({ client })` / `migrate({ client })` (`kibana-team#3217`).
  - **Stateless vs stateful releases (`elastic/kibana-team#4001`, Sep 2026):** Explores classifying releases with zero SO/stateful ES changes as stateless.
  - **Server plugin bundling (`elastic/kibana#298557`, open Nov 2026):** Rspack bundles/minifies plugin server JS, reducing warm-start boot CPU by `-22.7%` and duration by `-10.0%` (`-4.4 s`).
  - **No committed `current_mappings.json` (`elastic/kibana-team#3373`, `#3347`):** Core is actively removing checked-in `current_mappings.json` and rejected a statically-committed SO allowlist in favor of CI GCS baselines and the `no_conditional_saved_object_type_registration` ESLint rule.
  - **Native-module policy & FIPS (`packages/kbn-check-prod-native-modules-cli/check_prod_native_modules.ts`, `elastic/kibana#188134`, `#190183`, `elastic/kibana-operations#131`, `#199258`):** Production `.node` addons inside `node_modules` are banned by CI (driven by Serverless V8 pointer compression ABI breakage, single-host `InstallDependencies` -> `CreateArchivesSources` across 10 platforms, macOS signing `#121864`, and disabled `postinstall` `#250638`). Standalone binaries shipped outside `node_modules` via the `BundleFipsProvider` `docker buildx --platform` pattern do not trigger `check_prod_native_modules`, though Wolfi FIPS images (`chainguard-base-fips`) still require FIPS 140-3 OpenSSL linkage and Security SCA review (see `native-modules-policy.md`).

---

## Directions

### `rust-migrator-wrapper`

**How it works:**
During the `kibana-serverless` image build (`src/dev/build/`), run a build-time extraction step (without committing a manifest to git) that emits a compact JSON manifest mapping `(plugin_id, conditional_flags) -> { indexPattern, mappings, latestModelVersion }` plus `removed_types.json`, base root mappings, and the 9 `DataStreams` definitions. Bundle this manifest and a small arch-matched (`x86_64`/`aarch64`) Rust binary (`kibana-migrator`) into the existing `kibana-serverless` Wolfi image. In `bin/kibana-docker`, when `NODE_ROLES=["migrator"]` (initially gated by an opt-in env var rolled out via `kibana-controller`'s `kibana-base-env` / `projectOverrides.kibanaEnv`), `exec` the Rust binary instead of Node.js:
1. Parses `/usr/share/kibana/config/kibana.yml` + `serverless*.yml`, computes the exact active SO type set and expected `mappingVersions`/`docVersions` from the build manifest (resolving `allowlistPluginGroups`, `<plugin>.enabled`, and the 5 conditional flags; falling back immediately if any unrecognized plugin config or `migrations.algorithm !== 'zdt'` is present).
2. Connects to ES (FIPS-compliant TLS using `/mnt/elastic-internal/trust-bundle/ca.crt` + `elasticsearch.*` auth), checks node version compatibility and cluster capabilities (`GET /_nodes/_all/_none`, `GET /`).
3. Inspects each active SO index (`GET /<prefix>_*?ignore_unavailable=true`) and checks existing registered data streams (`GET /_data_stream/<name>`):
   - **No-op fast-path:** All active indices exist under ZDT/`v3`, root fields match, `mappingVersions == appVersions`, `docVersions == appVersions`, and no existing data stream needs template/lifecycle updates -> adds `<prefix>_<kibanaVersion>` alias if missing, emits ECS logs + OTel `kibana.saved_objects.migrations.time`, exits `0`.
   - **Fresh-project fast-path:** Active indices do not exist yet -> runs `PUT /<prefix>_1` (with inline aliases + `_meta`) + `GET /_cluster/health/<prefix>_1?wait_for_status=green`, exits `0`.
   - **Fallback:** On any pending mapping/doc version bump, V2 index takeover, outdated existing data stream, or manifest-unknown config, `exec`s `/usr/share/kibana/bin/kibana` (Node.js) inside the same container with the original arguments.

**What it changes:**
- `elastic/kibana`: new Rust crate + Cargo build integrated into `src/dev/build/` (multi-arch Linux `x86_64`/`aarch64` + FIPS OpenSSL), build-time SO + data-streams manifest generator, branch in `bin/kibana-docker`.
- `kibana-controller`: **zero required changes for v1** (optional follow-up to lower migrator pod CPU/memory requests/limits and skip `archive-csi-volume` when fast-path is default).
- Does **not** touch `node_modules`, so `check_prod_native_modules` is unaffected.

**What it costs:**
- Introduces Rust/Cargo, cross-compilation (`amd64` + `arm64`), and FIPS-validated TLS (`openssl`/Wolfi FIPS linkage) into `elastic/kibana` CI and release pipelines.
- Duplicates a slice of ZDT/`v3` index-state logic, YAML config resolution, and ES auth/retry/TLS handling in a second language that must stay in lockstep with `kibana-team#4480` (`v3`) and any future conditional SO registrations.
- Adds a build-time extraction step that must accurately reflect plugin discovery/enablement rules (including transitive dependency disabling in `plugins_service.ts`) without breaking build times.
- On fallback runs (~0.6% steady-state, higher during stateful rollout waves), adds ~0.2–0.5 s before `exec`ing Node.js.

**What it gives up:**
- Still schedules and runs a Kubernetes Job, init container (`elastic-internal-init-config`), and pod lifecycle on every trigger (cannot eliminate K8s control-plane churn or init-container overhead).
- Cannot accelerate actual document-conversion runs (where TypeScript `modelVersions` transforms and ESO decrypt/re-encrypt execute — e.g. `kibana#303830`).

Challenges:
- `consumers-migration` (Blocker): `kibana-base-env` and `projectOverrides.kibanaEnv` apply to all roles (`pod.go:339-342,459-478`), so env-var rollout/rollback forces a rolling restart of all `ui` and `background_tasks` Deployments — invalidating the "zero `kibana-controller` changes for v1" claim.
- `consumers-migration`: `bin/kibana-docker` is copied into every non-Serverless Docker flavor (ECH `-cloud`, ECK, self-managed, Iron Bank); unguarded `NODE_ROLES` branching breaks images without the serverless binary/manifest and multi-role configs.
- `consumers-migration`: Dropping 2,473 migrator runs/hour of logs/metrics risks paging PagerDuty sev-85 ML alerts (`alert-kibana-logs-drop.tf`, `alert-otel-metrics-low-count.tf`), blinds `dashboard-migration-jobs.tf` without Filebeat-compatible ECS JSON stdout, and requires full multi-protocol OTLP (`grpc`/`proto`/`http`, `delta`, `regional-motel-credentials`, `globalLabels`, exit flush).
- `consumers-migration`: Fails to replicate `compile_config_stack.js` post-`kibana.yml` tier precedence (`serverless.security.<tier>.yml`, `serverless.<mode>.<tier>.yml`), `kibana.keystore`, and runtime `workflowsExecutionEngine.storage.dataRetention`, and omits rollback (`lesser`, skip alias add) vs `conflict` semantics.
- `failure-operations`: Silent skip on manifest omission because `getVirtualVersionsFromMappingMeta` (`model_version_from_mappings.ts:69-77`) filters stored `_meta` by `knownTypes`, returning `equal` and `exit 0` while leaving documents unmigrated; "fall back on any unrecognized plugin config" collides with routine `xpack.*` settings and `enableStripUnknownConfigWorkaround`.
- `failure-operations`: Leaves ES cold-start/retry loops (8.5–21.4 s waits, 401/403/429/503 retries), bounded OTLP flush timeouts (probe-less Job with `ActiveDeadlineSeconds: nil`), mixed per-index state, concurrent `resource_already_exists_exception`, `migrations.skip`, and path/fallback-reason diagnostics unspecified.
- `failure-operations`: Lowering pod limits or removing `archive-csi-volume` while keeping in-container Node.js fallback guarantees OOMKills (exit 137 across all 6 retries) and loses OOM heap snapshots during stateful releases.
- `people-affected`: Omits unasked-for stakeholders — Security/FIPS compliance (140-3 auditing, Cargo SCA/SBOM, Rust CVE patching) and Build/DevEx/CI (cross-compile agents, offline crate vendoring) — and understates review/testing friction on Core TS engineers shipping `v3`.
- `reuse-yagni`: Reinvents existing `extractMigrationInfo`/`takeSnapshot` (`packages/kbn-check-saved-objects-cli`) and `compile_config_stack.js`, bundles unneeded full ES `mappings`, `PUT /<prefix>_1`, `GET /`, `GET /_nodes/_all/_none` (`elasticsearch.ignoreVersionMismatch: true` in `serverless.yml:234`), and `DataStreams` checks (`dataStreams.migrations.skip: true` already exists), and scores an unstated Rust-pattern goal for ~50 cores over Node.
- `false-compromise`: Duplicating ZDT/`v3` write logic and 160–175 full ES mappings in Rust is a false compromise when `ui`/`background_tasks` already run index/alias creation before `kb-migrator-kb` starts — narrowing to a read-only preflight verifier removes write-path duplication (captured as new direction `rust-readonly-preflight`).

### `rust-readonly-preflight` *(added from `false-compromise` and `reuse-yagni`)*

**How it works:**
Narrow `rust-migrator-wrapper` to a **strictly read-only ES preflight verifier** built on a tiny build-time version-only manifest derived from existing `extractMigrationInfo` (`so-type-serializer`) — containing only `{ typeName: latestModelVersion }` per `indexPrefix` and the 13 static base root fields from `getBaseMappings()`, with zero full ES `mappings`, zero `removed_types.json`, and zero ES write logic (`PUT /<prefix>_1`, `POST /_aliases`, `_cluster/health` all dropped). Uses `dataStreams.migrations.skip: true` (or read-only `_data_stream` version check) on migrator nodes. On startup in `migrator` mode, the Rust binary runs `GET /<prefix>_*?ignore_unavailable=true`: if every expected index exists under ZDT/`v3`, contains no unrecognized keys in `_meta`, has matching root fields, `mappingVersions == appVersions` and `docVersions == appVersions` (or valid rollback `lesser`), and already carries `<prefix>_<kibanaVersion>` (for `equal`), it emits structured logs/metrics and exits `0`; on **any** required ES write (`!currentIndex`, missing alias, version bump, V2 takeover, or unknown config), it `exec`s `/usr/share/kibana/bin/kibana` (Node.js).

**What it changes:**
- `elastic/kibana`: tiny version-only manifest emitted via existing `extractMigrationInfo` tooling, small read-only Rust preflight crate + multi-arch Wolfi FIPS build, guarded serverless-only branch in `bin/kibana-docker`.
- `kibana-controller`: needs role-scoped env or non-restarting rollout gate (cannot use all-roles `kibana-base-env` without rolling `ui`/`background_tasks`); pod limits and `archive-csi-volume` remain sized for Node.js fallback.

**What it costs:**
- Retains the Rust/Cargo/multi-arch/Wolfi FIPS toolchain, Security SCA/CVE overhead, OTLP/ECS observability parity, and `compile_config_stack.js` tier-precedence matching costs of `rust-migrator-wrapper`.
- Any run requiring even an alias add or fresh index creation (e.g., if `probes.readiness.path` lets `kb-migrator-kb` beat `ui`/`background_tasks` to `CREATE_TARGET_INDEX`, or projects scaled to zero, or ECH) falls back to full Node.js.

**What it gives up:**
- Does not handle fresh-project index creation or alias writes without falling back to Node.js.
- Still schedules a Kubernetes Job and init container on every trigger and cannot shrink pod limits below full Node.js.

Challenges:
- *(New direction proposed by round-1 lenses; not yet challenged by a fresh round.)*

### `controller-manifest-gate`

**How it works:**
Eliminate the 99% no-op `kb-migrator-kb` Jobs at the source — inside `kibana-controller` (already written in Go) — instead of making a no-op pod boot faster:
1. During `elastic/kibana` build, compute a deterministic **migration fingerprint** per `(project_type, tier)` covering all SO type registrations, base/type mappings, `modelVersions`, `removed_types.json`, and `DataStreams` definitions, and attach it to the container image (OCI label) or release manifest consumed by `kibana-controller` (aligned with `kibana-team#4001` stateless vs stateful releases).
2. In `kibana-controller/internal/controllers/kibana/job.go`, decouple `expectedMigrationHash` from full pod/cert/image churn: key it only on `(migrationFingerprint, pluginEnablementConfigHash)` (ignoring TLS cert rotations, CA bundle updates, LaunchDarkly/UIAM secrets, `NODE_OPTIONS`, and stateless Kibana image bumps).
3. On brand-new project creation, either skip the post-rollout migrator Job (since `ui`/`background_tasks` already ran `CREATE_TARGET_INDEX` before `Rollout == False`) or run it once on creation and never re-run until `migrationFingerprint` or plugin-enablement config changes.

**What it changes:**
- `elastic/kibana`: build-time script computing and publishing the migration fingerprint (OCI label / release artifact metadata).
- `kibana-controller` (Go): changes to `job.go` / `deployment.go` hash computation, `KibanaAppConfig` status/override escape hatch (e.g. force-remigrate annotation for failed-job re-triggers, preserving `kibana-controller#302`), and `serverless-gitops` / promotion pipeline (`gpctl`) plumbing if metadata travels outside the image.

**What it costs:**
- Cross-repo/cross-team release-contract coupling between `elastic/kibana` build, image promotion (`gpctl`), and `kibana-controller`.
- If `kibana-controller` reads OCI labels, it needs registry metadata access (or promotion-time injection into Helm values / `KibanaAppConfig`).
- Risk of false skips: any config change that subtly enables an SO type (one of the 5 conditional flags or a `<plugin>.enabled` override) or changes a `DataStreams` retention/storage setting (`workflows_execution_engine` `storage.source`) MUST be included in `pluginEnablementConfigHash`, or a required migration is silently skipped.
- Requires explicit handling for rollbacks and operator force-retrigger when a prior migration failed or a controller bug is fixed (`kibana-controller#302`).

**What it gives up:**
- Does **not** speed up migrator Jobs when they *do* need to run (every stateful release bumping even 1 SO type still boots full Node.js across all ~16,500 projects, even on the 6 indices that didn't change; brand-new project creation still boots full Node.js if creation runs the Job).
- Does **not** help ECH/on-prem migrations or establish any Rust foundation in Kibana.

Challenges:
- `consumers-migration` (Blocker): Changing `expectedMigrationHash` in `job.go` without updating `common/job/reconcile.go:54,67` and `status.go:68-69` causes an infinite reconcile loop; changing the hash format without a dual-hash bridge invalidates `Status.ObservedMigration` on all ~16,500 projects and triggers an unthrottled fleet-wide migration storm on both rollout and rollback (`r.Rollout` only throttles Deployments, not Jobs).
- `consumers-migration`: Skipping creation Jobs breaks `RolloutReporting.ReconciliationCompleted` and `kibana_controller_status_migration=3` unless status is synthetically advanced, and silently skips document migration on newly created projects backed by restored/pre-existing ES indices (`ui`/`background_tasks` run with `skipDocumentMigration: true`).
- `consumers-migration`: `pluginEnablementConfigHash` omits Observability `pricing.tiers.products`, Security tier selectors, `OptimizedFor`, `projectOverrides.kibanaEnv`, and `workflowsExecutionEngine.storage.dataRetention`; skipped Jobs also pin `dashboard-migration-jobs.tf` (`Last migration image per project`) to stale tags and risk tripping PagerDuty ML log/metric drop alerts.
- `failure-operations`: Failed migrations (`Migration=False`, `Migrated=True`) stop self-healing on `NODE_OPTIONS`/memory overrides, secret fixes, or stateless hotfixes to migrator/transform code; runtime OCI reads introduce a container-registry outage blast radius into K8s reconciliation with no fail-closed contract or audit telemetry for skipped Jobs.
- `people-affected`: Shifts ownership of Kibana internal YAML keys onto Go `kibana-controller` maintainers and forces `elastic/kibana` plugin developers to sync flags across repos, while changing operator recovery expectations.
- `reuse-yagni`: Fuses a trivial single-repo `job.go` hash fix (eliminating cert/CA/UIAM/LD/`NODE_OPTIONS`/resource churn on the non-rollout day we measured) with cross-repo OCI/promotion plumbing, overlooks existing `getMigrationHash`/GCS snapshots, and relies on `Rollout == False` guaranteeing `CREATE_TARGET_INDEX` even though default readiness `/api/_elu_history` is served by preboot before `savedObjects.start()`.
- `false-compromise`: Statically predicting migrations in the controller via OCI labels and config hashes is a false compromise when newly rolled-out `ui`/`background_tasks` pods already know the exact runtime migration state — probing live pods removes static-hash drift and promotion coupling (captured as new direction `runtime-pod-migration-probe`, alongside single-repo `controller-job-hash-decoupling`).

### `controller-job-hash-decoupling` *(split out from `controller-manifest-gate` by `reuse-yagni`)*

**How it works:**
Single-repo `kibana-controller` change only — zero `elastic/kibana` build changes, zero OCI labels, zero `gpctl` promotion plumbing. Decouple migration Job identity across `job.go`, `common/job/reconcile.go`, and `status.go` (using a dual-hash/transition field on `KibanaAppConfig.Status` so rollout and rollback never trigger a fleet storm) from `deploymentParams`'s Deployment-rolling inputs: hash `(image, projectType, tier, migration-relevant rendered config subset)` plus an explicit retry/bump token for failed Jobs, ignoring TLS cert rotations, CA trust bundle updates, LaunchDarkly/UIAM shared-secret rotations, `NODE_OPTIONS`, and unrelated `kibana.yml` settings.

**What it changes:**
- `kibana-controller` only (`job.go`, `common/job/reconcile.go`, `status.go`, `deployment.go`, `kibanaappconfig_types.go`).

**What it costs:**
- Requires careful dual-hash cutover/rollback handling, an escape hatch so `Migration=False` Jobs still re-trigger on overrides/fixes, and maintaining the list of migration-relevant config keys (tiers, conditional SO flags, `kibanaEnv`, `dataRetention`).

**What it gives up:**
- Still spawns full Node.js `kb-migrator-kb` Jobs on every stateless Kibana image bump, stateful release, and project creation (only eliminates non-image cert/secret/config churn).

Challenges:
- *(New direction split out by round-1 `reuse-yagni` lens; not yet challenged by a fresh round.)*

### `runtime-pod-migration-probe` *(added from `false-compromise`)*

**How it works:**
Instead of static OCI fingerprints or build-time manifests, leverage the fact that `job.go:106-108` already waits for `Rollout == False`: the newly rolled-out `ui` and `background_tasks` pods have already booted with the exact runtime image, `compile_config_stack.js` tier precedence, `projectOverrides`, transitive plugin enablement, and 5 conditional flags, connected to ES, run ZDT/`v3` index-state checks (`CREATE_TARGET_INDEX` / `UPDATE_INDEX_MAPPINGS` / `UPDATE_ALIASES`), and run `DataStreamsService.start()`. Expose a lightweight authenticated status contract (HTTP endpoint on the internal Kibana Service or a K8s-mediated status surface) returning `{ configHash, imageTag, savedObjectsReady, needsDocumentMigration }` directly from live `SavedObjectTypeRegistry` + ES `_meta`. `kibana-controller` queries it once `Rollout == False`; if `configHash` and `imageTag` match and `needsDocumentMigration == false`, the controller advances `ObservedMigration` + `Migrated=True` + `Migration=True` without creating a `kb-migrator-kb` Job at all — and fails open to spawning the standard Node.js `kb-migrator-kb` Job whenever pods are scaled to zero, stale, unready, or unreachable, or when `needsDocumentMigration == true`.

**What it changes:**
- `elastic/kibana`: expose `needsDocumentMigration` (comparing `docVersions` vs `appVersions` during `savedObjects.start()` on `ui`/`background_tasks`) alongside `configHash`/`imageTag` on an internal status contract.
- `kibana-controller`: probe the live project status after `Rollout == False` before calling `job.Reconcile`, with fail-open Job creation and synthetic status advancement when skipped.

**What it costs:**
- Requires an authenticated TLS/network path from `kibana-controller` to each project's internal Kibana Service (or a K8s-mediated surface if NetworkPolicy blocks controller-to-pod HTTP).
- Must verify SO type registration never diverges by `node.roles` and tie responses strictly to `(configHash, imageTag)` so stale pods are never trusted.
- Same dashboard (`Last migration image per project`) and ML alert volume-drop coordination as `controller-manifest-gate`.

**What it gives up:**
- Cannot eliminate the Job when `ui`/`background_tasks` are scaled to zero or when document conversion is genuinely required (falls back to full Node.js Job).
- Does not establish Rust tooling in `elastic/kibana` or help ECH/on-prem.

Challenges:
- *(New direction proposed by round-1 `false-compromise` lens; not yet challenged by a fresh round.)*

### `lightweight-node-fast-path`

**How it works:**
Use the exact same build-time SO + data-streams manifest and `bin/kibana-docker` fast-path + fallback architecture as `rust-migrator-wrapper`, **but implement the fast-path runner in TypeScript on the already-bundled Node.js runtime**, importing Core's actual `@kbn/core-saved-objects-migration-server-internal` (`v3`/ZDT state machine), `@kbn/config`, and `@elastic/elasticsearch` directly — skipping `plugins.discover()` and `plugins.setup()` across all 164–188 plugins:
1. `bin/kibana-docker` invokes a tiny bundled Node entrypoint (`bin/kibana-migrator-fast`, bundled with Rspack) when `NODE_ROLES=["migrator"]`.
2. Loads the build-time manifest + `kibana.yml` / `serverless*.yml`, constructs an in-memory `SavedObjectTypeRegistry` (mappings + `modelVersions` version numbers only, no plugin code imported), and runs the **same** ZDT/`v3` `INIT` / `CREATE_TARGET_INDEX` / `UPDATE_ALIASES` code path as full Kibana.
3. On no-op or fresh-project index creation (and clean `DataStreams` check), exits `0` in ~1–2 s (~60–90 MB RSS vs 28.9 s / 345 MB / 998m CPU).
4. On any pending document migration, V2 takeover, or unknown plugin override, spawns/falls back to full `bin/kibana` in the same container.

**What it changes:**
- `elastic/kibana`: build-time manifest generator, small TS entrypoint package reusing `@kbn/core-saved-objects-migration-server-internal` + `@kbn/core-data-streams-server-internal`, Rspack bundle target, branch in `bin/kibana-docker`.
- `kibana-controller`: **zero required changes for v1**.

**What it costs:**
- Same build-time manifest accuracy and transitive-plugin-enablement resolution complexity as `rust-migrator-wrapper` (must track `allowlistPluginGroups`, `<plugin>.enabled`, and the 5 conditional flags).
- Higher per-invocation baseline floor than Rust (~1–2 s startup and ~60–90 MB RSS vs ~0.1–0.3 s and ~15 MB RSS).
- Must keep `@kbn/core-saved-objects-migration-server-internal` cleanly separable from heavy Core/Hapi/plugin imports so the Rspack bundle stays tiny.

**What it gives up:**
- Does not eliminate V8/Node startup cost entirely or allow shrinking migrator pods down to ~32–64 MiB.
- Still runs the Kubernetes Job and init container on every trigger.
- Does not establish a Rust runtime/shipping pattern in `elastic/kibana`.

Challenges:
- `consumers-migration` (Blocker): Gating rollout/rollback via `kibana-base-env` / `projectOverrides.kibanaEnv` rolls all `ui` and `background_tasks` Deployments (`pod.go:339-342,459-478`), breaking the "zero `kibana-controller` changes for v1" claim.
- `consumers-migration`: Both `@kbn/core-saved-objects-migration-server-internal` and `@kbn/core-data-streams-server-internal` are Core-private (entrypoint must live under `src/core/packages/`), and `get_index_details.ts:13` already imports `@kbn/core-elasticsearch-server-internal` (which pulls in HTTP/Security deps in `moon.yml:30,44`), making import decoupling an upfront prerequisite affecting existing callers.
- `consumers-migration`: Same non-serverless `bin/kibana-docker` guard, `compile_config_stack.js` tier/keystore/`dataRetention` precedence, rollback `lesser`/conflict semantics, and PagerDuty ML log-drop alert risks as `rust-migrator-wrapper`.
- `failure-operations`: Same silent manifest-omission skip (`getVirtualVersionsFromMappingMeta` filtering by `knownTypes`), omits ECS JSON logging / `service.node.roles` / `service.id` / `initMetrics` OTel flush / fallback-reason telemetry, and overstates Rust's ~32–64 MiB pod-shrinking advantage (in-container fallback pins limits to Node.js in both).
- `people-affected`: Imposes permanent import-graph/bundle-boundary policing on Core Platform engineers and manifest/dev-prod divergence on plugin developers, without defining CI guardrails or fallback observability.
- `reuse-yagni`: Reinvents existing `extractMigrationInfo`/`takeSnapshot`, `compile_config_stack.js`, and `kbn-migrator-test-kit`; over-scopes by bundling full ES mappings, `CREATE_TARGET_INDEX`, `DataStreams` (`dataStreams.migrations.skip: true` exists), and an upfront Rspack bundle when narrow utilities (`compareVirtualVersions`, `getBaseMappings`, `getAliasActions`) suffice for a no-op check.
- `false-compromise`: Bypassing `PluginsService` with a static build-time manifest and two-process fallback is a false compromise when `PluginsService.discover()` already computes exact plugin enablement before importing `./plugin` — splitting migration registrations into a side-effect-free plugin entrypoint removes manifest drift and accelerates stateful waves too (captured as new direction `split-migrations-entrypoint`).

### `split-migrations-entrypoint` *(added from `false-compromise`)*

**How it works:**
Instead of building a parallel static manifest and a two-process fallback wrapper, keep `kb-migrator-kb` on a single Node.js execution path using Core's existing `PluginsService.discover()` enablement graph (`allowlistPluginGroups`, `<plugin>.enabled`, transitive dependency disabling in `plugins_service.ts:266-380`), and split Saved Object + `DataStreams` registrations (`mappings`, `modelVersions` transforms, `excludeOnUpgrade`, ESO wiring, `DataStreams` definitions) out of plugin `setup()` into a dedicated, side-effect-free `server/migrations.ts` plugin entrypoint (bundled by Rspack). When `node.roles` is `['migrator']`, Core loads only `server/migrations.ts` across enabled plugins instead of importing and running full `setup()` on 164–188 plugins.

**What it changes:**
- `elastic/kibana`: new optional `migrations` server entrypoint contract in `PluginsService`/`PluginWrapper`, lint rules keeping `migrations` entrypoints free of heavy runtime imports and banning new `savedObjects.registerType()` in `setup()`, and migrating the ~68 SO-registering plugins and 3 `DataStreams` plugins.
- `kibana-controller`: **zero required changes** (no env-var toggling, no hash migration, no pod-spec changes).

**What it costs:**
- Cross-team refactor touching ~68 SO-registering plugins and 3 `DataStreams` plugins (plus decoupling `enabled`/deprecation metadata or keeping lazy Zod/Joi schemas fast during `PluginsService.discover()`).
- Slightly higher cold-boot floor (~1–3 s in Node.js) than parsing a single static JSON manifest in Rust, and still schedules K8s Jobs on every trigger.

**What it gives up:**
- Slower upfront delivery (requires refactoring ~68 plugins) and does not eliminate K8s Job/init-container scheduling churn or introduce Rust.
- Gains: eliminates build-time manifest drift, eliminates two-process fallback complexity, preserves 100% ECS/OTel/ESO/tier/config parity, and speeds up **both** no-op runs and stateful document-conversion waves (plus ECH/self-managed).

Challenges:
- *(New direction proposed by round-1 `false-compromise` lens; not yet challenged by a fresh round.)*

### `status-quo-plus-v3`

**How it works:**
Do not build a separate migrator fast-path binary, manifest, or controller gate. Let already-in-flight Core initiatives absorb part of the cost:
1. Rspack server plugin bundling (`elastic/kibana#298557`: measured `-22.7%` warm-start boot CPU, `-10.0%` duration).
2. Unified `v3` SO migrations (`elastic/kibana-team#4480`: 1-call no-op, removes 2x5s `metaPickupSyncDelaySec` sleeps on real doc migrations, introduces stateless `KibanaMigrator.initialize()` / `migrate()`).
3. Deferred `initialize()` lifecycle hook (`elastic/kibana#302748`) and future multi-tenant execution (`kibana-team#3217`, `#2259`).

**What it changes:**
- Nothing new; continues existing Core roadmap items.

**What it costs:**
- Leaves an estimated **~650–700 CPU cores (~17–19% of total Serverless Kibana fleet CPU)** continuously spent booting 164–188 bundled Node.js plugins ~2,473 times/hour to perform `189 ms` p50 of ES checks, for as long as single-tenant `kb-migrator-kb` Jobs exist.
- Does not address the 28.9 s p50 / 48.1 s p95 migrator tail added after every Deployment rollout before `RolloutReporting.ReconciliationCompleted` fires.

**What it gives up:**
- Immediate reclamation of ~700–800 Serverless CPU cores and faster project-creation/rollout completion.

Challenges:
- `reuse-yagni`: Overstates built-in relief — `DeferredInitEngine` (`#302748`) runs after `plugins.start()`, which migrator pods never reach (`server.ts:619-626,707`), ZDT no-op is already 1 ES call per index, and 99.4% of runs never hit the 2x5s sleeps; only `#298557` bundling and unscheduled multi-tenant work (`#3217`/`#2259`) cut migrator CPU.
- `failure-operations`: Omits fleet-wide burst/noisy-neighbor contention — `kb-migrator-kb` requests `125m` CPU with a `1` CPU limit (8x burst, excluded from startup CPU boost), so cluster-wide rotations (`uiam-shared-secrets` via `enqueueAllKibanaAppConfigs`, CA bundles, `kibana-base-yaml`) launch thousands of 998m-burning pods that throttle co-located `ui`/`background_tasks` pods.
- `people-affected`: Does not state who blocks on `RolloutReporting.ReconciliationCompleted` vs customer traffic already live once `Rollout == False`, and carries escalation risk if FinOps expects `#298557`/`v3` to clear the 23% CPU share.
- `false-compromise`: No false compromise found.

---

## Weighed

| Dimension | `rust-migrator-wrapper` | `rust-readonly-preflight` | `controller-manifest-gate` | `controller-job-hash-decoupling` | `runtime-pod-migration-probe` | `lightweight-node-fast-path` | `split-migrations-entrypoint` | `status-quo-plus-v3` |
|---|---|---|---|---|---|---|---|---|
| Fleet CPU reclaimed (of 883.5 cores) | High (~750–850 cores on ~99% runs) | High (~750–850 cores on no-op runs) | High on stateless/cert/config; lower on stateful waves | Medium–High on non-rollout cert/secret/config churn | Very High (skips Jobs on no-op, fresh, and unaffected stateful projects) | High (~700–800 cores on ~99% runs) | High (~700–800 cores, incl. stateful waves) | Low (~150–200 cores from `#298557`) |
| Eliminates K8s Job / init-container churn | No | No | Yes (for gated triggers) | Yes (for non-image churn) | Yes (when `needsDocumentMigration == false`) | No | No | No |
| Algorithm / manifest drift risk vs `v3` | High (Rust write+read reimpl + manifest) | Medium (read-only Rust + version manifest) | Medium (static config-key allowlist) | Medium (static config-key allowlist) | Very Low (live `ui`/`background_tasks` state) | Medium (manifest + private-pkg imports) | None (single Node path via `PluginsService`) | None |
| New build / FIPS / toolchain surface | High (Cargo, multi-arch, FIPS TLS, SCA) | High (Cargo, multi-arch, FIPS TLS, SCA) | Low (Go + OCI/release metadata) | None (Go controller only) | None (TS + Go HTTP/K8s status) | Low (Node/Rspack) | Low (Node/Rspack + ~68-plugin refactor) | None |
| Cross-repo coupling (`kibana-controller`) | Medium (needs role-scoped env or rollout gate) | Medium (needs role-scoped env or rollout gate) | High (build + `gpctl` + controller + dual-hash) | Low (controller-only + dual-hash) | Medium (Kibana status contract + controller probe) | Medium (needs role-scoped env or rollout gate) | None | None |
| Stateful rollout & ECH/on-prem benefit | Fallback to Node | Fallback to Node | Full Node boot on stateful | Full Node boot on stateful | Skips unaffected projects; Node on real doc migration | Fallback to Node | Accelerates stateful doc migrations + ECH | Bundling only |
| Rollout / cutover blast-radius risk | Env-var rolls UI/BT unless role-scoped; ML alert drop | Env-var rolls UI/BT unless role-scoped; ML alert drop | Unthrottled Job storm without dual-hash; failed Jobs stop self-healing | Unthrottled Job storm without dual-hash; failed Jobs stop self-healing | Stale-pod trust / network policy; ML alert drop | Env-var rolls UI/BT unless role-scoped; ML alert drop | Low (same Job/role flow, gradual plugin split) | None |

---

## Open questions

- **What share of the 2,473 migrator runs/hour are project creations vs cert/secret/config rotations vs image rollouts?** Determines how much of the 883.5-core burn `controller-job-hash-decoupling` alone eliminates vs `controller-manifest-gate`, `runtime-pod-migration-probe`, or an in-container fast-path. Can be answered by correlating `kb-migrator-kb` creation timestamps with `kibana-controller` logs (`config-hash` vs image diff vs `project_initialized`) on Overview.
- **What is the actual production `probes.readiness.path` setting, and can newly created Serverless projects ever attach to pre-existing/restored ES indices?** Default `helm/values.yaml:56-59` uses `/api/_elu_history` (served in preboot before `savedObjects.start()`), so `Rollout == False` may not guarantee `CREATE_TARGET_INDEX` finished; and restored clusters could have unmigrated documents. Answerable by `kibana-controller` / `serverless-gitops` owners.
- **How does a rollout day with a real SO `modelVersion` bump change the fallback ratio?** Our Nov 28 2026 sample (`0.6% >=10 s`) reflects a non-rollout day; on a stateful weekly release, any type bump forces fallback on all projects with that plugin enabled. Answerable from Overview `kibana.saved_objects.migrations.time` over the last 14 days covering weekly release windows.
- **Can `kibana-controller` reach each project's internal Kibana Service over TLS (or read a K8s-mediated status surface)?** Determines whether `runtime-pod-migration-probe` is viable without NetworkPolicy or auth architecture changes. Answerable by `kibana-controller` / Serverless Platform security owners.
- **Is introducing a production Rust binary into `kibana-serverless` an explicit strategic goal or purely a means to cut migrator CPU?** Decides whether `rust-readonly-preflight` / `rust-migrator-wrapper` is worth the Cargo + multi-arch + Wolfi FIPS OpenSSL + Security SCA/CVE pipeline over `lightweight-node-fast-path`, `split-migrations-entrypoint`, or controller-side gating. Answerable by the user, Kibana Core tech leads, Build/DevEx, and Security/FIPS compliance teams.
- **How does this sequence with `kibana-team#4480` (`v3` migrations) and `kibana-team#4565` (`discardUnknownDocs`)?** Landing `v3` changes the state machine and `_meta` contract; landing `#4565` removes deletion risk on unknown types (though silent false no-ops on omitted manifest types remain a hazard unless unknown `_meta` keys force fallback). Answerable by Core Saved Objects / Migrations owners.
- **Is `dataStreams.migrations.skip: true` safe on `kb-migrator-kb` pods given `ui`/`background_tasks` already run `DataStreamsService.start()`?** Removes the 9 data streams (including runtime `workflowsExecutionEngine.storage.{source,dataRetention}`) from migrator fast-path scope. Answerable by Core Data Streams & Workflows owners.
