/**
 * ChannelObserver — emits channel.*.message events into the mesh.
 *
 * Wraps the ChannelRouter as an Observer so channel messages
 * flow through the standard Observer → EventBus → GoalEngine pipeline.
 */

import type { Observer, ObserverContext } from "@openmesh/core";
import type { ChannelRouter } from "./router.js";

export class ChannelObserver implements Observer {
  readonly id = "channels";
  readonly name = "Multi-Channel Observer";
  readonly events = ["channel.*.message"];

  constructor(private router: ChannelRouter) {}

  async watch(ctx: ObserverContext): Promise<void> {
    // ChannelRouter already emits into the bus when connectBus() is called.
    // This observer starts/stops the channel adapters as part of the mesh lifecycle.
    this.router.connectBus({
      emit: async (event: import("@openmesh/core").ObservationEvent) => {
        await ctx.emit(event);
      },
      on: () => () => {},
      clear: () => {},
    } as never);

    await this.router.startAll();

    // Wait for shutdown signal
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    await this.router.stopAll();
  }

  async dispose(): Promise<void> {
    await this.router.stopAll();
  }
}

/** Convenience factory */
export function createChannelObserver(router: ChannelRouter): ChannelObserver {
  return new ChannelObserver(router);
}
