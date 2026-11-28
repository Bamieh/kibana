use serde_yaml::Value as YamlValue;
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct MigratorConfig {
    pub es_hosts: Vec<String>,
    pub es_username: Option<String>,
    pub es_password: Option<String>,
    pub es_service_account_token: Option<String>,
    pub es_ca_certs: Vec<PathBuf>,
    pub es_verify_certs: bool,
    pub migrations_algorithm: String,
    pub migrations_skip: bool,
    pub allowed_plugin_groups: Option<HashSet<String>>,
    pub disabled_plugins: HashSet<String>,
    pub conditional_flags: BTreeMap<String, bool>,
    pub request_timeout_ms: u64,
    pub max_wait_ms: u64,
}

impl MigratorConfig {
    pub fn load(config_dir: &Path, cli_overrides: &[(String, String)]) -> Result<Self, String> {
        let base_file = config_dir.join("kibana.yml");
        let base_yaml = load_yaml_if_exists(&base_file)?;

        let serverless_mode = extract_string(&base_yaml, &["serverless"])
            .or_else(|| find_override(cli_overrides, "serverless"))
            .or_else(|| env::var("SERVERLESS").ok());

        let mut stack: Vec<YamlValue> = Vec::new();
        if let Some(mode) = &serverless_mode {
            push_if_exists(&mut stack, &config_dir.join("serverless.yml"))?;
            push_if_exists(&mut stack, &config_dir.join(format!("serverless.{mode}.yml")))?;
        }
        if !base_yaml.is_null() {
            stack.push(base_yaml);
        }

        let mut merged = merge_yaml_stack(&stack);
        apply_overrides(&mut merged, cli_overrides);

        if serverless_mode.as_deref() == Some("security") {
            if let Some(tier) = extract_security_tier(&merged) {
                let tier_path = config_dir.join(format!("serverless.security.{tier}.yml"));
                let tier_yaml = load_yaml_if_exists(&tier_path)?;
                if !tier_yaml.is_null() {
                    deep_merge(&mut merged, tier_yaml);
                }
            }
        }

        if let Some(mode) = &serverless_mode {
            if extract_bool(&merged, &["pricing", "tiers", "enabled"]).unwrap_or(false) {
                if let Some(tier) = extract_pricing_tier(&merged) {
                    let tier_path = config_dir.join(format!("serverless.{mode}.{tier}.yml"));
                    let tier_yaml = load_yaml_if_exists(&tier_path)?;
                    if !tier_yaml.is_null() {
                        deep_merge(&mut merged, tier_yaml);
                    }
                }
            }
        }

        apply_overrides(&mut merged, cli_overrides);

        let es_hosts = extract_string_list(&merged, &["elasticsearch", "hosts"])
            .or_else(|| {
                env::var("ELASTICSEARCH_HOSTS")
                    .ok()
                    .map(|v| parse_env_list(&v))
            })
            .unwrap_or_else(|| vec!["http://localhost:9200".to_string()]);

        let es_username = extract_string(&merged, &["elasticsearch", "username"])
            .or_else(|| env::var("ELASTICSEARCH_USERNAME").ok());
        let es_password = extract_string(&merged, &["elasticsearch", "password"])
            .or_else(|| env::var("ELASTICSEARCH_PASSWORD").ok());
        let es_service_account_token =
            extract_string(&merged, &["elasticsearch", "serviceAccountToken"])
                .or_else(|| env::var("ELASTICSEARCH_SERVICEACCOUNTTOKEN").ok());

        let es_ca_certs = extract_string_list(
            &merged,
            &["elasticsearch", "ssl", "certificateAuthorities"],
        )
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();

        let es_verify_certs = extract_string(&merged, &["elasticsearch", "ssl", "verificationMode"])
            .map(|v| v != "none")
            .unwrap_or(true);

        let migrations_algorithm = extract_string(&merged, &["migrations", "algorithm"])
            .unwrap_or_else(|| "v2".to_string());
        let migrations_skip = extract_bool(&merged, &["migrations", "skip"]).unwrap_or(false);

        let allowed_plugin_groups =
            extract_string_list(&merged, &["plugins", "allowlistPluginGroups"])
                .map(|v| v.into_iter().collect());

        let disabled_plugins = collect_disabled_plugins(&merged);
        let conditional_flags = resolve_conditional_flags(&merged, serverless_mode.is_some());

        Ok(Self {
            es_hosts,
            es_username,
            es_password,
            es_service_account_token,
            es_ca_certs,
            es_verify_certs,
            migrations_algorithm,
            migrations_skip,
            allowed_plugin_groups,
            disabled_plugins,
            conditional_flags,
            request_timeout_ms: 15_000,
            max_wait_ms: 60_000,
        })
    }
}

