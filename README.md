# n8n-flows

Automated n8n workflow deployment via GitHub Actions + self-hosted runner on Hetzner.

## What's here

| File | Purpose |
|------|---------|
| `.github/workflows/deploy.yml` | CI/CD — validates and deploys n8n workflows on push |
| `workflows/` | n8n workflow JSON files (exported from n8n editor) |
| `composio-trigger.yaml` | Composio automation trigger for daily Gemini transcript summary |
| `da-newsletter-flow.ts` | Pi extension command to check `#da-newsletter-flow` Slack channel |
| `runner-setup.md` | Docker commands to register a self-hosted runner on Hetzner |

## Setup

1. Set up the self-hosted runner on Hetzner (see [runner-setup.md](runner-setup.md))
2. Add repository secrets:
   - `N8N_API_KEY` — Your n8n API key
   - `N8N_BASE_URL` — e.g. `https://n8n.districtangels.com`
   - `SLACK_WEBHOOK_URL` — Slack webhook for deployment notifications
3. Push workflow JSONs to `workflows/` — they deploy automatically

## Notes

- The default branch is `feature/newsletter-flow`
