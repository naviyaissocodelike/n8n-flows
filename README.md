# District Angels n8n

Workflows for `https://n8n.districtangels.com` live in `workflows/` as JSON. Merging
to `main` deploys them. Nothing is edited straight on the server as the permanent
record: if you build something in the n8n editor, import it back into git.

```
workflows/          one JSON file per workflow, the source of truth
n8n.config.json     instance URLs + credential name -> id map per environment
tools/n8n.mjs       pull / validate / push / scan
migration/          the one-time cloud -> self-hosted cutover
```

## How a change ships

1. Edit a file in `workflows/`, or build it in the n8n editor and run the
   **Import n8n workflows from an instance** action to pull it into a PR.
2. Open a PR. CI validates it offline and comments a plan showing exactly what would
   change on the instance.
3. Merge. The deploy action pushes to `n8n.districtangels.com` and converges each
   workflow's active state to the `"active"` flag in its file.

Deploys are idempotent, so re-running changes nothing. A workflow on the instance that
git does not know about is reported and left alone, never deleted.

## Rules the tooling enforces

**No secrets in git.** Credentials are referenced by name; ids are resolved per
environment from `n8n.config.json`. If a pull finds an API key pasted into a node
parameter it writes `__SECRET_REDACTED__` instead, and both validate and deploy refuse
to ship that file. Fix it at the source by moving the value into a credential.

**No silent webhook breakage.** Slack's interactivity URL and Tally's subscription
point at a fixed path. A deploy that would change the path of an existing webhook is
refused until someone repoints the caller and re-runs with `--allow-webhook-change`.
Paths listed under `webhookHealthchecks` are probed after every deploy.

**No duplicate webhook paths.** Two workflows claiming one path is a production break
where the second to activate quietly loses. Validation catches it before merge.

## Local use

```bash
export N8N_SELFHOSTED_API_KEY=...     # Settings -> n8n API on the instance
export N8N_CLOUD_API_KEY=...          # only needed to pull from the old cloud account

node tools/n8n.mjs pull --from cloud        # instance -> workflows/
node tools/n8n.mjs validate --env selfhosted
node tools/n8n.mjs push --to selfhosted     # dry run
node tools/n8n.mjs push --to selfhosted --apply
node tools/n8n.mjs scan                     # secrets in workflows/
```

`--only <substring>` narrows any command to matching workflows.

## Repository secrets

| Secret | Used by |
| --- | --- |
| `N8N_SELFHOSTED_API_KEY` | plan, deploy, import |
| `N8N_CLOUD_API_KEY` | import from the old cloud account |

The deploy job runs in the `n8n-selfhosted` environment, so you can require an approval
there if you want a human gate on production changes.

## Adding a credential

Create it in the n8n UI, then add its name and id to
`n8n.config.json` → `environments.selfhosted.credentials`. Validation fails on any
credential a workflow references but the map does not have, which is what stops a
deploy from landing a workflow that cannot authenticate.
