## People Affected by Direction

### `rust-migrator-wrapper`

- **Kibana Core Saved Objects & Migrations engineers**
  - *See / do differently:* Maintain migration state-machine checks, YAML config resolution, `DataStreams` checks, and ES auth/retry/TLS logic in both TypeScript (`kibana-team#4480` `v3`) and a new Rust crate.
  - *Confused / blocked / surprised:* Blocked on Rust toolchain/review bottlenecks when iterating on `v3`; surprised by silent drift between Rust and TS unless CI enforces parity.
  - *Didn't ask for this / cost:* Did not ask for a second language in the migrations path; permanent dual-implementation and lockstep testing tax.
- **Kibana Build / DevEx / CI engineers**
  - *See / do differently:* Integrate Cargo multi-arch (`x86_64`/`aarch64`) cross-compilation, Wolfi FIPS OpenSSL linkage, and a build-time SO/DataStreams manifest extractor into `src/dev/build/` and Buildkite pipelines.
  - *Confused / blocked / surprised:* Build-time regressions, crate caching/offline-vendoring failures, or extraction breakage when plugin discovery rules change.
  - *Didn't ask for this / cost:* Did not ask to turn `elastic/kibana` into a polyglot TS+Rust build; ongoing toolchain, CI image, and Cargo dependency maintenance.
- **Security / FIPS Compliance & Vulnerability Management teams**
  - *See / do differently:* Audit and continuously scan a new compiled Rust binary, its Cargo dependency graph, and its FIPS 140-3 OpenSSL linkage inside `chainguard-base-fips`.
  - *Confused / blocked / surprised:* Unplanned FIPS verification/sign-off and a new CVE triage/patching pipeline outside npm.
  - *Didn't ask for this / cost:* Did not ask for a new language ecosystem in the production artifact; ongoing SCA, CVE remediation, and FIPS re-validation overhead.
- **Kibana plugin & DataStreams developers (~160–175 SO types across 68 files; 9 data streams)**
  - *See / do differently:* Subject to a build-time manifest extractor and static registration rules; local `node scripts/kibana` runs diverge from Serverless Docker `migrator` behavior.
  - *Confused / blocked / surprised:* Adding a new conditional SO registration or runtime `DataStreams` config (e.g. `storage.source`) either breaks the build opaquely or silently misses the manifest, causing skipped migrations or unexpected fallbacks in prod.
  - *Didn't ask for this / cost:* Did not ask for build-time extraction constraints or dev/prod migrator divergence.
- **Serverless On-call / SREs & `kibana-controller` operators**
  - *See / do differently:* Roll out/revert via `kibana-base-env` / `projectOverrides.kibanaEnv`; triage two-path container execution (Rust fast-path vs `exec` Node.js fallback), new Rust error/retry output, and fast-path OTel metrics.
  - *Confused / blocked / surprised:* Toggling the opt-in env var changes the Job hash and triggers a fleet-wide migrator Job storm (especially hazardous during rollback); shrinking pod limits/dropping `archive-csi-volume` OOMKills/breaks fallback runs; mixed Rust+Node stdout or drifted OTel/ECS logs break dashboards and alerts.
  - *Didn't ask for this / cost:* Did not ask for dual-runtime migrator debugging or a hazardous kill switch.
- **Serverless Release Managers & Cloud Infrastructure / FinOps**
  - *See / do differently:* Reclaim ~750–850 CPU cores on steady-state/stateless runs and shorten `RolloutReporting.ReconciliationCompleted` tail; stateful releases still fall back to full Node.js.
  - *Confused / blocked / surprised:* Stateful weekly releases will spike CPU back to full Node.js levels (and fail if pod limits were lowered for fast-path).
- **Serverless customers**
  - *See / do differently:* Largely invisible on happy path.
  - *Confused / blocked / surprised:* Hit broken features or missing mappings if a manifest omission causes a silent no-op (`exit 0`) instead of migrating.

### `controller-manifest-gate`

