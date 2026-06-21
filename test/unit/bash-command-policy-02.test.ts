// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  createBashToolDefinition,
  type BashOperations,
} from "../../packages/coding-agent/src/core/tools/bash.ts";
import {
  evaluateBashCommandPolicy,
  formatBashCommandPolicyRejection,
  parseBashCommandSegments,
  validateBashCommandPolicy,
  type BashCommandPolicy,
  type BashCommandPolicyDecision,
} from "../../packages/coding-agent/src/core/tools/bash-policy.ts";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionCreateOptions, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

function assertAllowed(decision: BashCommandPolicyDecision): asserts decision is Extract<BashCommandPolicyDecision, { readonly allowed: true }> {
  if (!decision.allowed) {
    assert.fail(decision.rejection.message);
  }
}

function assertDenied(decision: BashCommandPolicyDecision): asserts decision is Extract<BashCommandPolicyDecision, { readonly allowed: false }> {
  if (decision.allowed) {
    assert.fail("expected bash command policy denial");
  }
}

function targetList(command: string): readonly string[] {
  const parsed = parseBashCommandSegments(command);
  if (!parsed.ok) assert.fail(parsed.error.reason);
  return parsed.segments.map((segment) => segment.target);
}

function fakeStageSession(): StageSessionRuntime {
  let lastAssistantText = "";
  return {
    async prompt(text: string): Promise<string> {
      lastAssistantText = `ok:${text}`;
      return lastAssistantText;
    },
    async steer(): Promise<void> {},
    async followUp(): Promise<void> {},
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "session-id",
    async setModel(): Promise<void> {},
    setThinkingLevel(): void {},
    async cycleModel(): ReturnType<StageSessionRuntime["cycleModel"]> {
      return undefined;
    },
    cycleThinkingLevel(): ReturnType<StageSessionRuntime["cycleThinkingLevel"]> {
      return undefined;
    },
    agent: undefined as never,
    model: undefined,
    thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
    messages: [] as StageSessionRuntime["messages"],
    isStreaming: false,
    async navigateTree(): Promise<{ readonly cancelled: boolean }> {
      return { cancelled: true };
    },
    async compact(): ReturnType<StageSessionRuntime["compact"]> {
      return undefined as never;
    },
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    getLastAssistantText(): string | undefined {
      return lastAssistantText;
    },
  };
}

