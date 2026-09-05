#!/usr/bin/env node
/**
 * Migrate n8n workflows from one instance to another (cloud -> self-hosted).
 *
 * Uses the n8n public REST API (/api/v1) on both sides. Nothing is written to
 * the target unless you pass --apply; the default is a dry run.
 *
 * Required env (put them in migration/.env and `set -a; . ./migration/.env; set +a`):
 *   N8N_SOURCE_URL       e.g. https://districtangels.app.n8n.cloud
 *   N8N_SOURCE_API_KEY   Settings -> n8n API -> create key (on the cloud instance)
 *   N8N_TARGET_URL       e.g. https://n8n.districtangels.com
 *   N8N_TARGET_API_KEY   Settings -> n8n API -> create key (on the self-hosted instance)
 *
 * Flags:
 *   --apply            actually write to the target (default: dry run)
 *   --pull-only        only download source workflows to ./backups, never touch the target
 *   --update           overwrite a target workflow when one already has the same name
 *   --activate         activate migrated workflows that were active on the source
 *   --only <substr>    only handle workflows whose name contains <substr> (repeatable)
 *   --backup-dir <dir> where to write raw exports (default: migration/backups)
 *   --map <file>       credential map (default: migration/credential-map.json)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args + env

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
const all = (f) => argv.reduce((acc, a, i) => (a === f ? [...acc, argv[i + 1]] : acc), []);

const opts = {
  apply: has('--apply'),
  pullOnly: has('--pull-only'),
  update: has('--update'),
  activate: has('--activate'),
  only: all('--only'),
  backupDir: val('--backup-dir', join(HERE, 'backups')),
  mapFile: val('--map', join(HERE, 'credential-map.json')),
};

const env = (k, required) => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`Missing required env var ${k}. See migration/README.md.`);
    process.exit(1);
  }
  return v ? v.replace(/\/+$/, '') : v;
};

const SOURCE = { url: env('N8N_SOURCE_URL', true), key: process.env.N8N_SOURCE_API_KEY };
const TARGET = { url: env('N8N_TARGET_URL', !opts.pullOnly), key: process.env.N8N_TARGET_API_KEY };
if (!SOURCE.key) { console.error('Missing required env var N8N_SOURCE_API_KEY.'); process.exit(1); }
if (!opts.pullOnly && !TARGET.key) { console.error('Missing required env var N8N_TARGET_API_KEY.'); process.exit(1); }

// -------------------------------------------------------------------- helpers

async function api(instance, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${instance.url}/api/v1${path}`, {
    method,
    headers: {
      'X-N8N-API-KEY': instance.key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function listWorkflows(instance) {
  const out = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    const page = await api(instance, `/workflows?${qs}`);
    out.push(...(page.data || []));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Secrets that end up inline in node parameters instead of in a credential.
// They do not survive a migration cleanly and should be rotated, so we surface them.
const SECRET_PATTERNS = [
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API key'],
  [/sk-[A-Za-z0-9]{32,}/g, 'OpenAI-style API key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
  [/AIza[A-Za-z0-9_-]{30,}/g, 'Google API key'],
  [/eyJhbGciOi[A-Za-z0-9_.-]{20,}/g, 'JWT'],
];

function scanSecrets(workflow) {
  const hits = [];
  for (const node of workflow.nodes || []) {
    const blob = JSON.stringify(node.parameters || {});
    for (const [re, label] of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(blob)) hits.push({ node: node.name, kind: label });
    }
  }
  return hits;
}

// Redact inline secrets before anything touches disk, so a backup can never
// become the thing that leaks a token.
function redact(workflow) {
  let json = JSON.stringify(workflow);
  for (const [re] of SECRET_PATTERNS) json = json.replace(re, '<<REDACTED>>');
  return JSON.parse(json);
}

// POST /workflows rejects unknown top-level properties, so send only what the
// public API accepts.
const KNOWN_SETTINGS = new Set([
  'executionOrder', 'timezone', 'errorWorkflow', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'saveManualExecutions', 'saveExecutionProgress',
  'executionTimeout', 'callerPolicy', 'callerIds',
]);

function toCreatePayload(workflow, { minimalSettings = false } = {}) {
  const settings = { ...(workflow.settings || {}) };
  if (minimalSettings) {
    for (const k of Object.keys(settings)) if (!KNOWN_SETTINGS.has(k)) delete settings[k];
  }
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: Object.keys(settings).length ? settings : { executionOrder: 'v1' },
  };
}

function loadCredentialMap() {
  if (!existsSync(opts.mapFile)) return { byId: {}, unmapped: new Set() };
  const raw = JSON.parse(readFileSync(opts.mapFile, 'utf8'));
  const byId = {};
  for (const entry of raw.credentials || []) {
    if (entry.targetId) byId[entry.sourceId] = { id: entry.targetId, name: entry.targetName || entry.sourceName };
  }
  return { byId, unmapped: new Set() };
}

// Rewrite each node's credential reference to the target instance's credential.
function remapCredentials(workflow, map) {
  const missing = [];
  for (const node of workflow.nodes || []) {
    for (const [type, ref] of Object.entries(node.credentials || {})) {
      const hit = map.byId[ref.id];
      if (hit) {
        node.credentials[type] = { id: hit.id, name: hit.name };
      } else {
        missing.push({ node: node.name, type, name: ref.name, id: ref.id });
      }
    }
  }
  return missing;
}

// Sub-workflow calls reference workflow ids, which change on the target.
function remapSubWorkflowIds(workflow, idMap) {
  const rewritten = [];
  for (const node of workflow.nodes || []) {
    if (!/executeWorkflow|toolWorkflow/i.test(node.type || '')) continue;
    const p = node.parameters || {};
    for (const key of ['workflowId', 'source']) {
      const ref = p[key];
      if (ref && typeof ref === 'object' && ref.value && idMap[ref.value]) {
        ref.value = idMap[ref.value];
        rewritten.push(`${workflow.name}: ${node.name}.${key}`);
      } else if (typeof ref === 'string' && idMap[ref]) {
        p[key] = idMap[ref];
        rewritten.push(`${workflow.name}: ${node.name}.${key}`);
      }
    }
  }
  return rewritten;
}

function webhookPaths(workflow) {
  return (workflow.nodes || [])
    .filter((n) => /webhook$/i.test(n.type || '') || /Trigger$/.test(n.type || ''))
    .map((n) => ({ node: n.name, type: n.type, path: n.parameters?.path, method: n.parameters?.httpMethod }))
    .filter((n) => n.path || /webhook/i.test(n.type));
}

// ----------------------------------------------------------------------- main

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('  !', ...a);

async function main() {
  log(`source: ${SOURCE.url}`);
  if (!opts.pullOnly) log(`target: ${TARGET.url}`);
  log(opts.apply ? 'mode:   APPLY (writes to target)' : 'mode:   dry run (pass --apply to write)');
  log('');

  let workflows = await listWorkflows(SOURCE);
  if (opts.only.length) {
    workflows = workflows.filter((w) => opts.only.some((s) => w.name.toLowerCase().includes(s.toLowerCase())));
  }
  log(`found ${workflows.length} workflow(s) on the source\n`);

  mkdirSync(opts.backupDir, { recursive: true });

  const map = loadCredentialMap();
  const idMap = {};
  const report = { created: [], updated: [], skipped: [], failed: [], secrets: [], missingCreds: [], webhooks: [] };

  for (const summary of workflows) {
    const wf = await api(SOURCE, `/workflows/${summary.id}`);
    log(`- ${wf.name}  (${wf.nodes?.length ?? 0} nodes, source id ${wf.id}, ${wf.active ? 'ACTIVE' : 'inactive'})`);

    const secrets = scanSecrets(wf);
    for (const s of secrets) {
      warn(`inline ${s.kind} in node "${s.node}" — move it into a credential and rotate it`);
      report.secrets.push({ workflow: wf.name, ...s });
    }

    writeFileSync(join(opts.backupDir, `${slug(wf.name)}.json`), JSON.stringify(redact(wf), null, 2));

    const hooks = webhookPaths(wf);
    for (const h of hooks) report.webhooks.push({ workflow: wf.name, ...h });

    if (opts.pullOnly) continue;

    const missing = remapCredentials(wf, map);
    for (const m of missing) {
      warn(`no target credential mapped for "${m.name}" (${m.type}) used by node "${m.node}"`);
      report.missingCreds.push({ workflow: wf.name, ...m });
    }

    const existing = (await listWorkflows(TARGET)).find((t) => t.name === wf.name);
    if (existing && !opts.update) {
      log(`  already on target as ${existing.id} — skipping (pass --update to overwrite)`);
      idMap[wf.id] = existing.id;
      report.skipped.push(wf.name);
      continue;
    }

    if (!opts.apply) {
      log(`  would ${existing ? 'update' : 'create'} on target`);
      report[existing ? 'updated' : 'created'].push(wf.name);
      continue;
    }

    try {
      let created;
      try {
        created = existing
          ? await api(TARGET, `/workflows/${existing.id}`, { method: 'PUT', body: toCreatePayload(wf) })
          : await api(TARGET, '/workflows', { method: 'POST', body: toCreatePayload(wf) });
      } catch (e) {
        if (e.status !== 400) throw e;
        // Older target versions reject settings keys the cloud added; retry lean.
        warn('target rejected the payload, retrying with minimal settings');
        const lean = toCreatePayload(wf, { minimalSettings: true });
        created = existing
          ? await api(TARGET, `/workflows/${existing.id}`, { method: 'PUT', body: lean })
          : await api(TARGET, '/workflows', { method: 'POST', body: lean });
      }
      idMap[wf.id] = created.id;
      log(`  ${existing ? 'updated' : 'created'} on target as ${created.id}`);
      report[existing ? 'updated' : 'created'].push(wf.name);
    } catch (e) {
      warn(`failed: ${e.message}`);
      report.failed.push({ name: wf.name, error: e.message });
    }
  }

  // Second pass: sub-workflow references can only be fixed once every workflow
  // exists on the target and we know its new id.
  if (opts.apply && !opts.pullOnly) {
    for (const [sourceId, targetId] of Object.entries(idMap)) {
      const wf = await api(TARGET, `/workflows/${targetId}`);
      const rewritten = remapSubWorkflowIds(wf, idMap);
      if (!rewritten.length) continue;
      try {
        await api(TARGET, `/workflows/${targetId}`, { method: 'PUT', body: toCreatePayload(wf) });
      } catch (e) {
        if (e.status !== 400) throw e;
        await api(TARGET, `/workflows/${targetId}`, { method: 'PUT', body: toCreatePayload(wf, { minimalSettings: true }) });
      }
      log(`repointed sub-workflow reference(s): ${rewritten.join(', ')}`);
    }

    if (opts.activate) {
      for (const summary of workflows) {
        if (!summary.active || !idMap[summary.id]) continue;
        try {
          await api(TARGET, `/workflows/${idMap[summary.id]}/activate`, { method: 'POST' });
          log(`activated on target: ${summary.name}`);
        } catch (e) {
          warn(`could not activate "${summary.name}": ${e.message}`);
        }
      }
    }
  }

  // -------------------------------------------------------------- the summary
  log('\n================ summary ================');
  log(`created: ${report.created.length}  updated: ${report.updated.length}  skipped: ${report.skipped.length}  failed: ${report.failed.length}`);
  if (report.failed.length) {
    log('\nfailed:');
    for (const f of report.failed) log(`  - ${f.name}: ${f.error}`);
  }
  if (report.missingCreds.length) {
    log('\ncredentials still to map (create them on the target, then fill in credential-map.json):');
    const seen = new Set();
    for (const m of report.missingCreds) {
      const k = `${m.name}|${m.type}`;
      if (seen.has(k)) continue;
      seen.add(k);
      log(`  - ${m.name}  (${m.type}, source id ${m.id})`);
    }
  }
  if (report.secrets.length) {
    log('\ninline secrets found in node parameters (rotate these, they were valid on the cloud instance):');
    for (const s of report.secrets) log(`  - ${s.workflow} / ${s.node}: ${s.kind}`);
  }
  if (report.webhooks.length) {
    log('\nwebhook/trigger endpoints that change host — repoint the caller at the self-hosted URL:');
    for (const h of report.webhooks) {
      log(`  - ${h.workflow} / ${h.node}${h.path ? `  ${TARGET.url || '<target>'}/webhook/${h.path}` : `  (${h.type})`}`);
    }
  }
  log(`\nbackups written to ${opts.backupDir} (inline secrets redacted)`);
  if (!opts.apply && !opts.pullOnly) log('this was a dry run — re-run with --apply to write to the target');
}

main().catch((e) => { console.error(e); process.exit(1); });
