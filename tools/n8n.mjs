#!/usr/bin/env node
/**
 * GitOps for n8n workflows.
 *
 *   pull      read workflows out of an n8n instance into workflows/ as normalized JSON
 *   validate  check workflows/ offline (structure, secrets, credential names, webhook paths)
 *   push      deploy workflows/ to an n8n instance (dry run unless --apply)
 *   scan      report anything secret-shaped in workflows/
 *
 * The committed JSON is the source of truth. It carries no instance ids and no
 * secrets: credentials are referenced by name and resolved to the target
 * instance's ids through n8n.config.json at deploy time.
 *
 * Environments and their credential maps live in n8n.config.json. URLs and API
 * keys come from the env vars that file names, never from the file itself.
 *
 * Usage:
 *   node tools/n8n.mjs pull --from cloud
 *   node tools/n8n.mjs validate --env selfhosted
 *   node tools/n8n.mjs push --to selfhosted            # dry run
 *   node tools/n8n.mjs push --to selfhosted --apply
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A workflow file that still contains a secret must never reach an instance:
// deploying one would write the placeholder into the live workflow.
export const REDACTION = '__SECRET_REDACTED__';

const SECRET_PATTERNS = [
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}/g, 'OpenAI-style API key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
  [/AIza[A-Za-z0-9_-]{30,}/g, 'Google API key'],
  [/eyJhbGciOi[A-Za-z0-9_.-]{20,}\.[A-Za-z0-9_.-]{10,}/g, 'JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key'],
];

// ------------------------------------------------------------------ arg parse

const [, , command, ...rest] = process.argv;
const has = (f) => rest.includes(f);
const val = (f, d) => {
  const i = rest.indexOf(f);
  return i === -1 ? d : rest[i + 1];
};
const all = (f) => rest.reduce((acc, a, i) => (a === f ? [...acc, rest[i + 1]] : acc), []);

const only = all('--only');
const matchesFilter = (name) => !only.length || only.some((s) => name.toLowerCase().includes(s.toLowerCase()));

// --------------------------------------------------------------------- config

function loadConfig() {
  const path = join(ROOT, 'n8n.config.json');
  if (!existsSync(path)) die('n8n.config.json not found at the repo root.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveEnv(config, envName) {
  const env = config.environments?.[envName];
  if (!env) die(`Unknown environment "${envName}". Known: ${Object.keys(config.environments || {}).join(', ')}`);
  // The URL is not a secret, so it can live in the config file; the key never can.
  const url = (env.urlEnv && process.env[env.urlEnv]) || env.url;
  const key = process.env[env.keyEnv];
  if (!url) die(`Environment "${envName}" has no url in n8n.config.json and no ${env.urlEnv} set.`);
  if (!key) die(`Environment "${envName}" needs ${env.keyEnv} to be set.`);
  return { name: envName, url: url.replace(/\/+$/, ''), key, credentials: env.credentials || {} };
}

const workflowsDir = () => join(ROOT, loadConfig().workflowsDir || 'workflows');

// ------------------------------------------------------------------ api calls

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
    const err = new Error(`${method} ${path} -> ${res.status}: ${redactString(text).slice(0, 400)}`);
    err.status = res.status;
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

// ------------------------------------------------------------------- normalize

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function redactString(s) {
  let out = s;
  for (const [re] of SECRET_PATTERNS) out = out.replace(re, REDACTION);
  return out;
}

function findSecrets(workflow) {
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

// Deterministic key order keeps pull output stable so PR diffs show real changes
// rather than reshuffled JSON.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortDeep(value[k])]));
  }
  return value;
}

const DROP_NODE_KEYS = ['webhookId_unused'];

/** Instance shape -> committed shape. Strips ids, keeps credentials by name. */
function normalize(workflow) {
  const nodes = (workflow.nodes || []).map((node) => {
    const clean = { ...node };
    for (const k of DROP_NODE_KEYS) delete clean[k];
    // A null parameter is n8n leftovers from a field that no longer applies.
    if (clean.parameters) {
      clean.parameters = Object.fromEntries(
        Object.entries(clean.parameters).filter(([, v]) => v !== null),
      );
    }
    if (clean.credentials) {
      clean.credentials = Object.fromEntries(
        Object.entries(clean.credentials).map(([type, ref]) => [type, { name: ref.name }]),
      );
    }
    return clean;
  });

  return sortDeep({
    name: workflow.name,
    active: !!workflow.active,
    nodes,
    connections: workflow.connections || {},
    settings: workflow.settings || { executionOrder: 'v1' },
  });
}

