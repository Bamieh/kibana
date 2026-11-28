mod config;
mod es_client;
mod manifest;
mod telemetry;
mod zdt;

use crate::config::MigratorConfig;
use crate::es_client::EsClient;
use crate::manifest::Manifest;
use crate::telemetry::EcsLogger;
use crate::zdt::{evaluate_index, IndexDecision};
use futures::future::try_join_all;
use serde_json::json;
use std::collections::HashSet;
use std::env;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{self, Command};
use std::time::Instant;

struct CliArgs {
    manifest_path: PathBuf,
    config_dir: PathBuf,
    kibana_bin: Option<PathBuf>,
    cli_overrides: Vec<(String, String)>,
    passthrough_args: Vec<String>,
}

fn parse_args() -> CliArgs {
    let mut manifest_path = PathBuf::from("/usr/share/kibana/config/migrator-manifest.json");
    let mut config_dir = PathBuf::from("/usr/share/kibana/config");
    let mut kibana_bin: Option<PathBuf> = env::var("KIBANA_FALLBACK_BIN").ok().map(PathBuf::from);
    let mut cli_overrides = Vec::new();
    let mut passthrough_args = Vec::new();

    let mut args = env::args().skip(1).peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--manifest" => {
                if let Some(val) = args.next() {
                    manifest_path = PathBuf::from(val);
                }
            }
            "--config-dir" => {
                if let Some(val) = args.next() {
                    config_dir = PathBuf::from(val);
                }
            }
            "--kibana-bin" => {
                if let Some(val) = args.next() {
                    kibana_bin = Some(PathBuf::from(val));
                }
            }
            other => {
                passthrough_args.push(other.to_string());
                if let Some(stripped) = other.strip_prefix("--") {
                    if let Some((k, v)) = stripped.split_once('=') {
                        cli_overrides.push((k.to_string(), v.to_string()));
                    }
                }
            }
        }
    }

    CliArgs {
        manifest_path,
        config_dir,
        kibana_bin,
        cli_overrides,
        passthrough_args,
    }
}

fn exec_fallback(
    logger: &EcsLogger,
    kibana_bin: Option<&PathBuf>,
    passthrough_args: &[String],
    reason: &str,
) -> ! {
    logger.warn(
        "savedobjects-service",
        &format!("Fast-path migrator falling back to Node.js Kibana: {reason}"),
        json!({
            "kibana": {
                "migrator": {
                    "path": "fallback",
                    "fallback_reason": reason
                }
            }
        }),
    );

    let bin = kibana_bin
        .cloned()
        .unwrap_or_else(|| PathBuf::from("/usr/share/kibana/bin/kibana"));

    let err = Command::new(&bin).args(passthrough_args).exec();
    eprintln!("failed to exec fallback {}: {err}", bin.display());
    process::exit(1);
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let started = Instant::now();
    let logger = EcsLogger::new();
    let args = parse_args();

    let manifest = match Manifest::load(&args.manifest_path) {
        Ok(m) => m,
        Err(err) => exec_fallback(&logger, args.kibana_bin.as_ref(), &args.passthrough_args, &err),
    };

    let cfg = match MigratorConfig::load(&args.config_dir, &args.cli_overrides) {
        Ok(c) => c,
        Err(err) => exec_fallback(&logger, args.kibana_bin.as_ref(), &args.passthrough_args, &err),
    };

    if cfg.migrations_skip {
        logger.info(
            "savedobjects-service",
            "Completed all migrations in 0ms",
            json!({ "kibana": { "migrator": { "path": "fast-skip" } } }),
        );
        return;
    }

    if cfg.migrations_algorithm != "zdt" && cfg.migrations_algorithm != "v3" {
        exec_fallback(
            &logger,
            args.kibana_bin.as_ref(),
            &args.passthrough_args,
            &format!("unsupported_algorithm:{}", cfg.migrations_algorithm),
        );
    }

    let active_indices = manifest.resolve_active_indices(
        cfg.allowed_plugin_groups.as_ref(),
        &cfg.disabled_plugins,
        &cfg.conditional_flags,
    );

    if active_indices.is_empty() {
        exec_fallback(
            &logger,
            args.kibana_bin.as_ref(),
            &args.passthrough_args,
            "no_active_indices",
        );
    }

    let client = match EsClient::from_config(&cfg) {
        Ok(c) => c,
        Err(err) => exec_fallback(&logger, args.kibana_bin.as_ref(), &args.passthrough_args, &err),
    };

    let es_started = Instant::now();
    let client_ref = &client;
    let fetches = active_indices.iter().map(|spec| async move {
        let es_map = client_ref.fetch_indices(&spec.prefix).await?;
        Ok::<_, String>((spec, es_map))
    });

    let results = match try_join_all(fetches).await {
        Ok(r) => r,
        Err(err) => exec_fallback(&logger, args.kibana_bin.as_ref(), &args.passthrough_args, &err),
    };

    let deleted: HashSet<String> = manifest.removed_types.iter().cloned().collect();
    let mut checked_count = 0usize;

    for (spec, es_response) in results {
        match evaluate_index(
            &spec.prefix,
            &manifest.kibana_version,
            &spec.app_versions,
            &deleted,
            &manifest.base_root_mappings,
            &es_response,
        ) {
            IndexDecision::FastPathOk { .. } => {
                checked_count += 1;
            }
            IndexDecision::Fallback { reason } => {
                exec_fallback(
                    &logger,
                    args.kibana_bin.as_ref(),
                    &args.passthrough_args,
                    &reason,
                );
            }
        }
    }

    let migration_ms = es_started.elapsed().as_millis() as u64;
    let total_ms = started.elapsed().as_millis() as u64;
    logger.info(
        "savedobjects-service",
        &format!("Completed all migrations in {migration_ms}ms"),
        json!({
            "kibana": {
                "migrator": {
                    "path": "fast-noop",
                    "indices_checked": checked_count,
                    "migration_ms": migration_ms,
                    "total_ms": total_ms,
                    "commit_sha": manifest.commit_sha
                }
            }
        }),
    );
}
