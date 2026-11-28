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
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  let manifestPath = '/usr/share/kibana/config/migrator-manifest.json';
  let configDir = '/usr/share/kibana/config';
  let kibanaBin = process.env.KIBANA_FALLBACK_BIN || '/usr/share/kibana/bin/kibana';
  const overrides = {};
  const passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest' && argv[i + 1]) {
      manifestPath = argv[++i];
    } else if (arg === '--config-dir' && argv[i + 1]) {
      configDir = argv[++i];
    } else if (arg === '--kibana-bin' && argv[i + 1]) {
      kibanaBin = argv[++i];
    } else {
      passthrough.push(arg);
      if (arg.startsWith('--') && arg.includes('=')) {
        const idx = arg.indexOf('=');
        overrides[arg.slice(2, idx)] = arg.slice(idx + 1);
      }
    }
  }
  return { manifestPath, configDir, kibanaBin, overrides, passthrough };
}

function parseSemver(v) {
  const [maj, min, pat] = v.split('.').map(Number);
  return [maj, min, pat];
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function clampMin(v) {
  const parsed = parseSemver(v);
  return cmpSemver(parsed, [10, 0, 0]) < 0 ? [10, 0, 0] : parsed;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function compareVersions(appVersions, storedVersions, deletedSet) {
  const keys = new Set([...Object.keys(appVersions), ...Object.keys(storedVersions)]);
  let hasGreater = false;
  let hasLesser = false;
  for (const k of keys) {
    if (deletedSet.has(k)) continue;
    const appV = appVersions[k] ? parseSemver(appVersions[k]) : [0, 0, 0];
    const idxV = storedVersions[k] ? clampMin(storedVersions[k]) : [0, 0, 0];
    const c = cmpSemver(appV, idxV);
    if (c > 0) hasGreater = true;
    else if (c < 0) hasLesser = true;
  }
  if (hasGreater && hasLesser) return 'conflict';
  if (hasGreater) return 'greater';
  if (hasLesser) return 'lesser';
  return 'equal';
}

function fallback(kibanaBin, passthrough, reason) {
  console.log(
    JSON.stringify({
      ecs: { version: '8.11.0' },
      '@timestamp': new Date().toISOString(),
      message: `Node fast-path falling back: ${reason}`,
      log: { level: 'WARN', logger: 'savedobjects-service' },
      kibana: { migrator: { path: 'fallback', fallback_reason: reason } },
    })
  );
  const res = spawnSync(kibanaBin, passthrough, { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchIndexWithRetry(baseUrl, prefix, maxWaitMs = 60_000) {
  const url = `${baseUrl}/${prefix}_*?ignore_unavailable=true`;
  const start = Date.now();
  let backoff = 100;
  const retryable = new Set([401, 403, 408, 429, 502, 503, 504]);
  while (true) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
      if (resp.status === 404) return {};
      if (retryable.has(resp.status) && Date.now() - start < maxWaitMs) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 2000);
        continue;
      }
      throw new Error(`ES HTTP ${resp.status}`);
    } catch (err) {
      if (Date.now() - start < maxWaitMs) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 2000);
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const started = performance.now();
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));

  const kibanaYmlPath = path.join(args.configDir, 'kibana.yml');
  const kibanaYml = fs.existsSync(kibanaYmlPath) ? fs.readFileSync(kibanaYmlPath, 'utf8') : '';
  const hostMatch = kibanaYml.match(/elasticsearch\.hosts:\s*\["?([^"\]]+)"?\]/);
  const baseUrl = (
    args.overrides['elasticsearch.hosts'] ||
    (hostMatch ? hostMatch[1] : null) ||
    process.env.ELASTICSEARCH_HOSTS ||
    'http://127.0.0.1:19200'
  ).replace(/\/$/, '');

  const deletedSet = new Set(manifest.removed_types);
  const enabledFlags = new Set(['security_script_library']);
  const activeIndices = Object.entries(manifest.indices).map(([prefix, types]) => ({
    prefix,
    appVersions: Object.fromEntries(
      types
        .filter((t) => !t.conditional_flag || enabledFlags.has(t.conditional_flag))
        .map((t) => [t.name, t.latest_model_version])
    ),
  }));

  const esStarted = performance.now();
  const results = await Promise.all(
    activeIndices.map(async (spec) => ({
      spec,
      es: await fetchIndexWithRetry(baseUrl, spec.prefix),
    }))
  );

  for (const { spec, es } of results) {
    const aliasMap = new Map();
    for (const [idxName, entry] of Object.entries(es)) {
      for (const alias of Object.keys(entry.aliases || {})) {
        const list = aliasMap.get(alias) || [];
        list.push(idxName);
        aliasMap.set(alias, list);
      }
    }
    for (const [alias, list] of aliasMap) {
      if (list.length > 1) fallback(args.kibanaBin, args.passthrough, `multi_index_alias:${spec.prefix}:${alias}`);
    }

    const current = aliasMap.get(spec.prefix)?.[0];
    if (!current || !es[current]) {
      fallback(args.kibanaBin, args.passthrough, `missing_index:${spec.prefix}`);
    }
    const entry = es[current];
    const meta = entry.mappings?._meta;
    if (!meta?.mappingVersions || !meta?.docVersions) {
      fallback(args.kibanaBin, args.passthrough, `non_zdt_algorithm:${spec.prefix}`);
    }
    for (const key of Object.keys(meta.mappingVersions)) {
      if (!spec.appVersions[key] && !deletedSet.has(key)) {
        fallback(args.kibanaBin, args.passthrough, `unknown_meta_mapping_type:${spec.prefix}:${key}`);
      }
    }
    for (const [rk, rv] of Object.entries(manifest.base_root_mappings)) {
      if (!deepEqual(rv, entry.mappings?.properties?.[rk])) {
        fallback(args.kibanaBin, args.passthrough, `updated_root_fields:${spec.prefix}:${rk}`);
      }
    }

    const mStatus = compareVersions(spec.appVersions, meta.mappingVersions, deletedSet);
    const dStatus = compareVersions(spec.appVersions, meta.docVersions, deletedSet);
    if (mStatus === 'equal' && dStatus === 'equal') {
      const vAlias = `${spec.prefix}_${manifest.kibana_version}`;
      if (!entry.aliases?.[spec.prefix] || !entry.aliases?.[vAlias]) {
        fallback(args.kibanaBin, args.passthrough, `missing_alias:${spec.prefix}:${vAlias}`);
      }
    } else if (mStatus === 'lesser' || dStatus === 'lesser') {
      if (mStatus === 'greater' || dStatus === 'greater' || mStatus === 'conflict' || dStatus === 'conflict') {
        fallback(args.kibanaBin, args.passthrough, `version_migration_needed:${spec.prefix}`);
      }
    } else {
      fallback(args.kibanaBin, args.passthrough, `version_migration_needed:${spec.prefix}:m=${mStatus},d=${dStatus}`);
    }
  }

  const migrationMs = Math.round(performance.now() - esStarted);
  const totalMs = Math.round(performance.now() - started);
  console.log(
    JSON.stringify({
      ecs: { version: '8.11.0' },
      '@timestamp': new Date().toISOString(),
      message: `Completed all migrations in ${migrationMs}ms`,
      log: { level: 'INFO', logger: 'savedobjects-service' },
      kibana: { migrator: { path: 'node-fast-noop', indices_checked: results.length, migration_ms: migrationMs, total_ms: totalMs } },
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