const KNOWN_SETTINGS = new Set([
  'executionOrder', 'timezone', 'errorWorkflow', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'saveManualExecutions', 'saveExecutionProgress',
  'executionTimeout', 'callerPolicy', 'callerIds',
]);

/** Committed shape -> instance shape. Resolves credential names to target ids. */
function denormalize(workflow, instance, { minimalSettings = false } = {}) {
  const missing = [];
  const nodes = (workflow.nodes || []).map((node) => {
    if (!node.credentials) return node;
    const credentials = {};
    for (const [type, ref] of Object.entries(node.credentials)) {
      const id = instance.credentials[ref.name];
      if (!id) missing.push({ node: node.name, type, name: ref.name });
      credentials[type] = id ? { id, name: ref.name } : { name: ref.name };
    }
    return { ...node, credentials };
  });

  const settings = { ...(workflow.settings || {}) };
  if (minimalSettings) {
    for (const k of Object.keys(settings)) if (!KNOWN_SETTINGS.has(k)) delete settings[k];
  }

  return {
    payload: {
      name: workflow.name,
      nodes,
      connections: workflow.connections || {},
      settings: Object.keys(settings).length ? settings : { executionOrder: 'v1' },
    },
    missing,
  };
}

function webhookPathsOf(workflow) {
  const out = {};
  for (const node of workflow.nodes || []) {
    const path = node.parameters?.path;
    if (path && typeof path === 'string') out[node.name] = path;
  }
  return out;
}

function readLocalWorkflows() {
  const dir = workflowsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, workflow: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
    .filter(({ workflow }) => matchesFilter(workflow.name || ''));
}

// -------------------------------------------------------------------- commands

async function cmdPull() {
  const config = loadConfig();
  const source = resolveEnv(config, val('--from', 'cloud'));
  const dir = workflowsDir();
  mkdirSync(dir, { recursive: true });

  log(`pulling from ${source.name} (${source.url})`);
  const summaries = (await listWorkflows(source)).filter((w) => matchesFilter(w.name));
  log(`${summaries.length} workflow(s)\n`);

  let blocked = 0;
  const written = new Map();
  for (const summary of summaries) {
    const wf = await api(source, `/workflows/${summary.id}`);
    const file = `${slug(wf.name)}.json`;
    if (written.has(file)) {
      log(`- ${wf.name}  SKIPPED`);
      log(`    "${written.get(file)}" already claims ${file}. Two workflows whose`);
      log('    names differ only by punctuation cannot both be stored. Rename one.');
      process.exitCode = 1;
      continue;
    }
    written.set(file, wf.name);
    const secrets = findSecrets(wf);
    const normalized = normalize(wf);
    let text = JSON.stringify(normalized, null, 2) + '\n';

    if (secrets.length) {
      blocked++;
      text = redactString(text);
      log(`- ${wf.name}  BLOCKED`);
      for (const s of secrets) log(`    inline ${s.kind} in node "${s.node}"`);
    } else {
      log(`- ${wf.name}`);
    }
    writeFileSync(join(dir, file), text);
  }

  log(`\nwrote ${written.size} file(s) to ${dir}`);

  // A pull does not delete anything. A file left here for a workflow that no
  // longer exists on the source would be re-created by the next deploy, which
  // is rarely what someone wants, so say so rather than quietly leaving it.
  const pulled = new Set([...written.keys()]);
  const stale = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json') && !pulled.has(f))
    : [];
  if (stale.length) {
    log('\nin git but not on the source (a deploy would re-create these):');
    for (const f of stale) log(`  - ${f}`);
    log('Delete the file if the workflow is genuinely gone.');
  }
  if (blocked) {
    log(`\n${blocked} workflow(s) had secrets pasted into node parameters. They were`);
    log(`replaced with ${REDACTION}, which validate and push both refuse to deploy.`);
    log('Fix them at the source, then pull again:');
    log('  - move the value into an n8n credential and set the node to use it, or');
    log('  - on self-hosted, reference it as {{ $env.SOMETHING }} and set that env var');
    log('Then rotate the exposed value, since it has been sitting in plaintext.');
    process.exitCode = 1;
  }
}

