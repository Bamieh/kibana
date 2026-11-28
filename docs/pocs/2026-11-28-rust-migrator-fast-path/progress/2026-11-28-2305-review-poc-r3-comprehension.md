## How the system works today, per this document

In Elastic Cloud Serverless, `kibana-controller` manages each project's `ui` and `background_tasks` serving Deployments plus a short `kb-migrator-kb` Kubernetes Job. Whenever an image rollout, certificate or secret rotation, or config change alters the migrator Job hash, `kibana-controller` rolls out the serving Deployments first—where serving pods set up Saved Objects indices and mappings and update Kibana Data Streams—and then runs `kb-migrator-kb` to handle document conversions and projects scaled to zero replicas, finishing project reconciliation reporting only after the Job exits. Every `kb-migrator-kb` run boots the full Kibana Node.js server and all 164 to 188 enabled plugins (28.9 s median uptime, 345 MiB memory, roughly 1 CPU core despite a 125 millicore request), even though over 99% of runs finish migration work in under 10 s (189 ms median) without entering document conversion. Steady-state fleet migrator load is small (15.2 continuous cores), but fleet-wide stateless image releases and certificate or secret rotations across roughly 16,500 projects create an estimated 200 to 250 concurrent core burst and add a 28.9 s tail to reconciliation reporting, though monitoring does not yet separate the share of the 2,473 hourly Jobs coming from rotations versus stateless releases versus project creations.

## What this proposes

First, a Gate 1 telemetry audit will measure the trigger split across rotations, stateless releases, and project creations plus wave CPU throttling, pivoting to `kibana-controller` Job hash decoupling first if non-image rotations cause over 80% of bursts. Otherwise, Serverless Kibana images will package a compact (~26 KB) build-time Saved Object version manifest—backed by CI static checks on registration calls—and the Kibana launcher will run a lightweight, read-only Node.js preflight verifier before booting full Kibana whenever the manifest exists, the migrator-only environment variable is set, and a new hash-excluded `kibana-controller` rollout toggle is enabled. The preflight reuses Kibana's configuration, keystore, and TLS builders to verify read-only exact-match Saved Objects index, version, and alias invariants against Elasticsearch, skips Kibana Data Streams (deferring updates on scaled-to-zero projects until a serving pod wakes up), emits matching ECS logs and per-prefix OTLP duration metrics, and exits 0 (targeting under 500 ms wall time, 300 ms CPU, and 150 MiB memory) when no write is needed. On any mismatch, missing index or alias, connection error, or unexpected state, it exits non-zero so the launcher replaces itself (`exec`) with full Kibana; `kibana-controller` also gains an explicit rerun token for retroactive full runs and an evaluation of a serving pod status startup probe for readiness races.

---

Severity: Blocker
Where: `End result` — Build time version manifest, Index and alias invariants, Observability parity, and Gate 3 (lines 23, 27, 29, 34)
Finding: The document lists manifest fields and Elasticsearch invariants but omits how the preflight connects them with project configuration to determine expected state. Line 27 says the preflight "reads every active Saved Object index", line 29 exports metrics "once per index prefix", and lines 34 and 42 fail closed on a "missing index", yet line 23's manifest contents do not include index prefixes or type-to-index mappings—leaving unstated how the preflight knows which indices must exist when one is missing. Line 23 also captures "each plugin's enablement path and Serverless default, the full transitive required plugin graph (including dependencies that own no Saved Object types)" and line 34 tests a "transitively disabled plugin", without explaining how project config plus that graph resolves the expected active type set or whether stored versions for "manifest known disabled plugins" (line 27) are skipped from exact-equality comparison or still checked.
Suggestion: State how the preflight combines loaded config and the manifest to derive the expected index prefixes and expected per-type versions, and explicitly specify whether disabled plugins' stored versions are excluded from version equality checks.

Severity: Major
Where: `End result` — Build time version manifest and Conditional registration guardrails; `Decisions` #4 (lines 23–24, 34, 61)
Finding: Several project-specific concepts and mechanisms are used without defining them or explaining how they work: "active and work in progress types" (lines 23–24, 34, 42), "conditionally registered types" and "unmodeled conditional flag" (lines 23–24, 34, 61), and "statically verifies every Saved Object registration call (including helper function indirection and inline lint suppressions) against the manifest's conditional registry" (line 24). A reader cannot tell what makes a type "work in progress" or why an active one forces fallback, how a modeled conditional flag is collected by the temporary build server (if off by default) and evaluated at runtime versus an unmodeled flag, or what CI actually allows or rejects for helper indirection and inline lint suppressions.
Suggestion: Briefly define work-in-progress and conditionally registered types, distinguish build-time and runtime handling of modeled versus unmodeled flags, and state the rule CI enforces on helper wrappers and lint suppressions.