fn load_yaml_if_exists(path: &Path) -> Result<YamlValue, String> {
    if !path.exists() {
        return Ok(YamlValue::Null);
    }
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("failed to read config {}: {err}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(YamlValue::Null);
    }
    let parsed: YamlValue = serde_yaml::from_str(&raw)
        .map_err(|err| format!("failed to parse yaml {}: {err}", path.display()))?;
    Ok(expand_dotted_keys(parsed))
}

fn push_if_exists(stack: &mut Vec<YamlValue>, path: &Path) -> Result<(), String> {
    let val = load_yaml_if_exists(path)?;
    if !val.is_null() {
        stack.push(val);
    }
    Ok(())
}

fn expand_dotted_keys(value: YamlValue) -> YamlValue {
    match value {
        YamlValue::Mapping(map) => {
            let mut root = YamlValue::Mapping(serde_yaml::Mapping::new());
            for (k, v) in map {
                let expanded_v = expand_dotted_keys(v);
                if let Some(key_str) = k.as_str() {
                    let parts: Vec<&str> = key_str.split('.').collect();
                    insert_path(&mut root, &parts, expanded_v);
                }
            }
            root
        }
        other => other,
    }
}

fn insert_path(target: &mut YamlValue, parts: &[&str], value: YamlValue) {
    if parts.is_empty() {
        return;
    }
    if !target.is_mapping() {
        *target = YamlValue::Mapping(serde_yaml::Mapping::new());
    }
    let map = target.as_mapping_mut().expect("mapping");
    let key = YamlValue::String(parts[0].to_string());
    if parts.len() == 1 {
        if let Some(existing) = map.get_mut(&key) {
            deep_merge(existing, value);
        } else {
            map.insert(key, value);
        }
        return;
    }
    let child = map
        .entry(key)
        .or_insert_with(|| YamlValue::Mapping(serde_yaml::Mapping::new()));
    insert_path(child, &parts[1..], value);
}

fn merge_yaml_stack(stack: &[YamlValue]) -> YamlValue {
    let mut acc = YamlValue::Mapping(serde_yaml::Mapping::new());
    for item in stack {
        deep_merge(&mut acc, item.clone());
    }
    acc
}

fn deep_merge(base: &mut YamlValue, overlay: YamlValue) {
    match (base, overlay) {
        (YamlValue::Mapping(base_map), YamlValue::Mapping(overlay_map)) => {
            for (k, v) in overlay_map {
                match base_map.get_mut(&k) {
                    Some(existing) => deep_merge(existing, v),
                    None => {
                        base_map.insert(k, v);
                    }
                }
            }
        }
        (slot, other) => *slot = other,
    }
}

fn apply_overrides(target: &mut YamlValue, overrides: &[(String, String)]) {
    for (k, v) in overrides {
        let parsed: YamlValue =
            serde_yaml::from_str(v).unwrap_or_else(|_| YamlValue::String(v.clone()));
        let parts: Vec<&str> = k.split('.').collect();
        insert_path(target, &parts, parsed);
    }
}

fn find_override(overrides: &[(String, String)], key: &str) -> Option<String> {
    overrides
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
}

fn get_path<'a>(root: &'a YamlValue, path: &[&str]) -> Option<&'a YamlValue> {
    let mut cur = root;
    for seg in path {
        cur = cur.as_mapping()?.get(YamlValue::String((*seg).to_string()))?;
    }
    Some(cur)
}

fn extract_string(root: &YamlValue, path: &[&str]) -> Option<String> {
    get_path(root, path)?.as_str().map(ToString::to_string)
}

fn extract_bool(root: &YamlValue, path: &[&str]) -> Option<bool> {
    get_path(root, path)?.as_bool()
}