function cmdValidate() {
  const config = loadConfig();
  const envName = val('--env');
  const credentialNames = envName
    ? new Set(Object.entries(config.environments[envName]?.credentials || {}).filter(([, v]) => v).map(([k]) => k))
    : null;

  const files = readLocalWorkflows();
  if (!files.length) {
    log('no workflow files found — nothing to validate');
    return;
  }

  const errors = [];
  const warnings = [];
  const pathOwners = new Map();

  for (const { file, workflow } of files) {
    const where = `${file}`;
    if (!workflow.name) errors.push(`${where}: missing "name"`);
    if (!Array.isArray(workflow.nodes) || !workflow.nodes.length) errors.push(`${where}: missing "nodes"`);
    if (typeof workflow.connections !== 'object') errors.push(`${where}: missing "connections"`);
    if (typeof workflow.active !== 'boolean') warnings.push(`${where}: no "active" flag, will be left inactive`);

    const raw = JSON.stringify(workflow);
    if (raw.includes(REDACTION)) {
      errors.push(`${where}: contains ${REDACTION} — a secret was stripped here and the workflow cannot be deployed until it is replaced with a credential or an $env reference`);
    }
    for (const [re, label] of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(raw)) errors.push(`${where}: looks like it contains a live ${label}`);
    }

    for (const node of workflow.nodes || []) {
      for (const [type, ref] of Object.entries(node.credentials || {})) {
        if (!ref.name) errors.push(`${where}: node "${node.name}" has a ${type} credential with no name`);
        else if (credentialNames && !credentialNames.has(ref.name)) {
          errors.push(`${where}: node "${node.name}" needs credential "${ref.name}", which has no id mapped for "${envName}" in n8n.config.json`);
        }
      }
    }

    // Two workflows claiming one webhook path is a silent production break: the
    // second one to activate loses.
    for (const [node, path] of Object.entries(webhookPathsOf(workflow))) {
      const key = path.toLowerCase();
      if (pathOwners.has(key)) {
        errors.push(`${where}: webhook path "${path}" (node "${node}") is already used by ${pathOwners.get(key)}`);
      } else {
        pathOwners.set(key, `${where} (node "${node}")`);
      }
    }
  }

  for (const w of warnings) log(`warn:  ${w}`);
  for (const e of errors) log(`ERROR: ${e}`);
  log(`\n${files.length} workflow(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (errors.length) process.exitCode = 1;
}

function cmdScan() {
  const files = readLocalWorkflows();
  let found = 0;
  for (const { file, workflow } of files) {
    for (const s of findSecrets(workflow)) {
      log(`${file}: inline ${s.kind} in node "${s.node}"`);
      found++;
    }
    if (JSON.stringify(workflow).includes(REDACTION)) {
      log(`${file}: contains ${REDACTION} (a secret was stripped on pull and still needs a real fix)`);
      found++;
    }
  }
  log(found ? `\n${found} finding(s)` : 'no secrets found in workflows/');
  if (found) process.exitCode = 1;
}

async function cmdPush() {
  const config = loadConfig();
  const target = resolveEnv(config, val('--to', 'selfhosted'));
  const apply = has('--apply');
  const allowWebhookChange = has('--allow-webhook-change');

  log(`target: ${target.name} (${target.url})`);
  log(apply ? 'mode:   APPLY' : 'mode:   dry run (pass --apply to write)');
  log('');

  const files = readLocalWorkflows();
  const remote = await listWorkflows(target);
  const byName = new Map(remote.map((w) => [w.name, w]));

  const plan = { create: [], update: [], unchanged: [], activate: [], deactivate: [], failed: [] };
  let blocked = false;

  for (const { file, workflow } of files) {
    const raw = JSON.stringify(workflow);
    if (raw.includes(REDACTION)) {
      log(`- ${workflow.name}  REFUSED (${file} still contains ${REDACTION})`);
      blocked = true;
      continue;
    }

    const { payload, missing } = denormalize(workflow, target);
    if (missing.length) {
      for (const m of missing) log(`  ! no "${target.name}" credential id mapped for "${m.name}" (node "${m.node}")`);
      log(`- ${workflow.name}  REFUSED (unmapped credentials)`);
      blocked = true;
      continue;
    }

    const existing = byName.get(workflow.name);

    if (existing) {
      // Changing a webhook path breaks whatever is calling it (Slack's
      // interactivity URL, a Tally subscription) with no error on either side.
      const current = await api(target, `/workflows/${existing.id}`);
      const before = webhookPathsOf(current);
      const after = webhookPathsOf(workflow);
      const changed = Object.keys(after).filter((n) => before[n] && before[n] !== after[n]);
      if (changed.length && !allowWebhookChange) {
        for (const n of changed) log(`  ! webhook path for node "${n}" changes: ${before[n]} -> ${after[n]}`);
        log(`- ${workflow.name}  REFUSED (webhook path change; callers such as Slack and Tally point at the old path)`);
        log('    re-run with --allow-webhook-change once the caller has been updated');
        blocked = true;
        continue;
      }

      const same = JSON.stringify(normalize({ ...current, active: workflow.active })) === JSON.stringify(normalize({ ...workflow, active: workflow.active }));
      if (same) {
        log(`- ${workflow.name}  unchanged`);
        plan.unchanged.push(workflow.name);
      } else {
        log(`- ${workflow.name}  ${apply ? 'updating' : 'would update'} (${existing.id})`);
        plan.update.push(workflow.name);
        if (apply) await upsert(target, payload, workflow, existing.id, plan);
      }
      if (apply || same) await convergeActive(target, existing.id, workflow, plan, apply);
    } else {
      log(`- ${workflow.name}  ${apply ? 'creating' : 'would create'}`);
      plan.create.push(workflow.name);
      if (apply) {
        const created = await upsert(target, payload, workflow, null, plan);
        if (created) await convergeActive(target, created.id, workflow, plan, apply);
      }
    }
  }

  // A workflow on the target that git does not know about is not deleted
  // automatically; deleting live automation on a name typo is not a tradeoff
  // worth making.
  const localNames = new Set(files.map(({ workflow }) => workflow.name));
  const orphans = remote.filter((w) => !localNames.has(w.name));
  if (orphans.length && !only.length) {
    log('\nnot managed by git (left alone):');
    for (const o of orphans) log(`  - ${o.name}${o.active ? ' (active)' : ''}`);
  }

  log('\n================ summary ================');
  log(`create: ${plan.create.length}  update: ${plan.update.length}  unchanged: ${plan.unchanged.length}  failed: ${plan.failed.length}`);
  if (plan.activate.length) log(`activated: ${plan.activate.join(', ')}`);
  if (plan.deactivate.length) log(`deactivated: ${plan.deactivate.join(', ')}`);
  if (plan.failed.length) {
    for (const f of plan.failed) log(`FAILED ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
  if (blocked) {
    log('\none or more workflows were refused — nothing partial was written for them');
    process.exitCode = 1;
  }
  if (!apply) log('\ndry run only — no changes were written');
}

