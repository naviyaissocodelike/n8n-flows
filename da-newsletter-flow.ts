import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const N8N_URL = "https://n8n.districtangels.com/";
const SLACK_CHANNEL = "#da-newsletter-flow";
const DRIVE_DOC_NAME = "Newsletter Flow Log";
const WEBHOOK_PATH = "newsletter-flow-trigger";

function getN8nApiKey(): string | undefined {
  try {
    const path = join(process.env.HOME || "/", ".pi", "agent", "n8n.json");
    if (require("fs").existsSync(path)) {
      const data = JSON.parse(require("fs").readFileSync(path, "utf8"));
      return data?.apiKey || data?.key || undefined;
    }
  } catch { /* ignore */ }
  return process.env.N8N_API_KEY || undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("newsletter-check", {
    description: "Check #da-newsletter-flow and append new messages to Drive doc",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const webhookUrl = `${N8N_URL}webhook/${WEBHOOK_PATH}`;
      const apiKey = getN8nApiKey();
      const authNote = apiKey ? "API key configured (~/n8n.json)" : "API KEY MISSING — set in ~/.pi/agent/n8n.json";

      let accountsText = "Drive: googledrive_gnomon-philip | Slack: default";
      try {
        const credPath = join(process.env.HOME || "/", ".composio", "anonymous_user_data.json");
        const data = JSON.parse(readFileSync(credPath, "utf8"));
        if (data?.composio) {
          accountsText = `Composio identity: ${data.slug || data.email || "ready"}`;
        }
      } catch { /* ignore */ }

      const payload = {
        source: "pi-extension",
        command: "newsletter-check",
        slackChannel: SLACK_CHANNEL,
        driveDocName: DRIVE_DOC_NAME,
        accounts: accountsText,
        sessionId: ctx.sessionManager.getSessionFile() || "ephemeral",
        cwd: ctx.cwd,
        timestamp: new Date().toISOString(),
        triggerType: "agent-driven",
        instructions: `Monitor ${SLACK_CHANNEL} for new activity. Append any new messages to the running Google Doc named "${DRIVE_DOC_NAME}".`
      };

      const response = [
        `📡 Newsletter Flow Monitor — Agent-Driven`,
        `📍 Channel: ${SLACK_CHANNEL}`,
        `📄 Drive doc: ${DRIVE_DOC_NAME}`,
        `🌐 n8n webhook: ${webhookUrl}`,
        `🔑 Auth: ${authNote}`,
        `📦 Payload preview: ${JSON.stringify(payload).substring(0, 280)}...`,
        `💡 Note: Triggered webhook. n8n reads Slack → appends to Drive doc (appendOrCreate).`,
        `🔗 Composio: ${accountsText}`
      ].join("\n");

      // Send webhook with Authorization header (apiKey already defined above)
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "Authorization": "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        const status = res.status + " " + res.statusText;
        const responseBody = await res.text().catch(() => "");
        const fullResponse = response + "\n---\nWebhook status: " + status + "\nResponse: " + responseBody.substring(0, 200);
        ctx.ui.notify(fullResponse, "info");
        return { result: fullResponse, action: "triggered-webhook", status, responseBody };
      } catch (e: any) {
        ctx.ui.notify("Webhook failed: " + (e.message || e), "error");
        return { result: "Error: " + (e.message || e), action: "failed" };
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("newsletter", `📨 ${SLACK_CHANNEL} → ${DRIVE_DOC_NAME}`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("newsletter", undefined);
  });
}
