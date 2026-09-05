# Cloud account inventory

Source: `https://districtangels.app.n8n.cloud` (project: District Angels
<team@districtangels.com>). Captured 2026-09-05 via the n8n API. 10 workflows,
12 credentials.

## Active workflows — these need a real cutover

### Intake Form Notification and Persona-Based Email Response
44 nodes, active, last updated 2026-08-21. The main deal intake pipeline: Tally
trigger → screening → Claude analysis of the deck → Google Doc one-pager → Drive
folder → Sheets log → Slack alert → acknowledgment email. Three submission routes
(company, referral, investor).

- Credentials: Tally, Google Docs, Google Drive, Google Sheets, Gmail (District
  Angels Team Email + Gmail account)
- Trigger: Tally webhook. Re-registers with Tally on activation; confirm on the Tally
  side that the subscription moved.
- Also calls the Anthropic API and Slack over plain HTTP Request nodes, so check those
  nodes for inline keys after migrating.
- Highest risk item in the migration: most nodes, most credentials, and it emails
  founders.

### DA Daily Email Sender
12 nodes, active, last updated 2026-08-20. Runs at 9am, reads the Submissions Log,
sends the scheduling email at 5 days and the decline email at 7 days, writes status
back to the sheet, posts a summary to `#da-deal-flow`.

- Credentials: Google Sheets, Gmail (District Angels Team Email)
- Trigger: schedule, hour 9 — **instance timezone dependent**. Set `GENERIC_TIMEZONE`
  on the self-hosted box or this fires at the wrong hour.
- ⚠️ The `Slack Daily Summary` node has a Slack bot token hardcoded in an
  Authorization header instead of using the Slack credential. Rotate that token during
  the migration and move it into the Slack OAuth2 credential, the way
  `DA Slack Pass Handler` already does it.
- ⚠️ Never active on both instances at once. Founders get duplicate emails.

### DA Slack Pass Handler
9 nodes, active. Webhook at `/webhook/da-pass` handling the Pass and Engage buttons
from the deal alerts; updates the sheet and posts a threaded confirmation.

- Credentials: Google Sheets, Slack OAuth2
- Trigger: POST webhook, path `da-pass`. The Slack app's Interactivity Request URL
  points at the cloud host and must be updated, which is a one-way switch: the buttons
  route to whichever instance the Slack app names.

## Inactive workflows — migrate as-is, nothing external to repoint

- **DA Review Backlog → Slack** (4 nodes) — manual-trigger backfill posting
  `screening_result=review` rows to `#da-deal-flow`. Useful as the first migration
  smoke test: manual trigger, uses the Sheets and Slack credentials, sends nothing to
  founders.
- **District Angels Auto-Draft Email Replies from Unread Threads**
- **Weekly Slack Update Thread Scheduler with Google Sheets Logging**
- **Naviya's Intelligent Email Triage and Daily Digest**
- **Email Action Item Extraction and Contact Connector**
- **Daily Gmail Intelligence Digest and Action Items**
- **Chat with the news**

The last six are March experiments that have never run (trigger count 0). They migrate
for free, so the script takes them along, but they are not worth blocking the cutover
over. `--only` skips them if you would rather leave them behind.

## Credentials

| Credential | Type | Notes |
| --- | --- | --- |
| Google Sheets OAuth2 API | googleSheetsOAuth2Api | Used by 4 workflows |
| Google Docs OAuth2 API | googleDocsOAuth2Api | Intake pipeline |
| Google Drive OAuth2 API | googleDriveOAuth2Api | Intake pipeline |
| District Angels Team Email | gmailOAuth2 | Sends the founder-facing email |
| Gmail account | gmailOAuth2 | Investor welcome |
| Gmail account 2 | gmailOAuth2 | Older workflows |
| Slack OAuth2 API | slackOAuth2Api | Pass handler, review alerts |
| Tally account | tallyApi | Intake trigger |
| Supabase account | supabaseApi | Not referenced by any active workflow |
| Notion account / Notion account 2 | notionApi | Notion account 2 lives in Kj's personal project, not the team one, so it migrates separately |
| n8n free OpenAI API credits | openAiApi | n8n Cloud managed. **Does not exist off cloud** — needs a real key |

## Shared external state

Every deal-flow workflow reads and writes the same Google Sheet
(`1RQ8ZCYVNrFEvSWigBBuwIbAlUpMAPtR1j2okaw6SiRo`, "DA Tally<>n8n submissions log", tab
`Submissions Log`). Both instances would write to the same rows, which is the reason
the cutover is deactivate-then-activate rather than run-both-and-compare.