async function upsert(target, payload, workflow, existingId, plan) {
  const send = (body) => (existingId
    ? api(target, `/workflows/${existingId}`, { method: 'PUT', body })
    : api(target, '/workflows', { method: 'POST', body }));
  try {
    try {
      return await send(payload);
    } catch (e) {
      if (e.status !== 400) throw e;
      // Older targets reject settings keys a newer source added.
      log('    target rejected the payload, retrying with minimal settings');
      const { payload: lean } = denormalize(workflow, target, { minimalSettings: true });
      return await send(lean);
    }
  } catch (e) {
    log(`    failed: ${e.message}`);
    plan.failed.push({ name: workflow.name, error: e.message });
    return null;
  }
}

async function convergeActive(target, id, workflow, plan, apply) {
  const current = await api(target, `/workflows/${id}`);
  if (!!current.active === !!workflow.active) return;
  if (!apply) return;
  try {
    await api(target, `/workflows/${id}/${workflow.active ? 'activate' : 'deactivate'}`, { method: 'POST' });
    plan[workflow.active ? 'activate' : 'deactivate'].push(workflow.name);
  } catch (e) {
    log(`    could not ${workflow.active ? 'activate' : 'deactivate'}: ${e.message}`);
    plan.failed.push({ name: workflow.name, error: e.message });
  }
}

// ------------------------------------------------------------------------ main

function log(...a) { console.log(...a); }
function die(msg) { console.error(msg); process.exit(1); }

const commands = { pull: cmdPull, push: cmdPush, validate: cmdValidate, scan: cmdScan };

if (!commands[command]) {
  die(`usage: node tools/n8n.mjs <pull|push|validate|scan> [options]\n\n${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(2).map((l) => l.replace(/^ \* ?/, '')).join('\n')}`);
}

try {
  await commands[command]();
} catch (e) {
  console.error(e);
  process.exit(1);
}
