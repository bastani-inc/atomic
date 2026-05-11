/**
 * Unit tests — integrations/subagents.ts
 */
import { test, expect, describe } from "bun:test";
import {
  injectWorkflowEnv,
  readWorkflowEnv,
  emitStageStart,
  emitStageEnd,
  isSubagentsPresent,
  assertSubagentsPresent,
} from "../../src/integrations/subagents.js";

describe("injectWorkflowEnv", () => {
  test("returns correct env vars", () => {
    const env = injectWorkflowEnv("run-abc", "stage-xyz");
    expect(env.PI_WORKFLOW_RUN_ID).toBe("run-abc");
    expect(env.PI_WORKFLOW_STAGE_ID).toBe("stage-xyz");
  });

  test("returns plain object (no extra keys)", () => {
    const env = injectWorkflowEnv("r1", "s1");
    expect(Object.keys(env).sort()).toEqual(["PI_WORKFLOW_RUN_ID", "PI_WORKFLOW_STAGE_ID"]);
  });
});

describe("readWorkflowEnv", () => {
  test("returns undefined values when env vars not set", () => {
    const origRun = process.env["PI_WORKFLOW_RUN_ID"];
    const origStage = process.env["PI_WORKFLOW_STAGE_ID"];
    delete process.env["PI_WORKFLOW_RUN_ID"];
    delete process.env["PI_WORKFLOW_STAGE_ID"];
    const env = readWorkflowEnv();
    expect(env.PI_WORKFLOW_RUN_ID).toBeUndefined();
    expect(env.PI_WORKFLOW_STAGE_ID).toBeUndefined();
    if (origRun !== undefined) process.env["PI_WORKFLOW_RUN_ID"] = origRun;
    if (origStage !== undefined) process.env["PI_WORKFLOW_STAGE_ID"] = origStage;
  });

  test("reads env vars when set", () => {
    process.env["PI_WORKFLOW_RUN_ID"] = "run-test";
    process.env["PI_WORKFLOW_STAGE_ID"] = "stage-test";
    const env = readWorkflowEnv();
    expect(env.PI_WORKFLOW_RUN_ID).toBe("run-test");
    expect(env.PI_WORKFLOW_STAGE_ID).toBe("stage-test");
    delete process.env["PI_WORKFLOW_RUN_ID"];
    delete process.env["PI_WORKFLOW_STAGE_ID"];
  });
});

describe("emitStageStart", () => {
  test("calls pi.events.emit with workflow.stage.start", () => {
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const pi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
      },
    };
    emitStageStart(pi, { runId: "r1", stageId: "s1", stageName: "scout", startedAt: 1000 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("workflow.stage.start");
    expect(emitted[0].payload).toMatchObject({ runId: "r1", stageId: "s1", stageName: "scout" });
  });

  test("no-op when pi.events absent", () => {
    expect(() => emitStageStart({}, { runId: "r", stageId: "s", stageName: "n", startedAt: 0 })).not.toThrow();
  });
});

describe("emitStageEnd", () => {
  test("calls pi.events.emit with workflow.stage.end", () => {
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const pi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
      },
    };
    emitStageEnd(pi, { runId: "r1", stageId: "s1", stageName: "scout", status: "completed", endedAt: 2000, durationMs: 1000 });
    expect(emitted[0].event).toBe("workflow.stage.end");
    expect(emitted[0].payload).toMatchObject({ status: "completed", durationMs: 1000 });
  });

  test("no-op when pi.events absent", () => {
    expect(() => emitStageEnd({}, { runId: "r", stageId: "s", stageName: "n", status: "failed", endedAt: 0 })).not.toThrow();
  });
});

describe("isSubagentsPresent", () => {
  test("returns false when subagents undefined", () => {
    expect(isSubagentsPresent({})).toBe(false);
  });

  test("returns true when subagents object present", () => {
    expect(isSubagentsPresent({ subagents: {} })).toBe(true);
  });

  test("returns false when subagents null", () => {
    expect(isSubagentsPresent({ subagents: null })).toBe(false);
  });
});

describe("assertSubagentsPresent", () => {
  test("throws with actionable message when absent", () => {
    expect(() => assertSubagentsPresent({})).toThrow(
      "pi-workflows: subagent delegation requires pi-subagents — install npm:pi-subagents and restart pi.",
    );
  });

  test("does not throw when present", () => {
    expect(() => assertSubagentsPresent({ subagents: {} })).not.toThrow();
  });
});
