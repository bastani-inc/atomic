import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { postMortemDepsForRun } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionCreateOptions } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { mockSession } from "./executor-shared.js";

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "atomic-nested-postmortem-"));
  stageControlRegistry.clear();
  store.clear();
});

afterEach(() => {
  stageControlRegistry.clear();
  store.clear();
  setDurableBackend(undefined);
  rmSync(tempRoot, { recursive: true, force: true });
});

test("nested post-mortem chat reopens in the durable root cwd while retaining child ownership", async () => {
  for (const durableCwdField of ["workflowCwd", "invocationCwd"] as const) {
    stageControlRegistry.clear();
    store.clear();
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const durableCwd = join(tempRoot, durableCwdField);
    backend.registerWorkflow({
      workflowId: "root-run",
      rootWorkflowId: "root-run",
      name: "root-workflow",
      inputs: {},
      createdAt: 1,
      status: "completed",
      invocationCwd: durableCwdField === "invocationCwd" ? durableCwd : join(tempRoot, "invocation"),
      ...(durableCwdField === "workflowCwd" ? { workflowCwd: durableCwd } : {}),
    });
    assert.equal(backend.getWorkflow("child-run"), undefined);

    const sessionFile = join(tempRoot, `${durableCwdField}.jsonl`);
    writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: `${durableCwdField}-session`,
        timestamp: new Date().toISOString(),
        cwd: durableCwd,
      }),
      JSON.stringify({
        type: "message",
        id: `${durableCwdField}-message`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Original stage request" },
      }),
    ].join("\n") + "\n");
    const stage = {
      id: "duplicate-stage-id",
      name: "nested-completed-stage",
      status: "completed" as const,
      parentIds: [],
      toolEvents: [],
      sessionFile,
    };
    store.recordRunStart({
      id: "child-run",
      name: "nested-workflow",
      inputs: {},
      status: "completed",
      stages: [stage],
      startedAt: 2,
      endedAt: 3,
      parentRunId: "root-run",
      parentStageId: "nested-call",
      rootRunId: "root-run",
    });

    let createOptions: StageSessionCreateOptions | undefined;
    const deps = postMortemDepsForRun("child-run", {
      adapters: {
        agentSession: {
          async create(options) {
            createOptions = options;
            return { ...mockSession(), sessionFile };
          },
        },
      },
      resolveDefaultStageSessionDir: () => undefined,
    });
    assert.equal(deps.cwd, durableCwd);
    assert.notEqual(deps.cwd, process.cwd());

    const result = ensurePostMortemStageHandle("child-run", stage, deps);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    await result.handle.ensureAttached();

    assert.equal(createOptions?.cwd, durableCwd);
    assert.equal(stageControlRegistry.get("child-run", "duplicate-stage-id"), result.handle);
    assert.equal(stageControlRegistry.get("root-run", "duplicate-stage-id"), undefined);
  }
});