- **`kibana-controller` maintainers (Go)**
  - *See / do differently:* Replace opaque full-Job hashing with `(migrationFingerprint, pluginEnablementConfigHash)` parsing/tracking of Kibana config keys, OCI/manifest ingestion, rollback handling, and a force-remigrate escape hatch (`KibanaAppConfig`).
  - *Confused / blocked / surprised:* Must know which Kibana YAML keys affect SO types or `DataStreams` across a separate repo; a missed key silently skips migrations.
  - *Didn't ask for this / cost:* Did not ask to own Kibana internal plugin/SO/DataStreams config semantics inside the Go control plane.
- **Release / Image Promotion (`gpctl`, `serverless-gitops`) & Kibana Build engineers**
  - *See / do differently:* Compute and publish deterministic per-`(project_type, tier)` migration fingerprints and plumb them via OCI labels or Helm/`KibanaAppConfig` promotion metadata.
  - *Confused / blocked / surprised:* Contract breakage across build, promotion, and controller deploys; rollback metadata mismatches.
  - *Didn't ask for this / cost:* Did not ask for a new cross-repo release-artifact metadata contract.
- **Kibana plugin & DataStreams developers**
  - *See / do differently:* Must keep any new conditional SO flag, `<plugin>.enabled` override, or `DataStreams` storage/retention key registered in `kibana-controller`'s hash inputs.
  - *Confused / blocked / surprised:* Editing `elastic/kibana` without knowing a separate Go controller filters `kibana.yml` keys leads to silently skipped migrations in production.
  - *Didn't ask for this / cost:* Cross-repo coordination burden they will easily forget.
- **Serverless On-call / SREs & Release Managers**
  - *See / do differently:* Far fewer `kb-migrator-kb` Jobs and less K8s churn on cert/secret/stateless rollouts; must use an explicit force-remigrate escape hatch after failed migrations or controller bugs.
  - *Confused / blocked / surprised:* Fixing a broken secret or applying a `kibana.yml` override no longer auto-retriggers a failed migration; reading OCI labels at reconcile time exposes reconciliation to registry outages/rate limits; skipped Jobs change `kibana_controller_status_migration` and `kibana.saved_objects.migrations.time` baselines on dashboards/alerts.
- **Serverless customers & Cloud Infrastructure / FinOps**
  - *See / do differently:* Saves K8s Job/init-container churn and CPU on stateless/cert/config triggers; stateful releases still boot full Node.js across all ~16,500 projects.
  - *Confused / blocked / surprised:* Customers hit broken projects if a per-project override or new feature flag is omitted from `pluginEnablementConfigHash`.

### `lightweight-node-fast-path`

- **Kibana Core Platform / Saved Objects / DataStreams engineers**
  - *See / do differently:* Maintain the build-time manifest extractor, a new Rspack-bundled TS entrypoint (`bin/kibana-migrator-fast`), and strict import isolation in `@kbn/core-saved-objects-migration-server-internal` and `@kbn/core-data-streams-server-internal`.
  - *Confused / blocked / surprised:* Any casual transitive import from Core/Hapi/telemetry silently bloats bundle size, RSS, and startup time (or breaks CI if guarded).
  - *Didn't ask for this / cost:* Ongoing import-graph hygiene and bundle-boundary enforcement on internal Core packages.
- **Kibana plugin & DataStreams developers**
  - *See / do differently:* Same build-time manifest extraction and dev/prod `migrator` divergence as `rust-migrator-wrapper`.
  - *Confused / blocked / surprised:* Same silent-skip / extraction-breakage risk for conditional SO registrations and runtime `DataStreams` config overrides.
  - *Didn't ask for this / cost:* Build-time extraction constraints they did not request.
- **Serverless On-call / SREs & `kibana-controller` operators**
  - *See / do differently:* Same `kibana-base-env` rollout/kill-switch Job-storm hazard and two-path container execution (fast Node entrypoint spawning full `bin/kibana` on fallback); lower risk of algorithm/error-format divergence than Rust, but logging/OTel parity is unaddressed.
  - *Confused / blocked / surprised:* Missing OTel metrics/ECS logs if Core telemetry setup is bypassed to keep RSS at ~60–90 MB; unclear fallback diagnostics.
- **Kibana Build / CI engineers**
  - *See / do differently:* Add one Rspack bundle target and build-time manifest generation using existing Node/Rspack tooling (no Rust/FIPS toolchain).
  - *Didn't ask for this / cost:* Modest extra build step and CI time.