Severity: Major
Where: `End result` — Index and alias invariants, Data Streams deferral; `Risks and assumptions` (lines 27–28, 72–73)
Finding: The version alias lifecycle does not connect consistently across sections, obscuring both readiness-race scope and scaled-to-zero deferral. Line 27 defines the current Kibana version alias as "(attached per release by serving pods)", while line 72 says "Because every Kibana version bump requires a new version alias, a migrator Job can start before serving pods finish creating indices or version aliases on both new projects and version bumping stateless rollouts." If every release attaches a new version alias, then on scaled-to-zero projects (where no serving pod ran) every release would hit a missing version alias and fall back to full Kibana—meaning Data Streams updates would not defer on releases (lines 28, 73), only on same-version config or rotation runs; conversely, if Serverless ships stateless releases without changing the version alias, line 27's "attached per release" is inaccurate.
Suggestion: State explicitly whether every Serverless release creates a new version alias or only version-bumping releases, and clarify which scaled-to-zero triggers take the fast path and defer Data Streams updates.

Severity: Major
Where: `Decisions` #2 and #6 (lines 54, 66–67) vs. `End result` stop criteria and `Risks and assumptions` (lines 36, 72)
Finding: The sequencing of the serving pod status startup probe contradicts itself. Decision 6 (lines 66–67) lists "`kibana-controller` team scheduling for ... evaluating a serving pod status startup probe" as an open item that blocks "production canary enablement", and Decision 2 (line 54) says "We will also evaluate adding a serving pod status startup probe alongside this work." However, line 36 and line 72 treat fixing the startup probe as a pivot triggered after canary telemetry shows missing-index or missing-alias fallback rates above 20%.
Suggestion: Decide whether the startup probe is deferred until canary telemetry exceeds 20% fallbacks (removing it as a canary blocker in Decision 6) or required before canary (with an explicit criterion for what "evaluating" must conclude).

Severity: Major
Where: `End result` — Observability parity (line 29)
Finding: Line 29 leaves an open design and performance question unowned: "(including a single cluster info query if dashboards require cluster identity)". Whether that extra Elasticsearch round-trip and log field are required affects both the 500 ms latency budget and the ECS log schema, yet it is not tracked in Gate 1 or Decision 6, forcing a spec writer to reopen it.
Suggestion: Resolve whether dashboards require cluster identity now, or move that check into Gate 1 or Decision 6 and state what it blocks.

Severity: Major
Where: `Risks and assumptions` — Readiness race and Scaled to zero deferral (lines 72–73)
Finding: Three Kibana-internal HTTP startup terms are introduced without definition and appear to conflict: line 72 says "Even though Kibana's full preboot HTTP server is disabled in Serverless, `kibana-controller`'s default Kubernetes readiness probe polls Kibana's internal event loop utilization endpoint, which answers healthy before Saved Objects initialization finishes", while line 73 immediately states "User requests are still protected because Kibana's temporary startup HTTP listener returns HTTP 503 to all user traffic until both Saved Objects and Data Streams initialization complete". A reader outside the project cannot tell how a disabled preboot server coexists with an active temporary startup listener or why the readiness probe targets a separate event-loop endpoint.
Suggestion: Add one sentence explaining how the temporary 503 startup listener differs from the disabled preboot HTTP server and why the readiness probe hits a separate event-loop endpoint before initialization completes.

Severity: Major
Where: `End result` — Build time version manifest, Index and alias invariants, Gate 3, and Given/When/Then (lines 23, 27, 34, 40, 42)
Finding: Project-specific Saved Objects storage terms are used without definition and shift mid-document: "base root index fields" / "root field drift" (lines 23, 27, 34, 40, 42) never explains what root fields exist on a Saved Object index or why per-type model versions do not cover them; "global alias" (lines 27, 34, 40, 42) is undefined unlike "current Kibana version alias"; and line 34 introduces "disabled plugin metadata, unknown metadata key" without having explained that stored type names and versions (line 27) live as keys in index metadata.
Suggestion: Briefly gloss base root index fields, the global alias, and per-type index metadata on first mention, and use the same term in lines 27 and 34.

Severity: Major
Where: `Decisions` #1 (lines 7, 46, 53)
Finding: Two Kibana runtime concepts appear without explanation, and one clashes with the opening. Line 46 cites "avoids loading Kibana's APM preload on noops" as a reason for launcher dispatch without defining what the APM preload is or how the launcher skips it after loading hardening and FIPS environment settings (line 25). Line 53 rejects waiting on "deferred plugin initialization (which runs after server start and therefore after migrator exit)", which reads as contradicting line 7 ("boots the full Kibana Node.js server") unless the reader already knows Kibana's boot phases and that `kb-migrator-kb` exits before HTTP server start.
Suggestion: Define Kibana's APM preload in a phrase (noting how the preflight avoids it) and clarify that `kb-migrator-kb` initializes all plugins and runs migrations before exiting prior to HTTP server start.

