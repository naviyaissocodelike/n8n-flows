# Cloud to self-hosted cutover

One-time move from `districtangels.app.n8n.cloud` to `https://n8n.districtangels.com`.
It uses the same tooling as ongoing deploys (`tools/n8n.mjs`, see the root README), so
the migration is just the first pull and the first deploy.

`inventory.md` lists what is in the cloud account and what each workflow needs.

## What does not move by itself

1. **Credential secrets never leave n8n.** The API returns names and ids, never the
   OAuth tokens behind them. Re-create each credential by hand on the self-hosted
   instance and record its id in `n8n.config.json`.
2. **Webhook URLs change host.** Tally and the Slack app point at the cloud hostname.
3. **Schedules resume immediately.** A workflow active on both instances sends every
   founder email twice.
4. **Execution history does not move.** The cloud account is the only record of what
   ran there, so keep it around after cutting over.

## Prerequisites

- Node 20+ and an API key on each instance (Settings → n8n API).
- The self-hosted n8n on a version at least as new as cloud. Node type versions in the
  exports (`googleSheets` v4.7, `switch` v3.4) will not load on an older build. Check
  `Settings → About` on both and upgrade self-hosted first if it is behind.
- These set on the self-hosted instance before you rely on it:
  - `WEBHOOK_URL=https://n8n.districtangels.com` so registered webhook URLs are right
    behind the reverse proxy.
  - `GENERIC_TIMEZONE=America/New_York` and `TZ=America/New_York`. Schedule triggers
    use the instance timezone and the daily sender is meant to run at 9am Eastern.
  - `N8N_ENCRYPTION_KEY` persisted and backed up. Lose it and every credential you are
    about to create becomes unreadable.
  - A backup of the database volume, and `EXECUTIONS_DATA_PRUNE` with a retention
    window.

## 1. Pull the cloud account into git

Either run the **Import n8n workflows from an instance** action with source `cloud`,
which opens a PR, or locally:

```bash
export N8N_CLOUD_API_KEY=...
node tools/n8n.mjs pull --from cloud
```

Anything with a secret pasted into a node parameter comes back redacted and blocks the
deploy on purpose. Fix it in the n8n editor, then pull again.

## 2. Re-create credentials

For each name in `n8n.config.json` → `environments.selfhosted.credentials`, create the
credential in the self-hosted UI and paste its id (from the credential's URL) into the
map.

- The Google credentials (Sheets, Docs, Drive, Gmail ×3) and Slack are OAuth2. Add
  `https://n8n.districtangels.com/rest/oauth2-credential/callback` as an authorized
  redirect URI in the Google Cloud project and the Slack app first. If cloud was using
  n8n's shared OAuth app, you need your own client id and secret here.
- `n8n free OpenAI API credits` is an n8n Cloud managed credential and does not exist
  off cloud. Replace it with a real key.

`node tools/n8n.mjs validate --env selfhosted` fails until every referenced credential
is mapped.

## 3. Deploy

```bash
node tools/n8n.mjs push --to selfhosted            # dry run, read the plan
node tools/n8n.mjs push --to selfhosted --apply
```

Or merge the import PR and let the deploy action do it.

Workflows land with the active state recorded in their file. For the cutover you want
them **inactive** first: set `"active": false` in each file, deploy, verify, then flip
them on one at a time as below.

## 4. Repoint the callers

Paths stay the same, the host does not:
`https://districtangels.app.n8n.cloud/webhook/<path>` →
`https://n8n.districtangels.com/webhook/<path>`.

- **DA Slack Pass Handler** (`/webhook/da-pass`) — update the Request URL under
  Interactivity & Shortcuts in the Slack app config. This is a one-way switch: the Pass
  and Engage buttons route to whichever instance the Slack app names, so do it at the
  moment you flip that workflow over.
- **Intake Form Notification** — the Tally trigger re-registers with Tally when the
  workflow activates on the new instance. Activate it there and confirm on the Tally
  side that the subscription moved.
- The newsletter flow already in this repo (`composio-trigger.yaml`,
  `da-newsletter-flow.ts`) points at `n8n.districtangels.com` and needs no change. Its
  `newsletter-flow-trigger` webhook has to exist on the self-hosted instance for those
  calls to land, which it currently does not, so import `newsletter-flow-trigger.json`
  from the UI or add it to `workflows/`.

## 5. Cut over, one workflow at a time

Deactivate on cloud **first**, then activate on self-hosted, then watch a real
execution before moving on. Both instances write to the same Google Sheet, so there is
no safe window where both are live.

Suggested order, lowest blast radius first:

1. `DA Review Backlog → Slack` — manual trigger, sends nothing to founders. Run it once
   on self-hosted to prove the Sheets and Slack credentials work.
2. `DA Slack Pass Handler` — flip the Slack app Request URL at the same moment.
3. `DA Daily Email Sender` — sends founder email at 9am. Cut over right after a run so
   you have a full day of margin.
4. `Intake Form Notification and Persona-Based Email Response` — 44 nodes, the Tally
   webhook, and the most credentials.

Leave the cloud account deactivated but alive for a couple of weeks before cancelling.

## Rollback

Nothing in the tooling writes to cloud. If self-hosted misbehaves, deactivate it and
re-activate on cloud, then repoint the Slack Request URL back.
