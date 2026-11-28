/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = '/Users/bamieh/bamieh/elastic/kibana';
const pocDir = path.join(repoRoot, 'docs/pocs/2026-11-28-rust-migrator-fast-path/poc');
const rawSnapshotPath = path.join(pocDir, 'raw_snapshot.json');
const outPath = path.join(pocDir, 'migrator-manifest.json');

const INDEX_CONST_MAP = {
  MAIN_SAVED_OBJECT_INDEX: '.kibana',
  TASK_MANAGER_SAVED_OBJECT_INDEX: '.kibana_task_manager',
  INGEST_SAVED_OBJECT_INDEX: '.kibana_ingest',
  ALERTING_CASES_SAVED_OBJECT_INDEX: '.kibana_alerting_cases',
  SECURITY_SOLUTION_SAVED_OBJECT_INDEX: '.kibana_security_solution',
  ANALYTICS_SAVED_OBJECT_INDEX: '.kibana_analytics',
  USAGE_COUNTERS_SAVED_OBJECT_INDEX: '.kibana_usage_counters',
  SEARCH_SOLUTION_SAVED_OBJECT_INDEX: '.kibana_search_solution',
};

const BASE_ROOT_MAPPINGS = {
  type: { type: 'keyword' },
  namespace: { type: 'keyword' },
  namespaces: { type: 'keyword' },
  originId: { type: 'keyword' },
  updated_at: { type: 'date' },
  updated_by: { type: 'keyword' },
  created_at: { type: 'date' },
  created_by: { type: 'keyword' },
  references: {
    type: 'nested',
    properties: {
      name: { type: 'keyword' },
      type: { type: 'keyword' },
      id: { type: 'keyword' },
    },
  },
  coreMigrationVersion: { type: 'keyword' },
  typeMigrationVersion: { type: 'version' },
  managed: { type: 'boolean' },
  accessControl: {
    dynamic: 'false',
    properties: {
      owner: { type: 'keyword' },
    },
  },
};

const CONDITIONAL_FLAGS = {
  'infrastructure-monitoring-log-view': 'non_serverless',
  'metrics-explorer-view': 'infra_metrics_explorer',
  'streams-configuration': 'streams_canvas',
  'streams-ui-metadata': 'streams_canvas',
  'evals-remote-kibana-config': 'evals_full',
  'endpoint:scripts-library': 'security_script_library',
};