describe("bash command segment parser", () => {
  test("tokenizes pipes, |&, &&, ||, semicolons, and background separators", () => {
    assert.deepEqual(targetList("browse snapshot | grep title && echo ok || pwd; ls & date |& cat"), [
      "browse snapshot",
      "grep title",
      "echo ok",
      "pwd",
      "ls",
      "date",
      "cat",
    ]);
  });

  test("does not split non-leading noclobber redirections as pipes", () => {
    const command = "echo ok >|/tmp/out";
    assert.deepEqual(targetList(command), [command]);

    const decision = evaluateBashCommandPolicy(command, {
      default: "deny",
      allow: [{ prefix: "echo " }],
    });
    assertAllowed(decision);
    assert.equal(decision.targets.length, 1);
    assert.equal(decision.targets[0]?.target, command);
  });

  test("treats unquoted LF, CRLF, and bare CR as command separators", () => {
    const policy = {
      default: "deny",
      allow: [{ prefix: "browse " }],
    } satisfies BashCommandPolicy;

    assert.deepEqual(targetList("browse snapshot\nrm -rf /tmp/proof"), [
      "browse snapshot",
      "rm -rf /tmp/proof",
    ]);
    assert.deepEqual(targetList("browse snapshot\r\nrm -rf /tmp/proof"), [
      "browse snapshot",
      "rm -rf /tmp/proof",
    ]);
    assert.deepEqual(targetList("browse snapshot\rrm -rf /tmp/proof"), [
      "browse snapshot",
      "rm -rf /tmp/proof",
    ]);

    for (const command of [
      "browse snapshot\nrm -rf /tmp/proof",
      "browse snapshot\r\nrm -rf /tmp/proof",
      "browse snapshot\rrm -rf /tmp/proof",
    ] as const) {
      const decision = evaluateBashCommandPolicy(command, policy);
      assertDenied(decision);
      assert.equal(decision.rejection.target?.head, "rm");
    }
  });

  test("does not split quoted newlines", () => {
    const command = "printf 'hello\nworld'";
    assert.deepEqual(targetList(command), [command]);
    assertAllowed(evaluateBashCommandPolicy(command, {
      default: "deny",
      allow: [{ prefix: "printf " }],
    }));
  });

  test("checks nested command substitutions, backticks, and process substitutions", () => {
    assert.deepEqual(targetList("echo \"$(browse snapshot | grep title)\""), [
      "echo \"$(browse snapshot | grep title)\"",
      "browse snapshot",
      "grep title",
    ]);

    assert.deepEqual(targetList("echo `pwd; whoami`"), [
      "echo `pwd; whoami`",
      "pwd",
      "whoami",
    ]);

    assert.deepEqual(targetList("diff <(browse snapshot) >(grep title preview.html)"), [
      "diff <(browse snapshot) >(grep title preview.html)",
      "browse snapshot",
      "grep title preview.html",
    ]);
  });

  test("requires every parsed segment to pass", () => {
    const pipeline = evaluateBashCommandPolicy("browse snapshot | grep title", {
      default: "deny",
      allow: [{ prefix: "browse " }],
    });
    assertDenied(pipeline);
    assert.equal(pipeline.rejection.target?.head, "grep");

    assertAllowed(evaluateBashCommandPolicy("browse snapshot | grep title", {
      default: "deny",
      allow: [{ prefix: "browse " }, { prefix: "grep " }],
    }));

    const nested = evaluateBashCommandPolicy("echo $(rm -rf /)", {
      default: "deny",
      allow: [{ prefix: "echo " }],
    });
    assertDenied(nested);
    assert.equal(nested.rejection.target?.head, "rm");
  });

  test("blocks parser uncertainty in segments mode", () => {
    const unclosed = evaluateBashCommandPolicy("echo $(pwd", {
      default: "deny",
      allow: [{ prefix: "echo " }],
    });
    assertDenied(unclosed);
    assert.equal(unclosed.rejection.reason, "unsupported-shell-syntax");
    assert.match(formatBashCommandPolicyRejection(unclosed), /No shell process was started/);

    const heredoc = evaluateBashCommandPolicy("cat <<EOF\nsecret\nEOF", {
      default: "allow",
      deny: [{ regex: "secret" }],
    });
    assertDenied(heredoc);
    assert.equal(heredoc.rejection.reason, "unsupported-shell-syntax");

    const activeDefaultAllow = evaluateBashCommandPolicy("echo $(unterminated", {
      default: "allow",
      deny: ["__never_matches__"],
    });
    assertDenied(activeDefaultAllow);
    assert.equal(activeDefaultAllow.rejection.reason, "unsupported-shell-syntax");
  });
});

