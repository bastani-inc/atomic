/**
 * Verify the `pi.on("input", …)` interceptor:
 *   1. Registers a handler under the `"input"` event.
 *   2. For `/workflow …` text, dispatches the
 *      registered command handler directly and returns
 *      `{ action: "handled" }` — short-circuiting pi's
 *      `startPendingSubmission` flow that otherwise echoes the message
 *      into chat scrollback AND starts the `Working… (Esc to interrupt)`
 *      loader before `session.prompt` runs. The shape matches pi's
 *      `InputEventResult` discriminated union; `{ handled: true }` is
 *      silently ignored by the runner.
 *   3. For anything else (regular chat, unknown slash command), passes
 *      through without short-circuiting so the host can run its normal
 *      submission flow.
 *
 * cross-ref:
 *   - src/extension/index.ts  `installInputInterceptor`
 *   - pi packages/coding-agent/src/modes/controllers/input-controller.ts
 *     `setupEditorSubmitHandler`
 *   - pi packages/coding-agent/src/extensibility/extensions/runner.ts
 *     `emitInput`
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import factory from "../../packages/workflows/src/extension/index.js";
import type {
  ExtensionAPI,
  PiCommandContext,
  PiCommandOptions,
} from "../../packages/workflows/src/extension/index.js";

type EventHandler = (
  event?: unknown,
  ctx?: PiCommandContext,
) => Promise<unknown> | unknown;

interface CapturedHandlerCall {
  name: string;
  args: string;
}

interface MockSurface {
  pi: ExtensionAPI;
  events: Map<string, EventHandler[]>;
  /** Recorded invocations of registered command handlers. */
  commandCalls: CapturedHandlerCall[];
}

/**
 * Build a minimal mock `ExtensionAPI`. The trick is to wrap each command
 * handler with a spy at `registerCommand` time so the interceptor's
 * dispatch lands in `commandCalls`. We intentionally make the spy a
 * no-op past the recording — it must NOT call `options.handler` directly
 * because the registry will end up storing the same spy and we'd
 * recurse infinitely (the spy is now `options.handler`).
 */
function buildMock(): MockSurface {
  const events = new Map<string, EventHandler[]>();
  const commandCalls: CapturedHandlerCall[] = [];

  const pi: ExtensionAPI = {
    registerTool: () => undefined,
    registerCommand: (name, options) => {
      // Replace the handler in-place with a record-only spy. The
      // registry (populated AFTER this mutation by
      // `registerWorkflowCommand`) sees the spy, so the interceptor
      // dispatches into our recording layer. We deliberately do NOT
      // forward to the original handler — the test only needs to
      // verify dispatch happened, not the side effects of the
      // underlying workflow command (which has its own dedicated
      // coverage).
      const spy: PiCommandOptions["handler"] = async (args, _ctx) => {
        commandCalls.push({ name, args });
      };
      options.handler = spy;
    },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    on: (event, handler) => {
      const handlers = events.get(event) ?? [];
      handlers.push(handler as EventHandler);
      events.set(event, handlers);
    },
    disableAsyncDiscovery: true,
  };

  return { pi, events, commandCalls };
}

describe('installInputInterceptor — pi.on("input") wiring', () => {
  test("registers a single `input` handler", () => {
    const { pi, events } = buildMock();
    factory(pi);
    const handlers = events.get("input") ?? [];
    assert.equal(
      handlers.length,
      1,
      "exactly one input handler must be registered",
    );
  });

  test("/workflow text short-circuits with { action: 'handled' } and dispatches the registered handler", async () => {
    const { pi, events, commandCalls } = buildMock();
    factory(pi);

    const handler = (events.get("input") ?? [])[0];
    assert.ok(handler, "input handler must be registered");

    const ctx: PiCommandContext = { ui: { notify: () => undefined } };
    const result = await handler(
      { text: "/workflow list", source: "interactive" },
      ctx,
    );

    assert.deepEqual(
      result,
      { action: "handled" },
      "must short-circuit the host submit pipeline using pi's InputEventResult shape",
    );
    assert.equal(
      commandCalls.length,
      1,
      "must dispatch the workflow command handler exactly once",
    );
    assert.equal(commandCalls[0]!.name, "workflow");
    assert.equal(commandCalls[0]!.args, "list");
  });

  test("regular chat text falls through (returns undefined, no command dispatched)", async () => {
    const { pi, events, commandCalls } = buildMock();
    factory(pi);

    const handler = (events.get("input") ?? [])[0]!;
    const ctx: PiCommandContext = { ui: { notify: () => undefined } };

    const result = await handler(
      { text: "hello world, please help", source: "interactive" },
      ctx,
    );

    assert.equal(
      result,
      undefined,
      "must not short-circuit regular chat input",
    );
    assert.equal(
      commandCalls.length,
      0,
      "must not invoke any workflow command",
    );
  });

  test("unknown slash command falls through (returns undefined)", async () => {
    const { pi, events, commandCalls } = buildMock();
    factory(pi);

    const handler = (events.get("input") ?? [])[0]!;
    const ctx: PiCommandContext = { ui: { notify: () => undefined } };

    const result = await handler(
      { text: "/somebody-elses-command foo", source: "interactive" },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(commandCalls.length, 0);
  });

  test("non-string `text` payload falls through without throwing", async () => {
    const { pi, events, commandCalls } = buildMock();
    factory(pi);

    const handler = (events.get("input") ?? [])[0]!;
    const ctx: PiCommandContext = { ui: { notify: () => undefined } };

    const result = await handler(
      { text: undefined, source: "interactive" },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(commandCalls.length, 0);
  });

  test("handler exception is swallowed and surfaced via ctx.ui.notify('error')", async () => {
    const errors: Array<{ msg: string; type?: string }> = [];
    const ctx: PiCommandContext = {
      ui: {
        notify: (msg, type) => {
          errors.push({ msg, type });
        },
      },
    };

    // Build a fresh mock whose `registerCommand` replaces the workflow
    // handler with one that throws, so the interceptor's dispatch
    // exercises its catch block.
    const events = new Map<string, EventHandler[]>();
    const throwingPi: ExtensionAPI = {
      registerTool: () => undefined,
      registerCommand: (name, options) => {
        options.handler = async () => {
          throw new Error(`boom in /${name}`);
        };
      },
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      registerShortcut: () => undefined,
      on: (event, h) => {
        const arr = events.get(event) ?? [];
        arr.push(h as EventHandler);
        events.set(event, arr);
      },
      disableAsyncDiscovery: true,
    };
    factory(throwingPi);
    const throwingHandler = (events.get("input") ?? [])[0]!;

    const result = await throwingHandler(
      { text: "/workflow list", source: "interactive" },
      ctx,
    );

    // Interceptor must still resolve with action:"handled" so the host
    // does not fall back to the streaming submit path.
    assert.deepEqual(result, { action: "handled" });
    const errorEntry = errors.find((e) => e.type === "error");
    assert.ok(errorEntry, "error must be surfaced via ctx.ui.notify");
    assert.match(errorEntry!.msg, /\/workflow failed: boom in \/workflow/);
  });
});