function scanIndexPatterns(allTypeNames) {
  const map = {};
  const out = execSync(
    'rg -l "(TASK_MANAGER|INGEST|ALERTING_CASES|SECURITY_SOLUTION|ANALYTICS|USAGE_COUNTERS)_SAVED_OBJECT_INDEX" src x-pack',
    { cwd: repoRoot, encoding: 'utf8' }
  );
  const files = out
    .trim()
    .split('\n')
    .filter((f) => f && !f.includes('.test.') && !f.includes('__mocks__') && !f.includes('saved_objects_index_pattern'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const constMatch = content.match(
      /indexPattern:\s*(TASK_MANAGER|INGEST|ALERTING_CASES|SECURITY_SOLUTION|ANALYTICS|USAGE_COUNTERS)_SAVED_OBJECT_INDEX/
    );
    if (!constMatch) continue;
    const prefix = INDEX_CONST_MAP[`${constMatch[1]}_SAVED_OBJECT_INDEX`];
    for (const typeName of allTypeNames) {
      if (content.includes(`'${typeName}'`) || content.includes(`"${typeName}"`)) {
        map[typeName] = prefix;
      }
    }
  }

  // Known types whose name constants live in separate common files
  const explicit = {
    task: '.kibana_task_manager',
    'background-task-node': '.kibana_task_manager',
    api_key_to_invalidate: '.kibana_task_manager',
    'task-execution-control': '.kibana_task_manager',
    'usage-counters': '.kibana_usage_counters',
    alert: '.kibana_alerting_cases',
    action: '.kibana_alerting_cases',
    cases: '.kibana_alerting_cases',
    'cases-comments': '.kibana_alerting_cases',
    'cases-configure': '.kibana_alerting_cases',
    'cases-user-actions': '.kibana_alerting_cases',
    'maintenance-window': '.kibana_alerting_cases',
    'reporting-job': '.kibana_alerting_cases',
    'ephemeral-action-task-params': '.kibana_alerting_cases',
    action_task_params: '.kibana_alerting_cases',
    'fleet-agent-policies': '.kibana_ingest',
    'fleet-server-hosts': '.kibana_ingest',
    'fleet-outputs': '.kibana_ingest',
    'fleet-binary-download-sources': '.kibana_ingest',
    'fleet-package-policies': '.kibana_ingest',
    'fleet-proxy': '.kibana_ingest',
    'fleet-setup': '.kibana_ingest',
    dashboard: '.kibana_analytics',
    lens: '.kibana_analytics',
    map: '.kibana_analytics',
    search: '.kibana_analytics',
    visualization: '.kibana_analytics',
    'index-pattern': '.kibana_analytics',
    query: '.kibana_analytics',
    'search-session': '.kibana_analytics',
    canvas: '.kibana_analytics',
    'exception-list': '.kibana_security_solution',
    'exception-list-item': '.kibana_security_solution',
    'value-list': '.kibana_security_solution',
    'value-list-item': '.kibana_security_solution',
    'osquery-pack': '.kibana_security_solution',
    'osquery-saved-query': '.kibana_security_solution',
    'detection-rule-monitoring': '.kibana_security_solution',
  };
  for (const [k, v] of Object.entries(explicit)) {
    if (allTypeNames.includes(k) && !map[k]) map[k] = v;
  }
  return map;
}

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function latestVirtualModelVersion(modelVersions) {
  if (!Array.isArray(modelVersions) || modelVersions.length === 0) {
    return '10.0.0';
  }
  const virtuals = modelVersions
    .map((mv) => {
      const v = String(mv.version || '0');
      return v.includes('.') ? v : `10.${v}.0`;
    })
    .sort(semverCompare);
  return virtuals[virtuals.length - 1];
}

const raw = JSON.parse(fs.readFileSync(rawSnapshotPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const removedTypes = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'src/core/packages/saved-objects/server-internal/removed_types.json'),
    'utf8'
  )
);

const allTypeNames = Object.keys(raw.typeDefinitions);
const indexPatternByType = scanIndexPatterns(allTypeNames);
const indices = {};
for (const [name, info] of Object.entries(raw.typeDefinitions)) {
  const prefix = indexPatternByType[name] || '.kibana';
  if (!indices[prefix]) indices[prefix] = [];
  indices[prefix].push({
    name,
    latest_model_version: latestVirtualModelVersion(info.modelVersions),
    plugin_id: null,
    plugin_group: null,
    conditional_flag: CONDITIONAL_FLAGS[name] || null,
  });
}

for (const prefix of Object.keys(indices)) {
  indices[prefix].sort((a, b) => a.name.localeCompare(b.name));
}

const manifest = {
  schema_version: 1,
  kibana_version: pkg.version,
  commit_sha: raw.meta?.kibanaCommitHash || 'unknown',
  removed_types: removedTypes,
  base_root_mappings: BASE_ROOT_MAPPINGS,
  indices,
};

fs.writeFileSync(outPath, JSON.stringify(manifest));
const totalTypes = Object.values(indices).reduce((a, b) => a + b.length, 0);
console.log(
  `Wrote ${outPath}: ${Object.keys(indices).length} indices, ${totalTypes} real SO types, ${fs.statSync(outPath).size} bytes`
);
for (const [prefix, list] of Object.entries(indices).sort()) {
  console.log(`  ${prefix}: ${list.length} types`);
}
