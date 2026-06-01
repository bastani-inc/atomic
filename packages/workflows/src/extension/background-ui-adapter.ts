/**
 * Legacy background workflow HIL adapter — bridges
 * `ctx.ui.input/confirm/select/editor` to run-level store-backed pending
 * prompts instead of pi.ui modal dialogs.
 *
 * Normal detached workflow runs now use executor-owned synthetic prompt nodes
 * backed by `StageSnapshot.pendingPrompt`; this adapter remains for tests and
 * non-executor fallback callers that still need the run-level graph overlay:
 *
 *   1. Stage calls `ctx.ui.editor(prefill)`
 *   2. Adapter records a `PendingPrompt` on the run via the store
 *   3. Adapter awaits resolution (Promise stays pending; chat editor is free)
 *   4. User presses F2 / `/workflow connect <id>` — graph viewer mounts
 *   5. Graph viewer shows the prompt card; user types + submits
 *   6. Graph viewer calls `store.resolvePendingPrompt(runId, promptId, value)`
 *   7. Adapter promise resolves; workflow body continues
 *
 * If the run terminates (kill / abort) before the user responds, the awaiter
 * rejects via `recordRunEnd` so the executor can finalise cleanly — no leaked
 * pending promises.
 *
 * @internal Legacy fallback retained for tests and non-executor callers.
 * TODO(workflows): delete after all tests and fallback entrypoints migrate to
 * executor-owned synthetic prompt nodes.
 *
 * cross-ref:
 *   src/shared/store-types.ts PendingPrompt
 *   src/shared/store.ts recordPendingPrompt / resolvePendingPrompt / awaitPendingPrompt
 *   src/tui/graph-view.ts pending-prompt rendering + key handling
 */

import type { Store } from "../shared/store.js";
import type {
  PendingPrompt,
  PromptKind,
} from "../shared/store-types.js";
import type { WorkflowUIAdapter } from "../shared/types.js";

interface PromptDescriptor {
  readonly kind: PromptKind;
  readonly message: string;
  readonly choices?: readonly string[];
  readonly initial?: string;
}

function nextPromptId(): string {
  // Crypto-strong is overkill here; runId already provides isolation. A short
  // random suffix keeps the id readable in debug logs.
  return `hil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ask(
  store: Store,
  runId: string,
  descriptor: PromptDescriptor,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (signal?.aborted) {
    // Pre-aborted: don't record a prompt that won't be answered. Resolve to
    // a kind-appropriate default so the workflow body unwinds without
    // throwing — the executor's post-body abort check finalises as "killed".
    return Promise.resolve(fallbackForKind(descriptor));
  }
  const prompt: PendingPrompt = {
    id: nextPromptId(),
    kind: descriptor.kind,
    message: descriptor.message,
    ...(descriptor.choices !== undefined ? { choices: descriptor.choices } : {}),
    ...(descriptor.initial !== undefined ? { initial: descriptor.initial } : {}),
    createdAt: Date.now(),
  };
  const accepted = store.recordPendingPrompt(runId, prompt);
  if (!accepted) {
    // Run missing, terminal, or already has a pending prompt. Resolve with a
    // safe default rather than throwing — workflow authors don't need to
    // defensively try/catch every HIL call.
    return Promise.resolve(fallbackForKind(descriptor));
  }
  const waiter = store.awaitPendingPrompt(runId, prompt.id);
  if (!signal) return waiter;
  // Race against abort so kill() doesn't leave the workflow body wedged on
  // a HIL await nobody will answer. We also forward a default response into
  // the store so any concurrent observer sees the prompt cleared.
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = (): void => {
      store.resolvePendingPrompt(runId, prompt.id, fallbackForKind(descriptor));
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("atomic-workflows: HIL aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiter.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function fallbackForKind(descriptor: PromptDescriptor): unknown {
  switch (descriptor.kind) {
    case "input":
    case "editor":
      return descriptor.initial ?? "";
    case "confirm":
      return false;
    case "select":
      return descriptor.choices?.[0] ?? "";
  }
}

/**
 * Build a legacy `WorkflowUIAdapter` whose methods record prompts on `runId`
 * via the store and await user response through the graph viewer overlay.
 *
 * Detached workflow execution normally uses node-local prompt stages instead.
 * `pi.ui.editor`, `pi.ui.confirm`, etc. are still intentionally never invoked
 * from inside a background run. The chat editor stays free; fallback callers
 * attend to run-level prompts via F2 / the `/workflow connect` overlay.
 *
 * `signal` is the run's `AbortController.signal`; when fired (e.g. via
 * `/workflow interrupt <id>`), any HIL waiter rejects so the workflow body
 * unwinds instead of hanging. Pass `undefined` only in tests where you
 * drive resolution directly via `store.resolvePendingPrompt`.
 */
export function buildBackgroundUIAdapter(
  store: Store,
  runId: string,
  signal?: AbortSignal,
): WorkflowUIAdapter {
  return {
    async input(prompt: string): Promise<string> {
      const response = await ask(store, runId, { kind: "input", message: prompt }, signal);
      return typeof response === "string" ? response : String(response ?? "");
    },

    async confirm(message: string): Promise<boolean> {
      const response = await ask(store, runId, { kind: "confirm", message }, signal);
      return response === true;
    },

    async select<T extends string>(
      message: string,
      options: readonly T[],
    ): Promise<T> {
      if (options.length === 0) {
        throw new Error("atomic-workflows: ctx.ui.select requires at least one option");
      }
      const response = await ask(store, runId, {
        kind: "select",
        message,
        choices: options,
      }, signal);
      if (typeof response === "string" && (options as readonly string[]).includes(response)) {
        return response as T;
      }
      return options[0]!;
    },

    async editor(initial?: string): Promise<string> {
      const response = await ask(store, runId, {
        kind: "editor",
        message: "Edit and save to continue.",
        initial,
      }, signal);
      if (typeof response === "string") return response;
      return initial ?? "";
    },
  };
}
