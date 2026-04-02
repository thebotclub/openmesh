/**
 * @openmesh/channels — Multi-channel messaging bridge.
 *
 * Instead of building 25 channel adapters from scratch (à la OpenClaw),
 * we use a pluggable adapter pattern where each channel implements
 * a simple interface. This lets us:
 *
 *   1. Start with lightweight adapters (webhook, Slack, Discord, Telegram)
 *   2. Leverage existing bot libraries (grammy, discord.js, @slack/bolt)
 *   3. Bridge to Matrix for protocol-level multi-channel (mautrix bridges)
 *   4. Add channels incrementally without touching core
 *
 * OpenClaw's lesson: the channel layer is 40% of the codebase. We keep it thin
 * by defining a minimal interface and letting adapter packages do the heavy lifting.
 */

export {
  ChannelRouter,
  type Channel,
  type ChannelMessage,
  type ChannelConfig,
  type MessageAction,
  type InteractiveMessage,
  type ActionResponse,
  type ApprovalRequest,
  type ApprovalResult,
} from "./router.js";
export { ActionManager } from "./actions.js";
export { WebhookChannel } from "./adapters/webhook.js";
export { SlackChannel, type SlackChannelConfig } from "./adapters/slack.js";
export { DiscordChannel, type DiscordChannelConfig } from "./adapters/discord.js";
export { TelegramChannel, type TelegramChannelConfig } from "./adapters/telegram.js";
export { MatrixChannel, type MatrixChannelConfig } from "./adapters/matrix.js";
export { EmailChannel, type EmailChannelConfig } from "./adapters/email.js";
export { PagerDutyChannel, type PagerDutyChannelConfig } from "./adapters/pagerduty.js";
export { ChannelObserver } from "./observer.js";
export { ChannelOperator } from "./operator.js";