- **Serverless customers & Cloud Infrastructure / FinOps**
  - *See / do differently:* Reclaims ~700–800 CPU cores while keeping K8s Job/init-container churn; same silent-skip risk to customers if manifest misses a type.

### `status-quo-plus-v3`

- **Cloud Infrastructure / FinOps / Serverless Platform capacity owners**
  - *See / do differently:* Continue paying for ~650–700 CPU cores (~17–19% of Serverless Kibana fleet CPU) and 2,473 ephemeral Jobs/hour after `#298557` and `#4480` land.
  - *Didn't ask for this / cost:* Unreclaimed fleet CPU and K8s scheduling overhead until multi-tenant execution (`#3217`, `#2259`) materializes.
- **Serverless On-call / SREs**
  - *See / do differently:* Zero new tooling, failure modes, or observability changes; continue absorbing CPU pressure from ~1,082 concurrent 1-core migrator pods.
- **Serverless Release Managers & Customers**
  - *See / do differently:* Continue seeing the `28.9 s` p50 / `48.1 s` p95 migrator tail before `RolloutReporting.ReconciliationCompleted` fires on every rollout/cert/config trigger.
- **Kibana Core, Plugin, Build, Security, and `kibana-controller` engineers**
  - *See / do differently:* No unplanned scope; Core stays on `#298557`, `#4480`, `#302748`, `#3217`, `#2259`.
  - *Confused / blocked / surprised:* Risk of later emergency escalation if FinOps/leadership expects `#298557`/`v3` to solve the 23% CPU share and it still leaves ~17–19%.

---

## Findings

```
Severity: Major
Where: `rust-migrator-wrapper` (lines 58, 62) and `lightweight-node-fast-path` (line 122)
Finding: Lowering migrator pod memory/CPU limits or removing `archive-csi-volume` breaks the in-container fallback path. Line 58 states that on any fallback, the Rust binary "`exec`s `/usr/share/kibana/bin/kibana` (Node.js) inside the same container", and Context lines 6 and 19 show Node.js migrator pods average `317–346 MB` working set (`limits: 2Gi / 1` CPU). Yet line 62 proposes an "(optional follow-up to lower migrator pod CPU/memory requests/limits and skip `archive-csi-volume` when fast-path is default)" and line 122 penalizes `lightweight-node-fast-path` for not allowing "shrinking migrator pods down to ~32–64 MiB". Any `kibana-controller` engineer acting on those lines would cause OOMKills (and missing-volume failures if Node uses `archive-csi-volume`) on every fallback run and stateful weekly release.
Suggestion: Clarify that pod limits and volumes must remain sized for full Node.js as long as fallback runs in the same container, and remove the ~32–64 MiB shrinking advantage unless fallback spawns a separate full-sized Job.
```

```
Severity: Major
Where: `rust-migrator-wrapper` (lines 51, 62), `lightweight-node-fast-path` (lines 106, 114), `Weighed` (line 160)
Finding: The proposed rollout and kill-switch mechanism contradicts the "zero `kibana-controller` changes / coupling" claim and creates a fleet-wide Job storm hazard for SREs. Line 51 gates the fast-path with "(initially gated by an opt-in env var rolled out via `kibana-controller`'s `kibana-base-env` / `projectOverrides.kibanaEnv`)" (reused by `lightweight-node-fast-path`, line 106), while Context line 17 explicitly establishes that `reconcileMigrationJob` hashes `env/resources` so any env change "spawns a new `kb-migrator-kb` Job." Toggling `kibana-base-env` on—or reverting it during an incident—will trigger migrator Jobs across every affected project simultaneously (and on rollback, boot full Node.js fleet-wide), directly impacting `kibana-controller` operators and SREs despite lines 62, 114, and 160 claiming no v1 coupling.
Suggestion: Document the env-var hash-churn blast radius and specify a staged rollout/kill-switch strategy (such as per-channel or controller-ignored env) rather than claiming zero v1 `kibana-controller` involvement.
```

