/**
 * ActionManager — handles interactive message actions and approval workflows.
 *
 * Manages callback handlers for button clicks, select menus, and approval
 * requests. Works with the ChannelRouter to send interactive messages and
 * resolve approval promises when responses arrive.
 */

import type {
  ChannelRouter,
  InteractiveMessage,
  ActionResponse,
  ApprovalRequest,
  ApprovalResult,
} from "./router.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ActionManager {
  private handlers = new Map<string, (response: ActionResponse) => Promise<void>>();
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(private router: ChannelRouter) {}

  /** Register a callback handler for action responses */
  onAction(callbackId: string, handler: (response: ActionResponse) => Promise<void>): void {
    this.handlers.set(callbackId, handler);
  }

  /** Remove a callback handler */
  offAction(callbackId: string): void {
    this.handlers.delete(callbackId);
  }

  /** Send a message with interactive actions */
  async sendInteractive(message: Omit<InteractiveMessage, "id" | "timestamp">): Promise<void> {
    await this.router.sendInteractive(message);
  }

  /** Send an approval request and wait for a response (with optional timeout) */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const callbackId = request.id;

    // Register the pending approval and handler BEFORE sending, so they're
    // visible immediately to callers that inspect state synchronously.
    const resultPromise = new Promise<ApprovalResult>((resolve, reject) => {
      const pending: PendingApproval = { request, resolve, reject };

      if (request.timeout && request.timeout > 0) {
        pending.timer = setTimeout(() => {
          this.pendingApprovals.delete(callbackId);
          this.handlers.delete(callbackId);
          reject(new Error(`Approval request "${request.id}" timed out`));
        }, request.timeout);
      }

      this.pendingApprovals.set(callbackId, pending);

      this.handlers.set(callbackId, async (response: ActionResponse) => {
        const entry = this.pendingApprovals.get(callbackId);
        if (!entry) return;

        if (entry.timer) clearTimeout(entry.timer);
        this.pendingApprovals.delete(callbackId);
        this.handlers.delete(callbackId);

        entry.resolve({
          requestId: request.id,
          approved: response.value === "approve",
          respondedBy: response.userId,
          timestamp: response.timestamp,
          metadata: request.metadata,
        });
      });
    });

    // Build and send the interactive message
    const message: Omit<InteractiveMessage, "id" | "timestamp"> = {
      channel: request.channel,
      sender: "openmesh",
      text: `**${request.title}**\n${request.description}\n\n_Requested by ${request.requestedBy}_`,
      callbackId,
      actions: request.actions,
      metadata: request.metadata,
    };

    await this.router.sendInteractive(message);

    return resultPromise;
  }

  /** Handle an incoming action response (called by adapters / webhooks) */
  async handleActionResponse(response: ActionResponse): Promise<void> {
    const handler = this.handlers.get(response.callbackId);
    if (!handler) return; // Unknown callbackId — ignore gracefully
    await handler(response);
  }

  /** List all pending approval requests */
  getPendingApprovals(): ApprovalRequest[] {
    return [...this.pendingApprovals.values()].map((p) => p.request);
  }

  /** Cancel a pending approval (rejects the promise) */
  cancelApproval(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;

    if (pending.timer) clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);
    this.handlers.delete(requestId);
    pending.reject(new Error(`Approval request "${requestId}" was cancelled`));
  }
}
