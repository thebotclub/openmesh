import { defineOperator } from "@openmesh/sdk";

/**
 * Comms Operator — sends notifications to humans.
 *
 * V1: prints to stdout in a structured format.
 * Future: Slack API, email, PagerDuty, webhook.
 */
export default defineOperator({
  id: "comms",
  name: "Communications Operator",
  description: "Sends notifications via Slack, email, PagerDuty, webhooks",
  async execute(ctx) {
    ctx.log(`📢 NOTIFICATION: ${ctx.task}`);

    // V1: structured console output (could be piped to a webhook)
    const notification = {
      type: "notification",
      timestamp: new Date().toISOString(),
      message: ctx.task,
      event: ctx.event,
    };

    console.log("\n" + "=".repeat(60));
    console.log("📢 OPENMESH NOTIFICATION");
    console.log("=".repeat(60));
    console.log(ctx.task);
    console.log("=".repeat(60) + "\n");

    return {
      status: "success" as const,
      summary: `Notification sent: ${ctx.task.slice(0, 100)}`,
      data: notification,
    };
  },
});
