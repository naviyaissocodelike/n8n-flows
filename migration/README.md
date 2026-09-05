# Migrating n8n from cloud to self-hosted

Moves the District Angels workflows from `districtangels.app.n8n.cloud` to
`https://n8n.districtangels.com`.

Workflow JSON moves cleanly over the API. Three things do not, and they are where
migrations usually break:

1. **Credential secrets never leave n8n.** The API returns credential names and ids,
   never the OAuth tokens or keys behind them. Every credential gets re-created by
   hand on the self-hosted instance, and the migration remaps node references to the
   new ids.
2. **Webhook URLs change host.** Anything that calls into n8n (Tally, Slack
   interactivity, Composio) points at the cloud hostname today and has to be repointed.
3. **Schedules resume immediately.** A workflow activated on the new instance while
   the old one is still active will send the same emails twice.

`inventory.md` lists what is in the cloud account and which of these apply to each
workflow.

## Prerequisites

- Node 18+ on a machine that can reach both instances (this repo's Claude session
  cannot: `n8n.districtangels.com` is blocked by the sandbox network policy, so the
  migration runs from your laptop).
- An API key on each instance: Settings → n8n API → Create an API key.
- Owner/admin on the self-hosted instance.
- The self-hosted n8n on a version at least as new as the cloud one. Node type
  versions in the exports (for example `googleSheets` v4.7, `switch` v3.4) will not
  load on an older build. Check `Settings → About` on both and upgrade the
  self-hosted side first if it is behind.

```bash
cp migration/.env.example migration/.env   # fill in both API keys
set -a; . ./migration/.env; set +a
```

## Step 1 — back up the cloud account

```bash
node migration/n8n-migrate.mjs --pull-only
```

Writes every workflow to `migration/backups/` (gitignored) with inline secrets
redacted, and prints a report: workflows found, credentials in use, webhook paths,
and any secrets hardcoded into node parameters instead of held in a credential.

Do this before anything else. It is also the rollback: the cloud account stays
untouched and these files can be re-imported anywhere.

## Step 2 — re-create credentials on the self-hosted instance

For each entry in `credential-map.json`, create the matching credential at
`https://n8n.districtangels.com/home/credentials`, then paste its id (from the
credential's URL) into `targetId`.

Notes for this account specifically:

- The Google credentials (Sheets, Docs, Drive, Gmail ×3) are OAuth2. Add
  `https://n8n.districtangels.com/rest/oauth2-credential/callback` as an authorized
  redirect URI in the Google Cloud project first, otherwise the connect flow fails.
  The cloud instance may be using n8n's shared OAuth app, in which case you need your
  own client id and secret on the self-hosted side.
- Same for the Slack OAuth2 credential: add the self-hosted redirect URL to the Slack
  app's OAuth settings.
- `n8n free OpenAI API credits` is an n8n Cloud managed credential. It does not exist
  off cloud. Replace it with a real OpenAI key, or point those nodes elsewhere.

## Step 3 — dry run

```bash
node migration/n8n-migrate.mjs
```

No writes. It reports what it would create, which credentials are still unmapped, and
which webhook endpoints will need repointing. Fix anything it flags before continuing.

## Step 4 — migrate

```bash
node migration/n8n-migrate.mjs --apply
```

Everything lands **inactive** by design, with credentials remapped and sub-workflow
references repointed to the new ids. Re-running is safe: a workflow whose name already
exists on the target is skipped unless you pass `--update`.

Useful variations:

```bash
node migration/n8n-migrate.mjs --apply --only "DA Daily Email Sender"   # one at a time
node migration/n8n-migrate.mjs --apply --update --only "DA Slack"       # push a fix again
```

## Step 5 — repoint the callers

Trigger URLs move from `https://districtangels.app.n8n.cloud/webhook/<path>` to
`https://n8n.districtangels.com/webhook/<path>`. The path stays the same, the host does
not. Concretely:

- **Slack Pass Handler** (`/webhook/da-pass`) — update the Request URL under
  Interactivity & Shortcuts in the Slack app config.
- **Intake Form Notification** — the Tally trigger re-registers its webhook with Tally
  when the workflow is activated on the new instance, so activate it there and confirm
  the subscription landed on the Tally side.
- The newsletter flow already in this repo (`composio-trigger.yaml`,
  `da-newsletter-flow.ts`) points at `n8n.districtangels.com` and needs no change. Its
  `newsletter-flow-trigger` webhook has to exist on the self-hosted instance for those
  calls to land, which they currently do not — that workflow is not in the cloud
  account, so import `newsletter-flow-trigger.json` separately from the UI.

Verify the new endpoint answers before flipping anything live:

```bash
curl -i https://n8n.districtangels.com/webhook/da-pass -X POST -d 'payload={}'
```

## Step 6 — cut over

Order matters, because both instances will otherwise fire the same schedules.

1. Deactivate the workflow on **cloud** first.
2. Activate it on **self-hosted** (`--activate`, or the toggle in the UI).
3. Watch the first real execution end to end before moving to the next one.

Suggested order, lowest blast radius first:

1. `DA Review Backlog → Slack` (manual trigger, safe to test any time)
2. `DA Slack Pass Handler` (webhook; needs the Slack app URL updated first)
3. `DA Daily Email Sender` (schedule; **sends founder email**, cut over right after a
   9am run so you have a full day of margin)
4. `Intake Form Notification and Persona-Based Email Response` (Tally webhook; the big
   one, 44 nodes)

Leave the cloud account alive but fully deactivated for a couple of weeks before
cancelling. Executions do not migrate, so the cloud execution history is the only
record of anything that ran there.

## Rollback

Nothing here modifies the cloud instance. If the self-hosted side misbehaves,
deactivate it and re-activate on cloud. The workflows in `migration/backups/` can be
imported into either instance from the UI (Workflows → Import from file), remembering
that redacted inline secrets need to be re-entered.

## Self-hosted things worth setting before you rely on this

- `WEBHOOK_URL=https://n8n.districtangels.com` so the editor shows and registers the
  correct public webhook URLs behind the reverse proxy.
- `GENERIC_TIMEZONE` and `TZ` set to `America/New_York`. Schedule triggers use the
  instance timezone, and the daily sender is meant to run at 9am Eastern.
- `N8N_ENCRYPTION_KEY` persisted and backed up. Lose it and every credential you are
  about to create becomes unreadable.
- Regular backups of the n8n database volume.
- `EXECUTIONS_DATA_PRUNE` and a retention window, or executions will grow unbounded.
