/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import http from 'node:http';
import fs from 'node:fs';

const manifestPath = process.argv[2];
const mode = process.argv[3] || 'noop';
const port = Number(process.argv[4] || 19200);
const latencyMs = Number(process.argv[5] || 2);
const warmupMs = Number(process.argv[6] || 2000);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const startedAt = Date.now();
let requestCount = 0;

function bumpVersion(v) {
  const parts = v.split('.').map(Number);
  return `${parts[0]}.${parts[1] + 1}.${parts[2]}`;
}

const ENABLED_FLAGS = new Set(['security_script_library']);

function buildIndexPayload(prefix, types) {
  if (mode === 'missing_index' && prefix === '.kibana_ingest') {
    return {};
  }

  const activeTypes = types.filter((t) => !t.conditional_flag || ENABLED_FLAGS.has(t.conditional_flag));
  const mappingVersions = {};
  const docVersions = {};
  const properties = structuredClone(manifest.base_root_mappings);

  for (const t of activeTypes) {
    let ver = t.latest_model_version;
    if (mode === 'rollback') {
      ver = bumpVersion(ver);
    }
    mappingVersions[t.name] = ver;
    docVersions[t.name] = ver;
    properties[t.name] = {
      type: 'object',
      properties: { title: { type: 'text' }, updated_at: { type: 'date' } },
    };
  }

  if (mode === 'bump' && prefix === '.kibana_analytics' && activeTypes.length > 0) {
    const higher = activeTypes.find((x) => x.latest_model_version !== '10.0.0');
    if (higher) {
      mappingVersions[higher.name] = '10.0.0';
      docVersions[higher.name] = '10.0.0';
    } else {
      delete mappingVersions[activeTypes[0].name];
      delete docVersions[activeTypes[0].name];
    }
  }

  if (mode === 'unknown_meta' && prefix === '.kibana') {
    mappingVersions['untracked_plugin_so_type'] = '10.1.0';
    docVersions['untracked_plugin_so_type'] = '10.1.0';
  }

  const aliases = { [prefix]: {} };
  if (mode === 'rollback') {
    aliases[`${prefix}_99.0.0`] = {};
  } else {
    aliases[`${prefix}_${manifest.kibana_version}`] = {};
  }

  return {
    [`${prefix}_1`]: {
      aliases,
      mappings: {
        dynamic: 'strict',
        _meta: {
          mappingVersions,
          docVersions,
          migrationState: { convertingDocuments: false },
        },
        properties,
      },
    },
  };
}

const payloads = new Map();
for (const [prefix, types] of Object.entries(manifest.indices)) {
  payloads.set(prefix, JSON.stringify(buildIndexPayload(prefix, types)));
}

const server = http.createServer((req, res) => {
  requestCount += 1;
  const pathname = (req.url || '/').split('?')[0];

  if (pathname === '/_health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode, requestCount }));
    return;
  }

  if (mode === 'cold_warmup' && Date.now() - startedAt < warmupMs) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        message: 'The requested resource is in an initializing state and not yet ready',
      })
    );
    return;
  }

  const match = pathname.match(/^\/(\.[^/_]+(?:_[^/_]+)*)_\*$/);
  const prefix = match ? match[1] : null;
  const body = prefix && payloads.has(prefix) ? payloads.get(prefix) : '{}';

  const send = () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  };

  if (latencyMs > 0) {
    setTimeout(send, latencyMs);
  } else {
    send();
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`MOCK_ES_READY port=${port} mode=${mode}\n`);
});
