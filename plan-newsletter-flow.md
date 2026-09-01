---
name: da-newsletter-flow-integration
version: 1.0.0
description: Agent-driven workflow that monitors #da-newsletter-flow Slack channel and appends new activity to a running Google Doc.
---

# Newsletter Flow Integration

## Setup
- n8n: https://n8n.districtangels.com/ (API key auth)
- Slack: #da-newsletter-flow (default workspace active)
- Drive: "Newsletter Flow Log" doc (googledrive_gnomon-philip account)
- Trigger: agent command `/newsletter-check`
- Extension: `extensions/da-newsletter-flow.ts`

## Flow
1. Agent detects new Slack messages in `#da-newsletter-flow`
2. `/newsletter-check` triggers webhook to `n8n.districtangels.com`
3. `n8n` reads Slack → filters unprocessed → appends to Drive doc

## Files
- `extensions/da-newsletter-flow.ts` — `/newsletter-check` command
- `workflows/newsletter-flow-trigger.json` — `n8n` workflow
- Settings: `extensions` array updated

## Safety
- Only processes messages not previously marked (`processed: false` filter)
- Credentials isolated: Composio `agent_key` + `n8n` API key separate