Severity: Major
Where: `Decisions` #2 (lines 54, 76)
Finding: Decision 2 adds "an explicit migrator Job rerun token in `kibana-controller`" that "lets operators force retroactive full Kibana reruns after a bad manifest", without explaining how the token triggers a rerun (for example, whether it is an operator-set field included in the migrator Job hash—unlike the hash-excluded rollout toggle—so bumping it creates a new Job without rolling serving Deployments) and without weighing any alternative against adding a new controller field.
Suggestion: Explain in one sentence how the rerun token triggers only the migrator Job and note what alternative (such as manual Job deletion) was weighed against it.

Severity: Major
Where: `Why` (line 15); `End result` — Launcher dispatch, Strict exact match verification, and Scenario 4 (lines 25–26, 43)
Finding: Scenario 4 (line 43) states that given "an invalid multi role configuration containing migrator", "the fast path is bypassed completely and full Kibana runs unchanged". That contradicts line 26, where the preflight itself loads the configuration stack and "confirms the resolved node role is strictly migrator only"—meaning a multi-role conflict coming from configuration files rather than the environment variable (line 25) is caught inside the preflight and falls back rather than bypassing the fast path completely. Additionally, "roles" / "node role" / "migrator role" (lines 15, 25–26, 43) is used without first stating that Kibana assigns `ui`, `background_tasks`, and `kb-migrator-kb` via node roles and forbids combining migrator with other roles.
Suggestion: Define Kibana node roles briefly in the opening and clarify in Scenario 4 that env-level multi-role configs bypass the launcher while config-level multi-role conflicts fail closed from the preflight to full Kibana.

Severity: Nit
Where: `Opening` (line 7) and `Decisions` #1 & #4 (lines 52, 62)
Finding: Line 7 says every migrator Job boots "all 164 to 188 enabled plugins", while lines 52 and 62 refer to "roughly 68 plugins" without explaining what the 68-plugin subset is (presumably plugins that register Saved Object types).
Suggestion: Qualify "roughly 68 plugins" on first mention in line 52 (for example, "roughly 68 plugins that register Saved Object types").

Severity: Nit
Where: `Opening` — `Where we'll be` (lines 7–8)
Finding: Line 8 targets "under 500 ms median local wall time", where "local wall time" is ambiguous before line 33 defines the warm local Elasticsearch mock benchmark and does not directly mirror "28.9 s median uptime" in line 7.
Suggestion: Replace "local wall time" in line 8 with "container wall time against a local Elasticsearch mock" or "container wall time (benchmarked locally)".

Severity: Nit
Where: `End result` (lines 20, 22)
Finding: Line 20 introduces the bullet list with "When this work is done, Serverless `kb-migrator-kb` containers run a read only Node.js preflight verifier before full Kibana starts:", but the first bullet (line 22) is "Gate 1 telemetry audit: Before investing in production rollout plumbing...", which is a prerequisite investigation rather than finished container behavior.
Suggestion: Move the Gate 1 telemetry audit bullet out of the container behavior list into the gates paragraph (lines 31–32).

Severity: Nit
Where: `End result` — Strict exact match verification (lines 26–27)
Finding: Line 26 references "Serverless Zero Downtime settings" one bullet before "Zero Downtime format (in place mapping and document updates without reindexing)" is defined on line 27, and "fails closed on any unexpected migration or plugin loading override" does not indicate which overrides are considered expected.
Suggestion: Move the parenthetical definition of Zero Downtime to its first mention on line 26 and briefly name the expected migration/plugin override category.

Severity: Nit
Where: `End result` — Gate 2 and stop criteria; `Decisions` #1 & #5 (lines 33, 36, 46, 64)
Finding: Gate 2 (line 33) requires "CPU time under 300 ms" alongside wall time under 500 ms and peak memory under 150 MiB, but the stop/pivot criteria (line 36) and Decision 1 and 5 "Fails when" clauses (lines 46, 64) omit the 300 ms CPU budget.
Suggestion: Include the 300 ms CPU limit in lines 36, 46, and 64—or clarify that it is informational rather than a pivot trigger.

Severity: Nit
Where: `End result` — Given/When/Then scenario 1 (line 40)
Finding: Scenario 1 pairs a singular trigger ("when `kb-migrator-kb` runs") with an aggregate benchmark outcome ("exits 0 with median wall time under 500 ms"), conflating a single-run behavioral scenario with Gate 2's 30-run benchmark.
Suggestion: Phrase Scenario 1 either across repeated runs ("across 30 fresh container runs") or as a single-run functional scenario while leaving the median target in Gate 2.

Read: `/Users/bamieh/.claude/plugins/cache/bamieh-skills/dev/5.3.1/skills/review-doc/personas/comprehension.md`, `/Users/bamieh/.claude/plugins/cache/bamieh-skills/dev/5.3.1/skills/review-doc/standards/poc.md`, `/Users/bamieh/bamieh/elastic/kibana/docs/pocs/2026-11-28-rust-migrator-fast-path/poc.md`
