import * as restate from "@restatedev/restate-sdk";

/**
 * Every scenario passes a unique tag so the driver can find "its" child invocation.
 * `delayMs` makes the parent's one-way send a delayed send.
 */
export type Input = { tag: string; delayMs?: number };

/**
 * The endpoint runs in the same Node process as the driver (src/repro.ts). A running child hands
 * the id of the awakeable it is blocked on to the driver through this map, so the driver can
 * release it later. Releasing it lets a surviving child run to a successful completion, which
 * is a positive, terminal observation instead of "still running after some time".
 */
export const childAwakeables = new Map<string, string>();

/** Blocks until the driver resolves its awakeable, then completes successfully. */
export const child = restate.service({
  name: "child",
  handlers: {
    run: async (ctx: restate.Context, input: Input): Promise<string> => {
      const { id, promise } = ctx.awakeable<string>();
      childAwakeables.set(input.tag, id);
      await promise;
      return "child completed";
    },
  },
});

/** Sends the child one way and returns right away. The parent calls it request-response. */
export const relay = restate.service({
  name: "relay",
  handlers: {
    run: async (ctx: restate.Context, input: Input): Promise<string> => {
      ctx.serviceSendClient(child).run(input);
      return "relay returned";
    },
  },
});

/** Never resolved: keeps an invocation running until the driver ends it. */
async function blockForever(ctx: restate.Context): Promise<never> {
  await ctx.awakeable<void>().promise;
  throw new restate.TerminalError("unreachable: nobody resolves this awakeable");
}

export const parent = restate.service({
  name: "parent",
  handlers: {
    /** One-way send (optionally delayed) of child.run, then block. */
    run: async (ctx: restate.Context, input: Input): Promise<string> => {
      if (input.delayMs === undefined) {
        ctx.serviceSendClient(child).run(input);
      } else {
        ctx.serviceSendClient(child).run(input, restate.rpc.sendOpts({ delay: input.delayMs }));
      }
      return blockForever(ctx);
    },
    /** Request-response call to relay.run (which sends the child and returns), then block. */
    runViaRelay: async (ctx: restate.Context, input: Input): Promise<string> => {
      await ctx.serviceClient(relay).run(input);
      return blockForever(ctx);
    },
  },
});

/**
 * One-way send of child.run, then fail with a retryable error until Restate gives up and kills
 * the invocation because of the `onMaxAttempts: "kill"` retry policy. No operator is involved.
 */
export const exhaustingParent = restate.service({
  name: "exhaustingParent",
  options: {
    retryPolicy: { maxAttempts: 3, initialInterval: 100, onMaxAttempts: "kill" },
  },
  handlers: {
    run: async (ctx: restate.Context, input: Input): Promise<string> => {
      ctx.serviceSendClient(child).run(input);
      throw new Error("retryable failure until the retry policy kills this invocation");
    },
  },
});
