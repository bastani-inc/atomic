import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { mockSession } from "./executor-shared.js";

type SessionShutdownHandler = (event: { readonly reason: string }) => unknown;

function captureSessionShutdown(): SessionShutdownHandler {
  let shutdown: SessionShutdownHandler | undefined;
  const pi: ExtensionAPI = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    on: (event, handler) => {
      if (event === "session_shutdown") shutdown = handler as SessionShutdownHandler;
    },
    disableAsyncDiscovery: true,
  };
  factory(pi);
  assert.notEqual(shutdown, undefined);
  return shutdown!;
}

afterEach(() => stageControlRegistry.clear());

test("every non-quit session shutdown invalidates a post-mortem prompt whose session creation is pending", async () => {
  for (const reason of ["new", "resume", "fork", "reload"] as const) {
    stageControlRegistry.clear();
    const root = mkdtempSync(join(tmpdir(), "atomic-shutdown-postmortem-"));
    try {
      const sessionFile = join(root, `${reason}.jsonl`);
      writeFileSync(sessionFile, [
        JSON.stringify({
          type: "session",
          version: 3,
          id: `${reason}-session`,
          timestamp: new Date().toISOString(),
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: `${reason}-message`,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Original stage request" },
        }),
      ].join("\n") + "\n");
      const creationStarted = Promise.withResolvers<void>();
      const created = Promise.withResolvers<StageSessionRuntime>();
      let disposeCalls = 0;
      let promptCalls = 0;
      const result = ensurePostMortemStageHandle("run-1", {
        id: "stage-1",
        name: "completed-stage",
        status: "completed",
        parentIds: [],
        toolEvents: [],
        sessionFile,
      }, {
        registry: stageControlRegistry,
        cwd: root,
        adapters: {
          agentSession: {
            async create() {
              creationStarted.resolve();
              return created.promise;
            },
          },
        },
      });
      assert.equal(result.ok, true);
      if (!result.ok) continue;

      const submittedPrompt = result.handle.prompt("must not cross the host-session boundary");
      await creationStarted.promise;
      await Promise.resolve(captureSessionShutdown()({ reason }));
      created.resolve({
        ...mockSession(),
        sessionFile,
        async prompt() { promptCalls += 1; },
        dispose() { disposeCalls += 1; },
      });

      await assert.rejects(submittedPrompt, /session has been disposed/);
      assert.equal(promptCalls, 0);
      assert.equal(disposeCalls, 1);
      assert.equal(result.handle.isDisposed, true);
      assert.equal(stageControlRegistry.get("run-1", "stage-1"), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
