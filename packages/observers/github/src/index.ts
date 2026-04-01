import { defineObserver } from "@openmesh/sdk";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const WEBHOOK_PORT = Number(process.env["OPENMESH_GITHUB_WEBHOOK_PORT"] ?? 0);

export default defineObserver({
  id: "github",
  name: "GitHub Observer",
  events: [
    "github.ci.failed",
    "github.ci.passed",
    "github.pr.opened",
    "github.pr.merged",
    "github.issue.opened",
    "github.push",
  ],

  async watch(ctx) {
    if (!WEBHOOK_PORT) {
      ctx.log("No OPENMESH_GITHUB_WEBHOOK_PORT set. GitHub observer idle.");
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    ctx.log(`Starting GitHub webhook server on port ${WEBHOOK_PORT}`);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString();

      try {
        const payload = JSON.parse(body) as Record<string, unknown>;
        const ghEvent = req.headers["x-github-event"] as string | undefined;

        const events = mapGitHubEvent(ghEvent, payload);
        for (const evt of events) {
          await ctx.emit(evt);
        }

        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        ctx.log(`Webhook parse error: ${err}`);
        res.writeHead(400);
        res.end("Bad Request");
      }
    });

    server.listen(WEBHOOK_PORT, () => {
      ctx.log(`GitHub webhook listening on :${WEBHOOK_PORT}/webhook`);
    });

    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        server.close();
        resolve();
      }, { once: true });
    });
  },
});

function mapGitHubEvent(
  ghEvent: string | undefined,
  payload: Record<string, unknown>,
): Array<{ id: string; type: string; timestamp: string; source: string; payload: Record<string, unknown> }> {
  const base = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: "github",
  };

  const action = payload["action"] as string | undefined;
  const events: Array<typeof base & { type: string; payload: Record<string, unknown> }> = [];

  if (ghEvent === "check_run" || ghEvent === "check_suite" || ghEvent === "workflow_run") {
    const conclusion = (
      (payload["check_run"] as Record<string, unknown> | undefined)?.["conclusion"] ??
      (payload["check_suite"] as Record<string, unknown> | undefined)?.["conclusion"] ??
      (payload["workflow_run"] as Record<string, unknown> | undefined)?.["conclusion"] ??
      action
    ) as string;

    const type = conclusion === "success" ? "github.ci.passed" : "github.ci.failed";
    events.push({ ...base, type, payload });
  } else if (ghEvent === "pull_request") {
    if (action === "opened") {
      events.push({ ...base, type: "github.pr.opened", payload });
    } else if (action === "closed" && (payload["pull_request"] as Record<string, unknown> | undefined)?.["merged"]) {
      events.push({ ...base, type: "github.pr.merged", payload });
    }
  } else if (ghEvent === "issues" && action === "opened") {
    events.push({ ...base, type: "github.issue.opened", payload });
  } else if (ghEvent === "push") {
    events.push({ ...base, type: "github.push", payload });
  }

  return events;
}
