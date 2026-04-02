import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelRouter, type Channel, type ChannelMessage, type InteractiveMessage } from "../router.js";
import { ActionManager } from "../actions.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockChannel(id = "test"): Channel {
  return {
    id,
    name: id,
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function buildRouter(channelId = "test"): { router: ChannelRouter; channel: Channel } {
  const router = new ChannelRouter();
  const channel = createMockChannel(channelId);
  router.addChannel(channel);
  return { router, channel };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ActionManager", () => {
  let router: ChannelRouter;
  let channel: Channel;
  let manager: ActionManager;

  beforeEach(() => {
    ({ router, channel } = buildRouter());
    manager = new ActionManager(router);
  });

  // ── sendInteractive ────────────────────────────────────────────────

  it("sends an interactive message with buttons", async () => {
    await manager.sendInteractive({
      channel: "test",
      sender: "bot",
      text: "Pick one",
      callbackId: "cb-1",
      actions: [
        { type: "button", id: "btn-a", label: "Option A", value: "a" },
        { type: "button", id: "btn-b", label: "Option B", value: "b", style: "danger" },
      ],
    });

    expect(channel.send).toHaveBeenCalledOnce();
    const sent = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as InteractiveMessage;
    expect(sent.text).toBe("Pick one");
    expect(sent.callbackId).toBe("cb-1");
    expect(sent.actions).toHaveLength(2);
    expect(sent.id).toBeDefined();
    expect(sent.timestamp).toBeDefined();
  });

  it("sends an interactive message with select options", async () => {
    await manager.sendInteractive({
      channel: "test",
      sender: "bot",
      text: "Choose env",
      callbackId: "cb-sel",
      actions: [
        {
          type: "select",
          id: "env-select",
          label: "Environment",
          options: [
            { label: "Production", value: "prod" },
            { label: "Staging", value: "staging" },
          ],
        },
      ],
    });

    const sent = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as InteractiveMessage;
    expect(sent.actions![0]!.type).toBe("select");
    expect(sent.actions![0]!.options).toHaveLength(2);
  });

  // ── onAction / handleActionResponse ────────────────────────────────

  it("dispatches action response to registered handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    manager.onAction("cb-1", handler);

    await manager.handleActionResponse({
      callbackId: "cb-1",
      actionId: "btn-a",
      value: "a",
      userId: "user-1",
      channelId: "test",
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatchObject({ callbackId: "cb-1", value: "a" });
  });

  it("ignores unknown callbackId gracefully", async () => {
    // Should not throw
    await manager.handleActionResponse({
      callbackId: "nonexistent",
      actionId: "x",
      value: "y",
      userId: "u",
      channelId: "test",
      timestamp: new Date().toISOString(),
    });
  });

  it("removes callback handler with offAction", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    manager.onAction("cb-off", handler);
    manager.offAction("cb-off");

    await manager.handleActionResponse({
      callbackId: "cb-off",
      actionId: "x",
      value: "y",
      userId: "u",
      channelId: "test",
      timestamp: new Date().toISOString(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  // ── requestApproval — approved ─────────────────────────────────────

  it("resolves approval with approved=true when approve value is received", async () => {
    const approvalPromise = manager.requestApproval({
      id: "apr-1",
      title: "Deploy to prod",
      description: "Release v2.0",
      requestedBy: "dev-1",
      channel: "test",
      actions: [
        { type: "approval", id: "approve", label: "Approve", value: "approve", style: "primary" },
        { type: "approval", id: "deny", label: "Deny", value: "deny", style: "danger" },
      ],
    });

    // Simulate user clicking "Approve"
    await manager.handleActionResponse({
      callbackId: "apr-1",
      actionId: "approve",
      value: "approve",
      userId: "mgr-1",
      channelId: "test",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const result = await approvalPromise;
    expect(result.approved).toBe(true);
    expect(result.requestId).toBe("apr-1");
    expect(result.respondedBy).toBe("mgr-1");
  });

  // ── requestApproval — denied ───────────────────────────────────────

  it("resolves approval with approved=false when deny value is received", async () => {
    const approvalPromise = manager.requestApproval({
      id: "apr-2",
      title: "Delete database",
      description: "Drop all tables",
      requestedBy: "dev-1",
      channel: "test",
      actions: [
        { type: "approval", id: "approve", label: "Approve", value: "approve" },
        { type: "approval", id: "deny", label: "Deny", value: "deny" },
      ],
    });

    await manager.handleActionResponse({
      callbackId: "apr-2",
      actionId: "deny",
      value: "deny",
      userId: "mgr-2",
      channelId: "test",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.respondedBy).toBe("mgr-2");
  });

  // ── requestApproval — timeout ──────────────────────────────────────

  it("rejects approval after timeout", async () => {
    vi.useFakeTimers();

    const approvalPromise = manager.requestApproval({
      id: "apr-timeout",
      title: "Slow approval",
      description: "Will time out",
      requestedBy: "dev-1",
      channel: "test",
      actions: [
        { type: "approval", id: "approve", label: "Approve", value: "approve" },
      ],
      timeout: 5000,
    });

    vi.advanceTimersByTime(5001);

    await expect(approvalPromise).rejects.toThrow("timed out");

    vi.useRealTimers();
  });

  // ── getPendingApprovals ────────────────────────────────────────────

  it("lists pending approvals", async () => {
    // Start two approvals (don't await — they're pending)
    const p1 = manager.requestApproval({
      id: "pa-1",
      title: "First",
      description: "d1",
      requestedBy: "dev",
      channel: "test",
      actions: [{ type: "approval", id: "approve", label: "Approve", value: "approve" }],
    });
    const p2 = manager.requestApproval({
      id: "pa-2",
      title: "Second",
      description: "d2",
      requestedBy: "dev",
      channel: "test",
      actions: [{ type: "approval", id: "approve", label: "Approve", value: "approve" }],
    });

    const pending = manager.getPendingApprovals();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.id)).toContain("pa-1");
    expect(pending.map((p) => p.id)).toContain("pa-2");

    // Resolve both to avoid dangling promises
    await manager.handleActionResponse({
      callbackId: "pa-1", actionId: "approve", value: "approve",
      userId: "u", channelId: "test", timestamp: new Date().toISOString(),
    });
    await manager.handleActionResponse({
      callbackId: "pa-2", actionId: "approve", value: "approve",
      userId: "u", channelId: "test", timestamp: new Date().toISOString(),
    });
    await Promise.all([p1, p2]);
  });

  it("removes approval from pending list after resolution", async () => {
    const p = manager.requestApproval({
      id: "pa-done",
      title: "Done",
      description: "d",
      requestedBy: "dev",
      channel: "test",
      actions: [{ type: "approval", id: "approve", label: "Approve", value: "approve" }],
    });

    expect(manager.getPendingApprovals()).toHaveLength(1);

    await manager.handleActionResponse({
      callbackId: "pa-done", actionId: "approve", value: "approve",
      userId: "u", channelId: "test", timestamp: new Date().toISOString(),
    });
    await p;

    expect(manager.getPendingApprovals()).toHaveLength(0);
  });

  // ── cancelApproval ─────────────────────────────────────────────────

  it("cancels a pending approval", async () => {
    const approvalPromise = manager.requestApproval({
      id: "apr-cancel",
      title: "Will cancel",
      description: "desc",
      requestedBy: "dev",
      channel: "test",
      actions: [{ type: "approval", id: "approve", label: "Approve", value: "approve" }],
    });

    manager.cancelApproval("apr-cancel");

    await expect(approvalPromise).rejects.toThrow("cancelled");
    expect(manager.getPendingApprovals()).toHaveLength(0);
  });

  it("cancelApproval is a no-op for unknown request IDs", () => {
    // Should not throw
    manager.cancelApproval("nonexistent");
  });

  // ── ChannelRouter.getActionManager ─────────────────────────────────

  it("router.getActionManager() returns an ActionManager", async () => {
    const am = await router.getActionManager();
    expect(am).toBeInstanceOf(ActionManager);
  });

  it("router.getActionManager() returns the same instance on repeated calls", async () => {
    const am1 = await router.getActionManager();
    const am2 = await router.getActionManager();
    expect(am1).toBe(am2);
  });

  // ── ChannelRouter.sendInteractive ──────────────────────────────────

  it("router.sendInteractive() delegates to the channel adapter", async () => {
    await router.sendInteractive({
      channel: "test",
      sender: "bot",
      text: "interactive via router",
      actions: [{ type: "button", id: "b1", label: "Go", value: "go" }],
    });

    expect(channel.send).toHaveBeenCalledOnce();
    const sent = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ChannelMessage;
    expect(sent.text).toBe("interactive via router");
  });

  it("router.sendInteractive() throws for unknown channel", async () => {
    await expect(
      router.sendInteractive({ channel: "nope", sender: "x", text: "x" }),
    ).rejects.toThrow("Unknown channel: nope");
  });
});