```
Severity: Major
Where: `rust-migrator-wrapper` (lines 51–58), `lightweight-node-fast-path` (lines 106–117), `Open questions` (line 171)
Finding: The manifest-fallback safety boundary is underspecified and understates customer and plugin-developer impact when a type or runtime config is missed. Line 53 promises "falling back immediately if any unrecognized plugin config ... is present" without defining how ordinary runtime `xpack.*` configs are separated from migration-affecting flags, and neither fast-path direction accounts for runtime `DataStreams` settings such as `workflows_execution_engine` `storage.source` (flagged only under `controller-manifest-gate`, line 93). Meanwhile line 171 asserts that "landing `#4565` removes the data-loss risk if a plugin is omitted from the manifest," overlooking that an omitted SO type or unmodeled conditional flag still causes silent false no-ops (`exit 0` without migrating) or incomplete fresh-project indices—breaking customer workloads while reporting `Succeeded` to SREs—and the doc omits what CI guardrail protects plugin developers when they add or change registrations.
Suggestion: Define what makes a plugin config "unrecognized" vs safe to ignore, account for runtime `DataStreams` config and silent false no-ops after `#4565`, and specify how plugin PRs are checked against the manifest extractor.
```

```
Severity: Major
Where: `rust-migrator-wrapper` (lines 61, 65–66) and `Open questions` (line 170)
Finding: Key stakeholders who did not ask for Rust in `elastic/kibana` and who carry ongoing operational/compliance costs are omitted from the cost analysis and decision owners. Lines 65–66 briefly note Cargo, cross-compilation, FIPS linkage, and duplicating ZDT/`v3` logic, and line 170 says deciding whether to ship Rust is "Answerable by the user / Kibana Core tech leads." This leaves out Security/FIPS compliance teams (FIPS 140-3 auditing/verification of the Rust binary's OpenSSL linkage, Cargo SCA/SBOM, and Rust CVE emergency patching) and Build/DevEx/CI engineers (maintaining cross-compile agents, Rust toolchains, offline crate vendoring/mirrors, and dependency updates), and understates the day-to-day review/testing block on Core TypeScript engineers shipping `v3` (`kibana-team#4480`).
Suggestion: Add Security/FIPS and Build/DevEx/CI teams to the affected-cost list in `rust-migrator-wrapper` and as required decision-makers in the Rust open question.
```

```
Severity: Major
Where: `rust-migrator-wrapper` (line 56) and `lightweight-node-fast-path` (lines 106–110)
Finding: SRE/on-call observability, error-handling, and fallback-diagnostics requirements are missing or hand-waved for both in-container fast-paths. Context line 13 shows production migrator pods routinely wait `8.5 s–21.4 s` for ES connect/init, and line 12 relies on the `kibana.saved_objects.migrations.time` OTel histogram. Yet `rust-migrator-wrapper` (line 56) only states "emits ECS logs + OTel `kibana.saved_objects.migrations.time`" with no mention of ES retry/backoff parity, logger/error-format parity, OTLP exporter/resource-attribute parity, or telemetry distinguishing fast-path vs fallback runs (and fallback reasons); `lightweight-node-fast-path` (lines 106–110) omits ECS logging and OTel emission entirely. On-call responders would face broken dashboards/alerts, mixed dual-process stdout on fallback, or invisible fallback regressions that silently re-introduce 800 cores of CPU burn.
Suggestion: Explicitly state the logging, OTel metric/attribute, ES-wait/retry, and fast-path-vs-fallback observability obligations (and implementation cost) for both fast-path directions.
```

```
Severity: Major
Where: `controller-manifest-gate` (lines 83, 88, 91–94)
Finding: The cross-team operational burdens and SRE surprises in `controller-manifest-gate` are understated. Line 93 notes that any config change enabling an SO type or modifying `DataStreams` retention/storage "`MUST` be included in `pluginEnablementConfigHash`, or a required migration is silently skipped," which silently shifts ownership of Kibana internal YAML keys onto `kibana-controller` maintainers and forces `elastic/kibana` plugin developers to coordinate across repos whenever they add a relevant flag. In addition, line 92 allows `kibana-controller` to read OCI labels (introducing a runtime container-registry dependency into K8s reconciliation for SREs), and lines 83–94 do not address how SREs/Release Managers handle the behavior change where fixing a secret or `kibana.yml` no longer auto-retriggers a failed Job, or how dashboards/alerts using `kibana_controller_status_migration` and `kibana.saved_objects.migrations.time` distinguish skipped migrations from runs.
Suggestion: Surface the cross-repo plugin-to-controller config-sync problem (e.g. shipping the relevant key list in the artifact rather than hardcoding in Go), the registry-outage risk of live OCI reads, and the dashboard/alert and operator-workflow changes for skipped Jobs.
```

```
Severity: Major
Where: Context (line 18), `rust-migrator-wrapper` (line 57), `lightweight-node-fast-path` (line 109), `status-quo-plus-v3` (lines 142, 146), `Weighed` (line 161)
Finding: The document contradicts itself on whether `kb-migrator-kb` ever performs fresh-project index creation and does not state who is blocked by `Migrated == True`. Context line 18 states `kb-migrator-kb` runs after `ui`/`background_tasks` finish rolling out and "on brand-new projects `ui`/`background_tasks` have already created `<prefix>_1` with matching `mappingVersions` and `docVersions` before `kb-migrator-kb` even starts." Yet lines 57, 109, and 161 design and credit a "Fresh-project fast-path" (`PUT /<prefix>_1` + embedding all ~160–175 static SO mappings in the manifest), which imposes manifest/mapping maintenance on Core and plugin teams for a path Serverless migrator pods appear never to take—and under-credits `controller-manifest-gate`, which line 84 notes could skip the post-rollout Job entirely on brand-new projects. Separately, line 146 claims `status-quo-plus-v3` gives up "faster project-creation/rollout completion" without stating whether customer project access blocks on `RolloutReporting.ReconciliationCompleted` (line 142) or is already live once `Rollout == False`.
Suggestion: Reconcile whether `kb-migrator-kb` ever hits `!currentIndex` on Serverless (if not, a no-op-only fast-path avoids shipping full ES mappings), fix row `Fresh-project & single-type stateful rollout speed` in `Weighed`, and name who actually waits on `RolloutReporting.ReconciliationCompleted`.
```

```
Severity: Nit
Where: `controller-manifest-gate` (line 98)
Finding: Line 98 lists "Does **not** help ECH/on-prem migrations" as a drawback specific to `controller-manifest-gate`, even though `rust-migrator-wrapper` (lines 51, 53) and `lightweight-node-fast-path` (line 106) only bundle into `kibana-serverless` and immediately fall back whenever `migrations.algorithm !== 'zdt'` (defined on line 25 as the "Serverless default"). As written, none of the four directions help ECH/on-prem operators.
Suggestion: Either remove the asymmetric ECH/on-prem drawback from `controller-manifest-gate` or note explicitly that the in-container directions only enable ECH/on-prem as a future follow-up after `v3` and non-serverless packaging.
```

```
Severity: Nit
Where: Context (lines 11, 17, 18, 25, 30, 36), `rust-migrator-wrapper` (line 62), `controller-manifest-gate` (lines 83, 88, 92, 98), `status-quo-plus-v3` (line 142)
Finding: Several project-specific acronyms and internal resources are used without definition: `ZDT` (line 11+), `SO` (line 17+; `savedObjects` first appears on line 24), `EPA` (line 17), `UIAM` (lines 17, 83), `V2` / `V2 takeover` (line 30+), `archive-csi-volume` (line 62), `KibanaAppConfig` (lines 88, 92), `ECH` (line 98), and `RolloutReporting.ReconciliationCompleted` (line 142). In addition, `background_tasks` is abbreviated inconsistently as `BG` (`UI/BG`, line 18) and `BT` (`UI/BT`, line 36).
Suggestion: Expand project-specific acronyms on first use, briefly gloss `archive-csi-volume`, `KibanaAppConfig`, and `RolloutReporting.ReconciliationCompleted`, and use one abbreviation for `background_tasks`.
```

Read: /Users/bamieh/.claude/plugins/cache/bamieh-skills/dev/5.2.0/skills/review-doc/personas/people-affected.md, /Users/bamieh/bamieh/elastic/kibana/docs/pocs/2026-11-28-rust-migrator-fast-path/explorations.md
