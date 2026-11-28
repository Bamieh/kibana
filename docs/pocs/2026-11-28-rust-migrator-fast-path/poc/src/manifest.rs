use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub kibana_version: String,
    pub commit_sha: String,
    pub removed_types: Vec<String>,
    pub base_root_mappings: BTreeMap<String, Value>,
    pub indices: BTreeMap<String, Vec<ManifestSoType>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestSoType {
    pub name: String,
    pub latest_model_version: String,
    pub plugin_id: Option<String>,
    pub plugin_group: Option<String>,
    pub conditional_flag: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ActiveIndexSpec {
    pub prefix: String,
    pub app_versions: BTreeMap<String, String>,
}

impl Manifest {
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = fs::read_to_string(path)
            .map_err(|err| format!("failed to read manifest {}: {err}", path.display()))?;
        serde_json::from_str(&raw)
            .map_err(|err| format!("failed to parse manifest {}: {err}", path.display()))
    }

    pub fn resolve_active_indices(
        &self,
        allowed_groups: Option<&HashSet<String>>,
        disabled_plugins: &HashSet<String>,
        conditional_flags: &BTreeMap<String, bool>,
    ) -> Vec<ActiveIndexSpec> {
        let mut active = Vec::new();
        for (prefix, types) in &self.indices {
            let mut app_versions = BTreeMap::new();
            for entry in types {
                if !is_type_enabled(entry, allowed_groups, disabled_plugins, conditional_flags) {
                    continue;
                }
                app_versions.insert(entry.name.clone(), entry.latest_model_version.clone());
            }
            if !app_versions.is_empty() {
                active.push(ActiveIndexSpec {
                    prefix: prefix.clone(),
                    app_versions,
                });
            }
        }
        active
    }
}

fn is_type_enabled(
    entry: &ManifestSoType,
    allowed_groups: Option<&HashSet<String>>,
    disabled_plugins: &HashSet<String>,
    conditional_flags: &BTreeMap<String, bool>,
) -> bool {
    if let (Some(groups), Some(group)) = (allowed_groups, &entry.plugin_group) {
        if !groups.contains(group) {
            return false;
        }
    }
    if let Some(plugin_id) = &entry.plugin_id {
        if disabled_plugins.contains(plugin_id) {
            return false;
        }
    }
    if let Some(flag) = &entry.conditional_flag {
        if !conditional_flags.get(flag).copied().unwrap_or(false) {
            return false;
        }
    }
    true
}