fn extract_string_list(root: &YamlValue, path: &[&str]) -> Option<Vec<String>> {
    let v = get_path(root, path)?;
    if let Some(s) = v.as_str() {
        return Some(vec![s.to_string()]);
    }
    let seq = v.as_sequence()?;
    Some(
        seq.iter()
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect(),
    )
}

fn parse_env_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('[') {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(trimmed) {
            return list;
        }
    }
    trimmed
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_security_tier(root: &YamlValue) -> Option<String> {
    let products = get_path(
        root,
        &["xpack", "securitySolutionServerless", "productTypes"],
    )?
    .as_sequence()?;
    products
        .first()?
        .as_mapping()?
        .get(YamlValue::String("product_tier".to_string()))?
        .as_str()
        .map(ToString::to_string)
}

fn extract_pricing_tier(root: &YamlValue) -> Option<String> {
    let products = get_path(root, &["pricing", "tiers", "products"])?.as_sequence()?;
    products
        .first()?
        .as_mapping()?
        .get(YamlValue::String("tier".to_string()))?
        .as_str()
        .map(ToString::to_string)
}

fn collect_disabled_plugins(root: &YamlValue) -> HashSet<String> {
    let mut disabled = HashSet::new();
    let Some(top) = root.as_mapping() else {
        return disabled;
    };
    for (k, v) in top {
        let Some(key) = k.as_str() else { continue };
        if key == "xpack" {
            if let Some(xpack_map) = v.as_mapping() {
                for (xk, xv) in xpack_map {
                    if let (Some(xkey), Some(false)) =
                        (xk.as_str(), extract_bool(xv, &["enabled"]))
                    {
                        disabled.insert(xkey.to_string());
                    }
                }
            }
        } else if extract_bool(v, &["enabled"]) == Some(false) {
            disabled.insert(key.to_string());
        }
    }
    disabled
}

fn resolve_conditional_flags(root: &YamlValue, is_serverless: bool) -> BTreeMap<String, bool> {
    let mut flags = BTreeMap::new();
    flags.insert("non_serverless".to_string(), !is_serverless);
    flags.insert(
        "infra_metrics_explorer".to_string(),
        extract_bool(
            root,
            &["xpack", "infra", "featureFlags", "metricsExplorerEnabled"],
        )
        .unwrap_or(!is_serverless),
    );
    flags.insert(
        "streams_canvas".to_string(),
        extract_bool(root, &["xpack", "streams", "canvas", "enabled"]).unwrap_or(false),
    );
    let evals_full = extract_bool(root, &["xpack", "evals", "enabled"]).unwrap_or(false)
        && extract_string(root, &["xpack", "evals", "mode"]).as_deref() == Some("full");
    flags.insert("evals_full".to_string(), evals_full);

    let script_lib_disabled = extract_string_list(
        root,
        &["xpack", "securitySolution", "enableExperimental"],
    )
    .map(|v| {
        v.iter()
            .any(|item| item == "disable:responseActionsScriptLibraryManagement")
    })
    .unwrap_or(false);
    flags.insert(
        "security_script_library".to_string(),
        !script_lib_disabled,
    );
    flags
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn tier_overlay_overrides_kibana_yml() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("kbn_cfg_test_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("serverless.yml"),
            "migrations.algorithm: zdt\nxpack.canvas.enabled: false\n",
        )
        .unwrap();
        fs::write(
            dir.join("serverless.oblt.yml"),
            "plugins.allowlistPluginGroups: [platform, observability]\nxpack.significantEvents.enabled: false\n",
        )
        .unwrap();
        fs::write(
            dir.join("serverless.oblt.complete.yml"),
            "xpack.significantEvents.enabled: true\n",
        )
        .unwrap();
        fs::write(
            dir.join("kibana.yml"),
            "serverless: oblt\npricing.tiers.enabled: true\npricing.tiers.products:\n  - tier: complete\n",
        )
        .unwrap();

        let cfg = MigratorConfig::load(&dir, &[]).unwrap();
        assert_eq!(cfg.migrations_algorithm, "zdt");
        assert!(cfg.disabled_plugins.contains("canvas"));
        assert!(!cfg.disabled_plugins.contains("significantEvents"));
        let _ = fs::remove_dir_all(&dir);
    }
}