describe("bash tool policy enforcement", () => {
  test("denied commands throw a model-readable error and do not execute", async () => {
    let execCalls = 0;
    const operations: BashOperations = {
      exec: async () => {
        execCalls += 1;
        return { exitCode: 0 };
      },
    };
    const tool = createBashToolDefinition(process.cwd(), {
      operations,
      policyLabel: "test bash policy",
      policy: { default: "deny", allow: ["echo ok"] },
    });

    await assert.rejects(
      () => tool.execute("call-1", { command: "echo blocked" }, undefined, undefined, undefined as never),
      /Bash command blocked by test bash policy[\s\S]*No shell process was started/,
    );
    assert.equal(execCalls, 0);
  });

  test("malformed runtime policies fail closed at execution and do not execute", async () => {
    let execCalls = 0;
    const operations: BashOperations = {
      exec: async () => {
        execCalls += 1;
        return { exitCode: 0 };
      },
    };
    const tool = createBashToolDefinition(process.cwd(), {
      operations,
      policy: { deny: "rm" } as unknown as BashCommandPolicy,
    });

    await assert.rejects(
      () => tool.execute("call-invalid", { command: "echo ok" }, undefined, undefined, undefined as never),
      /configured bash command policy is invalid[\s\S]*deny must be an array[\s\S]*No shell process was started/,
    );
    assert.equal(execCalls, 0);
  });

  test("unknown top-level policy keys fail closed at execution and do not execute", async () => {
    let execCalls = 0;
    const operations: BashOperations = {
      exec: async () => {
        execCalls += 1;
        return { exitCode: 0 };
      },
    };
    const tool = createBashToolDefinition(process.cwd(), {
      operations,
      policy: { default: "deny", allow: ["echo ok"], extra: true } as unknown as BashCommandPolicy,
    });

    await assert.rejects(
      () => tool.execute("call-unknown-policy-key", { command: "echo ok" }, undefined, undefined, undefined as never),
      /configured bash command policy is invalid[\s\S]*unknown top-level key "extra"[\s\S]*No shell process was started/,
    );
    assert.equal(execCalls, 0);
  });

  test("malformed glob policies fail closed at execution and do not execute", async () => {
    let execCalls = 0;
    const operations: BashOperations = {
      exec: async () => {
        execCalls += 1;
        return { exitCode: 0 };
      },
    };
    const tool = createBashToolDefinition(process.cwd(), {
      operations,
      policy: { default: "deny", allow: [{ glob: "echo [z-a]" }] },
    });

    await assert.rejects(
      () => tool.execute("call-invalid-glob", { command: "echo z" }, undefined, undefined, undefined as never),
      /configured bash command policy is invalid[\s\S]*glob is not a valid command string glob[\s\S]*No shell process was started/,
    );
    assert.equal(execCalls, 0);
  });

  test("allowed commands and omitted policy preserve execution", async () => {
    const commands: string[] = [];
    const operations: BashOperations = {
      exec: async (command, _cwd, options) => {
        commands.push(command);
        options.onData(Buffer.from("ok\n"));
        return { exitCode: 0 };
      },
    };

    const allowedTool = createBashToolDefinition(process.cwd(), {
      operations,
      policy: { default: "deny", allow: ["echo ok"] },
    });
    const allowed = await allowedTool.execute("call-2", { command: "echo ok" }, undefined, undefined, undefined as never);
    const firstContent = allowed.content[0];
    if (firstContent?.type !== "text") assert.fail("expected text bash output");
    assert.equal(firstContent.text, "ok\n");

    const defaultTool = createBashToolDefinition(process.cwd(), { operations });
    await defaultTool.execute("call-3", { command: "echo anything" }, undefined, undefined, undefined as never);

    assert.deepEqual(commands, ["echo ok", "echo anything"]);
  });
});

describe("workflow bash policy wiring", () => {
  test("preserves bashPolicy through ctx.stage, ctx.task, and ctx.parallel stage creation", async () => {
    const bashPolicy = {
      default: "deny",
      allow: ["echo ok"],
    } satisfies BashCommandPolicy;
    const seen: Array<{ readonly name: string; readonly options: StageSessionCreateOptions }> = [];

    const wf = workflow({
      name: "bash-policy-wiring",
      description: "bash policy wiring",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("manual", { tools: ["bash"], bashPolicy }).prompt("manual");
        await ctx.task("task", { prompt: "task", tools: ["bash"], bashPolicy });
        await ctx.parallel([
          { name: "parallel-child", prompt: "parallel" },
        ], { tools: ["bash"], bashPolicy });
        return {};
      },
    });

    const result = await run(wf, {}, {
      adapters: {
        agentSession: {
          async create(options, meta) {
            seen.push({ name: meta?.stageName ?? "", options });
            return fakeStageSession();
          },
        },
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map((entry) => entry.name), ["manual", "task", "parallel-child"]);
    for (const entry of seen) {
      assert.deepEqual(entry.options.bashPolicy, bashPolicy);
      assert.deepEqual(entry.options.tools, ["bash"]);
    }
  });
});
