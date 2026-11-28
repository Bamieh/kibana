use semver::Version;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

const INITIAL_MODEL_VERSION: Version = Version::new(10, 0, 0);

#[derive(Debug, Clone, Deserialize)]
pub struct EsIndexEntry {
    #[serde(default)]
    pub aliases: BTreeMap<String, Value>,
    #[serde(default)]
    pub mappings: EsIndexMappings,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EsIndexMappings {
    #[serde(default)]
    pub _meta: Option<EsIndexMeta>,
    #[serde(default)]
    pub properties: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EsIndexMeta {
    #[serde(rename = "mappingVersions")]
    pub mapping_versions: Option<BTreeMap<String, String>>,
    #[serde(rename = "docVersions")]
    pub doc_versions: Option<BTreeMap<String, String>>,
    #[serde(rename = "migrationMappingPropertyHashes")]
    pub migration_mapping_property_hashes: Option<BTreeMap<String, String>>,
    #[serde(rename = "indexTypesMap")]
    pub index_types_map: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexAlgorithm {
    Zdt,
    V2PartiallyMigrated,
    V2Compatible,
    V2Incompatible,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionStatus {
    Equal,
    Lesser,
    Greater,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexDecision {
    FastPathOk {
        index_name: String,
        status: VersionStatus,
    },
    Fallback {
        reason: String,
    },
}

pub fn evaluate_index(
    prefix: &str,
    kibana_version: &str,
    app_versions: &BTreeMap<String, String>,
    deleted_types: &HashSet<String>,
    base_root_mappings: &BTreeMap<String, Value>,
    es_response: &BTreeMap<String, EsIndexEntry>,
) -> IndexDecision {
    let mut alias_to_indices: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (idx_name, entry) in es_response {
        for alias in entry.aliases.keys() {
            alias_to_indices
                .entry(alias.as_str())
                .or_default()
                .push(idx_name.as_str());
        }
    }

    for (alias, targets) in &alias_to_indices {
        if targets.len() > 1 {
            return IndexDecision::Fallback {
                reason: format!("multi_index_alias:{prefix}:{alias}"),
            };
        }
    }

    let Some(current_index) = find_current_index(prefix, es_response, &alias_to_indices) else {
        return IndexDecision::Fallback {
            reason: format!("missing_index:{prefix}"),
        };
    };

    let entry = &es_response[&current_index];
    let algo = detect_algorithm(entry.mappings._meta.as_ref());
    if algo != IndexAlgorithm::Zdt {
        return IndexDecision::Fallback {
            reason: format!("non_zdt_algorithm:{prefix}:{algo:?}"),
        };
    }

    let meta = entry.mappings._meta.as_ref().expect("zdt has meta");
    let mapping_meta = meta.mapping_versions.as_ref().expect("zdt has mappingVersions");
    let doc_meta = meta.doc_versions.as_ref().expect("zdt has docVersions");

    if let Some(unknown) = find_unknown_meta_type(mapping_meta, app_versions, deleted_types) {
        return IndexDecision::Fallback {
            reason: format!("unknown_meta_mapping_type:{prefix}:{unknown}"),
        };
    }
    if let Some(unknown) = find_unknown_meta_type(doc_meta, app_versions, deleted_types) {
        return IndexDecision::Fallback {
            reason: format!("unknown_meta_doc_type:{prefix}:{unknown}"),
        };
    }

    let changed_root = find_updated_root_fields(base_root_mappings, &entry.mappings.properties);
    if !changed_root.is_empty() {
        return IndexDecision::Fallback {
            reason: format!("updated_root_fields:{prefix}:{}", changed_root.join(",")),
        };
    }

    let mapping_status = match compare_versions(app_versions, mapping_meta, deleted_types) {
        Ok(s) => s,
        Err(err) => {
            return IndexDecision::Fallback {
                reason: format!("invalid_mapping_semver:{prefix}:{err}"),
            }
        }
    };

    let doc_status = match compare_versions(app_versions, doc_meta, deleted_types) {
        Ok(s) => s,
        Err(err) => {
            return IndexDecision::Fallback {
                reason: format!("invalid_doc_semver:{prefix}:{err}"),
            }
        }
    };

    match (mapping_status, doc_status) {
        (VersionStatus::Equal, VersionStatus::Equal) => {
            let version_alias = format!("{prefix}_{kibana_version}");
            let has_global = entry.aliases.contains_key(prefix);
            let has_version = entry.aliases.contains_key(&version_alias);
            if !has_global || !has_version {
                return IndexDecision::Fallback {
                    reason: format!("missing_alias:{prefix}:{version_alias}"),
                };
            }
            IndexDecision::FastPathOk {
                index_name: current_index,
                status: VersionStatus::Equal,
            }
        }
        (VersionStatus::Lesser, VersionStatus::Lesser)
        | (VersionStatus::Lesser, VersionStatus::Equal)
        | (VersionStatus::Equal, VersionStatus::Lesser) => IndexDecision::FastPathOk {
            index_name: current_index,
            status: VersionStatus::Lesser,
        },
        (m, d) => IndexDecision::Fallback {
            reason: format!("version_migration_needed:{prefix}:mapping={m:?},doc={d:?}"),
        },
    }
}

fn find_current_index(
    prefix: &str,
    es_response: &BTreeMap<String, EsIndexEntry>,
    alias_to_indices: &BTreeMap<&str, Vec<&str>>,
) -> Option<String> {
    if let Some(targets) = alias_to_indices.get(prefix) {
        if let Some(first) = targets.first() {
            if es_response.contains_key(*first) {
                return Some((*first).to_string());
            }
        }
    }

    let expected_prefix = format!("{prefix}_");
    let mut best: Option<(u64, String)> = None;
    for name in es_response.keys() {
        let Some(suffix) = name.strip_prefix(&expected_prefix) else {
            continue;
        };
        if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(num) = suffix.parse::<u64>() {
                if best.as_ref().map(|(n, _)| num > *n).unwrap_or(true) {
                    best = Some((num, name.clone()));
                }
            }
        }
    }
    best.map(|(_, name)| name)
}

fn detect_algorithm(meta: Option<&EsIndexMeta>) -> IndexAlgorithm {
    let Some(m) = meta else {
        return IndexAlgorithm::Unknown;
    };
    if m.mapping_versions.is_some() {
        return match m.doc_versions.is_some() {
            true => IndexAlgorithm::Zdt,
            false => IndexAlgorithm::V2PartiallyMigrated,
        };
    }
    if m.migration_mapping_property_hashes.is_some() {
        return match m.index_types_map.is_some() {
            true => IndexAlgorithm::V2Compatible,
            false => IndexAlgorithm::V2Incompatible,
        };
    }
    IndexAlgorithm::Unknown
}

fn find_unknown_meta_type<'a>(
    stored: &'a BTreeMap<String, String>,
    app_versions: &BTreeMap<String, String>,
    deleted_types: &HashSet<String>,
) -> Option<&'a str> {
    for key in stored.keys() {
        if !app_versions.contains_key(key) && !deleted_types.contains(key) {
            return Some(key.as_str());
        }
    }
    None
}

fn find_updated_root_fields(
    base_root_mappings: &BTreeMap<String, Value>,
    index_properties: &BTreeMap<String, Value>,
) -> Vec<String> {
    base_root_mappings
        .iter()
        .filter(|(k, expected)| index_properties.get(*k) != Some(*expected))
        .map(|(k, _)| k.clone())
        .collect()
}

fn clamp_min_version(raw: &str) -> Result<Version, String> {
    let parsed = Version::parse(raw).map_err(|e| format!("{raw}: {e}"))?;
    if parsed < INITIAL_MODEL_VERSION {
        Ok(INITIAL_MODEL_VERSION)
    } else {
        Ok(parsed)
    }
}

fn compare_versions(
    app_versions: &BTreeMap<String, String>,
    stored_versions: &BTreeMap<String, String>,
    deleted_types: &HashSet<String>,
) -> Result<VersionStatus, String> {
    let mut all_keys: HashSet<&str> = HashSet::new();
    for k in app_versions.keys() {
        if !deleted_types.contains(k) {
            all_keys.insert(k.as_str());
        }
    }
    for k in stored_versions.keys() {
        if !deleted_types.contains(k) {
            all_keys.insert(k.as_str());
        }
    }

    let mut has_greater = false;
    let mut has_lesser = false;

    for key in all_keys {
        let app_v = match app_versions.get(key) {
            Some(v) => Version::parse(v).map_err(|e| format!("{key}={v}: {e}"))?,
            None => Version::new(0, 0, 0),
        };
        let idx_v = match stored_versions.get(key) {
            Some(v) => clamp_min_version(v)?,
            None => Version::new(0, 0, 0),
        };

        if app_v > idx_v {
            has_greater = true;
        } else if app_v < idx_v {
            has_lesser = true;
        }
    }

    Ok(match (has_greater, has_lesser) {
        (true, true) => VersionStatus::Conflict,
        (true, false) => VersionStatus::Greater,
        (false, true) => VersionStatus::Lesser,
        (false, false) => VersionStatus::Equal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_roots() -> BTreeMap<String, Value> {
        BTreeMap::from([
            ("type".to_string(), json!({"type": "keyword"})),
            ("managed".to_string(), json!({"type": "boolean"})),
        ])
    }

    fn make_entry(
        aliases: &[&str],
        mapping_versions: &[(&str, &str)],
        doc_versions: &[(&str, &str)],
        roots: BTreeMap<String, Value>,
    ) -> EsIndexEntry {
        EsIndexEntry {
            aliases: aliases
                .iter()
                .map(|a| ((*a).to_string(), json!({})))
                .collect(),
            mappings: EsIndexMappings {
                _meta: Some(EsIndexMeta {
                    mapping_versions: Some(
                        mapping_versions
                            .iter()
                            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                            .collect(),
                    ),
                    doc_versions: Some(
                        doc_versions
                            .iter()
                            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                            .collect(),
                    ),
                    migration_mapping_property_hashes: None,
                    index_types_map: None,
                }),
                properties: roots,
            },
        }
    }

    #[test]
    fn exact_noop_passes_fast_path() {
        let app = BTreeMap::from([
            ("config".to_string(), "10.0.0".to_string()),
            ("space".to_string(), "10.2.0".to_string()),
        ]);
        let es = BTreeMap::from([(
            ".kibana_1".to_string(),
            make_entry(
                &[".kibana", ".kibana_9.7.0"],
                &[("config", "10.0.0"), ("space", "10.2.0")],
                &[("config", "10.0.0"), ("space", "10.2.0")],
                base_roots(),
            ),
        )]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert_eq!(
            decision,
            IndexDecision::FastPathOk {
                index_name: ".kibana_1".to_string(),
                status: VersionStatus::Equal,
            }
        );
    }

    #[test]
    fn missing_version_alias_falls_back() {
        let app = BTreeMap::from([("config".to_string(), "10.0.0".to_string())]);
        let es = BTreeMap::from([(
            ".kibana_1".to_string(),
            make_entry(
                &[".kibana"],
                &[("config", "10.0.0")],
                &[("config", "10.0.0")],
                base_roots(),
            ),
        )]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert!(matches!(decision, IndexDecision::Fallback { reason } if reason.starts_with("missing_alias:")));
    }

    #[test]
    fn rollback_lesser_passes_without_alias_requirement() {
        let app = BTreeMap::from([("space".to_string(), "10.1.0".to_string())]);
        let es = BTreeMap::from([(
            ".kibana_1".to_string(),
            make_entry(
                &[".kibana", ".kibana_9.8.0"],
                &[("space", "10.2.0")],
                &[("space", "10.2.0")],
                base_roots(),
            ),
        )]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert_eq!(
            decision,
            IndexDecision::FastPathOk {
                index_name: ".kibana_1".to_string(),
                status: VersionStatus::Lesser,
            }
        );
    }

    #[test]
    fn unknown_meta_type_fails_closed_to_fallback() {
        let app = BTreeMap::from([("config".to_string(), "10.0.0".to_string())]);
        let es = BTreeMap::from([(
            ".kibana_1".to_string(),
            make_entry(
                &[".kibana", ".kibana_9.7.0"],
                &[("config", "10.0.0"), ("untracked_plugin_type", "10.1.0")],
                &[("config", "10.0.0"), ("untracked_plugin_type", "10.1.0")],
                base_roots(),
            ),
        )]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert!(matches!(decision, IndexDecision::Fallback { reason } if reason.starts_with("unknown_meta_mapping_type:")));
    }

    #[test]
    fn model_version_bump_falls_back() {
        let app = BTreeMap::from([("space".to_string(), "10.3.0".to_string())]);
        let es = BTreeMap::from([(
            ".kibana_1".to_string(),
            make_entry(
                &[".kibana", ".kibana_9.7.0"],
                &[("space", "10.2.0")],
                &[("space", "10.2.0")],
                base_roots(),
            ),
        )]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert!(matches!(decision, IndexDecision::Fallback { reason } if reason.contains("Greater")));
    }

    #[test]
    fn changed_root_mapping_falls_back() {
        let app = BTreeMap::from([("config".to_string(), "10.0.0".to_string())]);
        let mut drifted_roots = base_roots();
        drifted_roots.insert("managed".to_string(), json!({"type": "keyword"}));
        let es = BTreeMap::from([(
            ".kibana_1".to_string(),
            make_entry(
                &[".kibana", ".kibana_9.7.0"],
                &[("config", "10.0.0")],
                &[("config", "10.0.0")],
                drifted_roots,
            ),
        )]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert!(matches!(decision, IndexDecision::Fallback { reason } if reason.starts_with("updated_root_fields:")));
    }

    #[test]
    fn missing_index_falls_back() {
        let app = BTreeMap::from([("config".to_string(), "10.0.0".to_string())]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &BTreeMap::new(),
        );
        assert!(matches!(decision, IndexDecision::Fallback { reason } if reason == "missing_index:.kibana"));
    }

    #[test]
    fn multi_index_alias_falls_back() {
        let app = BTreeMap::from([("config".to_string(), "10.0.0".to_string())]);
        let es = BTreeMap::from([
            (
                ".kibana_1".to_string(),
                make_entry(
                    &[".kibana", ".kibana_9.7.0"],
                    &[("config", "10.0.0")],
                    &[("config", "10.0.0")],
                    base_roots(),
                ),
            ),
            (
                ".kibana_2".to_string(),
                make_entry(
                    &[".kibana"],
                    &[("config", "10.0.0")],
                    &[("config", "10.0.0")],
                    base_roots(),
                ),
            ),
        ]);
        let decision = evaluate_index(
            ".kibana",
            "9.7.0",
            &app,
            &HashSet::new(),
            &base_roots(),
            &es,
        );
        assert!(matches!(decision, IndexDecision::Fallback { reason } if reason.starts_with("multi_index_alias:")));
    }
}
