# Kibana Production Native Modules Policy & Rust Packaging Paths

## Why `check_prod_native_modules` Exists

Enforced by `packages/kbn-check-prod-native-modules-cli/check_prod_native_modules.ts` (owned by `@elastic/kibana-operations`, `.github/CODEOWNERS:60`), run in CI via `.buildkite/scripts/steps/checks/native_modules.sh` (`quick_checks.json:69`).

It is not only package/vulnerability hygiene — there are three structural build and runtime reasons documented in GitHub history and `src/dev/build/`:

1. **V8 Pointer Compression ABI incompatibility (immediate trigger):**
   - [elastic/kibana#188134](https://github.com/elastic/kibana/pull/188134) removed the last production native module (`re2` -> `re2js`), followed immediately by [elastic/kibana#190183](https://github.com/elastic/kibana/pull/190183) (which removed `cbor-x` and introduced `kbn-check-prod-native-modules-cli`): *"This PR is the final step needed for us to re-enable pointer compression on serverless."*
   - Serverless and 1 GB ECH run custom-built Node.js with V8 pointer compression. Traditional V8/NAN C++ addons break against pointer-compressed V8 unless custom-compiled against Kibana's custom Node headers.
2. **Single-host cross-platform packaging:**
   - `src/dev/build/build_distributables.ts:87-135`, `tasks/install_dependencies_task.ts`, and `tasks/create_archives_sources_task.ts:20-43` run `pnpm install --prod` **once** on a single Linux CI machine, then copy that identical `node_modules` tree into all **10 target platforms** (`src/dev/build/lib/platform.ts:69-88`: `linux`/`darwin`/`win32` x `x64`/`arm64`, plus `cloud` and `serverless` Linux variants), swapping only the prebuilt `node/` binary and Linux `fips.so`.
   - Documented in `docs/extend/contributing/codebase/managing-third-party-dependencies.md:47`: *"Due to our build process, native module dependencies are only supported for development (`devDependencies`), and are not supported for production (`dependencies`)."*
3. **macOS Gatekeeper signing, bootstrap breakages, and `postinstall` supply-chain risk:**
   - Unsigned `.node` binaries failed macOS Gatekeeper `dlopen` ([elastic/kibana#121864](https://github.com/elastic/kibana/issues/121864)).
   - Third-party prebuild downloads broke macOS `kbn bootstrap` ([elastic/kibana#216715](https://github.com/elastic/kibana/pull/216715)).
   - [elastic/kibana#250638](https://github.com/elastic/kibana/pull/250638) (closing [elastic/kibana#128025](https://github.com/elastic/kibana/issues/128025)) disabled `postinstall` scripts by default for hermetic builds and supply-chain safety.

## Exception Path & Approvers

[elastic/kibana-operations#131](https://github.com/elastic/kibana-operations/issues/131) explicitly left the door open for a justified production exception:
> *"If for some reason in the future there is a need for us to really introduce a given native module in prod for a good reason we can recover and re-implement our current processes..."*

Required reviewers / approvers:
- **`@elastic/kibana-operations`** (owns `kbn-check-prod-native-modules-cli` and `src/dev/build/`)
- **AppEx Platform Security** (dependency evaluation, Cargo SCA/SBOM, FIPS 140-3 TLS verification)

## Packaging Options by Rust Integration Model

### Option A: Standalone Rust Binary (e.g. `kibana-migrator-rs` or co-located HTTP child process/sidecar)
- **Does not trigger `check_prod_native_modules`** (no `.node` or `binding.gyp` in `node_modules`).
- **Zero V8 pointer-compression ABI risk** (separate OS process).
- **Serverless Linux (`linux/amd64` + `linux/arm64`) fits an existing build pattern:** `src/dev/build/tasks/fips/bundle_fips_provider_task.ts:47-70` already uses `docker buildx build --platform linux/amd64|arm64` inside `createPlatformFolders` to compile native ELF artifacts (`fips.so`) per Linux arch and verify the ELF machine header (`62` x64 / `183` arm64) without macOS signing, Windows toolchains, `postinstall` scripts, or `gcc` in the runtime image.
- **Open approval items:** Cargo in CI, offline/vendored crate caching, Cargo SCA/CVE triage, Wolfi `chainguard-base-fips` OpenSSL linkage verification.

### Option B: First-Party `napi-rs` `.node` Addon (for in-process Node <-> Rust)
- Allowlisting a first-party package in `check_prod_native_modules.ts` is straightforward.
- **Node-API (`N-API`)** is ABI-stable across Node versions and avoids V8 internal layout coupling (unlike NAN/V8 C++ addons), though it still must be verified against Elastic's custom pointer-compressed Node.js builds.
- To avoid 10-platform + macOS-signing complexity, insert the compiled `.node` binary per architecture inside `CreateArchivesSources` for `SERVERLESS_PLATFORMS` / `CLOUD_PLATFORMS` (`linux-x64`, `linux-arm64`) only, with a pure-JS fallback on macOS, Windows, and local dev.
