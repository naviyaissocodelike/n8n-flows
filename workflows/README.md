# n8n Workflows

Exported n8n workflow JSON files live here.

## Workflow folder structure

- `workflows/*.json` — Individual workflow definitions
- Common naming: `kebab-case.json`
- Each JSON must contain a valid n8n workflow object with a `name` field

## Deployment

All `.json` files here are automatically deployed via GitHub Actions on every push to
the default branch (`feature/newsletter-flow`). See `.github/workflows/deploy.yml`.

## Exporting from n8n

1. Open your workflow in the n8n editor
2. Go to **Workflow** → **Export** → **JSON**
3. Save to this folder with a descriptive filename
4. Commit and push — the runner deploys it automatically