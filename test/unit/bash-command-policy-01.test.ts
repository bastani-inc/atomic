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

describe("bash command policy evaluator", () => {
  test("matches exact, prefix, glob, and regex allow rules", () => {
    assertAllowed(evaluateBashCommandPolicy("pwd", { default: "deny", allow: ["pwd"] }));
    assertDenied(evaluateBashCommandPolicy("pwd -P", { default: "deny", allow: ["pwd"] }));

    assertAllowed(evaluateBashCommandPolicy("browse snapshot", {
      default: "deny",
      allow: [{ prefix: "browse " }],
    }));

    assertAllowed(evaluateBashCommandPolicy("bun test test/unit/bash-command-policy.test.ts", {
      default: "deny",
      allow: [{ glob: "bun test test/unit/*.test.ts" }],
    }));

    const browseGlobPolicy = {
      default: "deny",
      allow: [{ glob: "browse *" }],
    } satisfies BashCommandPolicy;
    assertAllowed(evaluateBashCommandPolicy("browse http://localhost:3000", browseGlobPolicy));
    assertAllowed(evaluateBashCommandPolicy("browse docs/index.html", browseGlobPolicy));
    assertAllowed(evaluateBashCommandPolicy("browse ./preview/output.html", browseGlobPolicy));
    assertDenied(evaluateBashCommandPolicy("echo browse docs/index.html", browseGlobPolicy));
    assertAllowed(evaluateBashCommandPolicy("browse docs/index.html", {
      default: "deny",
      allow: [{ glob: "browse docs?index.html" }],
    }));

    assertAllowed(evaluateBashCommandPolicy("echo literal-*", {
      default: "deny",
      allow: [{ glob: "echo literal-\\*" }],
    }));
    assertDenied(evaluateBashCommandPolicy("echo literal-anything", {
      default: "deny",
      allow: [{ glob: "echo literal-\\*" }],
    }));
    assertAllowed(evaluateBashCommandPolicy("echo file1.txt", {
      default: "deny",
      allow: [{ glob: "echo file[12].txt" }],
    }));
    assertDenied(evaluateBashCommandPolicy("echo file3.txt", {
      default: "deny",
      allow: [{ glob: "echo file[12].txt" }],
    }));

    assertAllowed(evaluateBashCommandPolicy("rg bashPolicy packages", {
      default: "deny",
      allow: [{ regex: "^rg\\b" }],
    }));
  });

  test("gives deny rules precedence over allow rules", () => {
    const decision = evaluateBashCommandPolicy("git rm package-lock.json", {
      default: "deny",
      allow: [{ prefix: "git " }],
      deny: [{ regex: "\\brm\\b" }],
    });

    assertDenied(decision);
    assert.equal(decision.rejection.reason, "matched-deny");
    assert.equal(decision.rejection.target?.head, "git");
  });

  test("skips parsing when policy is omitted or equivalent to default allow with no rules", () => {
    const noRulePolicies = [
      undefined,
      {},
      { default: "allow" },
      { allow: [], deny: [] },
      { default: "allow", match: "segments", allow: [], deny: [] },
      { default: "allow", match: "whole" },
    ] as const;

    for (const policy of noRulePolicies) {
      assertAllowed(evaluateBashCommandPolicy("echo $(unterminated", policy));
      assertAllowed(evaluateBashCommandPolicy("PATH=/tmp:$PATH browse snapshot", policy));
      assertAllowed(evaluateBashCommandPolicy(">file cmd", policy));
      assertAllowed(evaluateBashCommandPolicy("cmd>file", policy));
    }
  });

  test("default deny blocks unmatched commands", () => {
    const decision = evaluateBashCommandPolicy("printf blocked", {
      default: "deny",
      allow: ["echo ok"],
    });

    assertDenied(decision);
    assert.equal(decision.rejection.reason, "default-deny");
    assert.equal(decision.rejection.target?.head, "printf");
  });

  test("rejects malformed runtime policy shapes as invalid-policy", () => {
    const cases: readonly { readonly policy: BashCommandPolicy; readonly message: RegExp }[] = [
      { policy: null as unknown as BashCommandPolicy, message: /non-null object/i },
      { policy: [] as unknown as BashCommandPolicy, message: /non-null object/i },
      { policy: "deny rm" as unknown as BashCommandPolicy, message: /non-null object/i },
      { policy: { default: "block" } as unknown as BashCommandPolicy, message: /default.*allow.*deny/i },
      { policy: { default: null } as unknown as BashCommandPolicy, message: /default.*allow.*deny/i },
      { policy: { denny: [{ prefix: "rm " }] } as unknown as BashCommandPolicy, message: /unknown top-level key "denny"/i },
      { policy: { default: "deny", allow: ["echo ok"], extra: true } as unknown as BashCommandPolicy, message: /unknown top-level key "extra"/i },
      { policy: { match: "raw" } as unknown as BashCommandPolicy, message: /match.*whole.*segments/i },
      { policy: { match: null } as unknown as BashCommandPolicy, message: /match.*whole.*segments/i },
      { policy: { allow: "echo" } as unknown as BashCommandPolicy, message: /allow.*array/i },
      { policy: { deny: "rm" } as unknown as BashCommandPolicy, message: /deny.*array/i },
      { policy: { allow: [""] } as unknown as BashCommandPolicy, message: /exact rule.*empty/i },
      { policy: { allow: [{ prefix: 42 }] } as unknown as BashCommandPolicy, message: /prefix.*string/i },
      { policy: { allow: [{ prefix: "echo ", glob: "echo *" }] } as unknown as BashCommandPolicy, message: /exactly one/i },
      { policy: { allow: [{ regex: "(" }] } as unknown as BashCommandPolicy, message: /valid JavaScript RegExp/i },
      { policy: { allow: [{ regex: "echo", flags: "g" }] } as unknown as BashCommandPolicy, message: /stateful g or y/i },
      { policy: { allow: [{ regex: "echo", flags: "y" }] } as unknown as BashCommandPolicy, message: /stateful g or y/i },
      { policy: { allow: [{ regex: "echo", flags: 42 }] } as unknown as BashCommandPolicy, message: /flags.*string/i },
    ];

    for (const entry of cases) {
      const decision = evaluateBashCommandPolicy("echo ok", entry.policy);
      assertDenied(decision);
      assert.equal(decision.rejection.reason, "invalid-policy");
      assert.match(decision.rejection.message, entry.message);
    }

    assert.throws(
      () => validateBashCommandPolicy({ deny: "rm" } as unknown as BashCommandPolicy),
      /deny.*array/i,
    );
    assert.throws(
      () => validateBashCommandPolicy({ default: "allow", extra: true } as unknown as BashCommandPolicy),
      /Invalid bash command policy:.*unknown top-level key "extra"/i,
    );
  });

  test("rejects unknown top-level policy keys before default-allow fast-path compatibility", () => {
    const decision = evaluateBashCommandPolicy("echo $(unterminated", {
      extra: true,
    } as unknown as BashCommandPolicy);

    assertDenied(decision);
    assert.equal(decision.rejection.reason, "invalid-policy");
    assert.match(decision.rejection.message, /unknown top-level key "extra"/i);
  });

  test("preserves escaped glob bracket-class metacharacters as literals", () => {
    const escapedDashPolicy = {
      default: "deny",
      allow: [{ glob: "echo file[0\\-9].txt" }],
    } satisfies BashCommandPolicy;
    for (const command of ["echo file0.txt", "echo file-.txt", "echo file9.txt"] as const) {
      assertAllowed(evaluateBashCommandPolicy(command, escapedDashPolicy));
    }
    assertDenied(evaluateBashCommandPolicy("echo file5.txt", escapedDashPolicy));

    const escapedCaretPolicy = {
      default: "deny",
      allow: [{ glob: "echo [\\^a]" }],
    } satisfies BashCommandPolicy;
    assertAllowed(evaluateBashCommandPolicy("echo ^", escapedCaretPolicy));
    assertAllowed(evaluateBashCommandPolicy("echo a", escapedCaretPolicy));
    assertDenied(evaluateBashCommandPolicy("echo b", escapedCaretPolicy));

    const escapedBracketPolicy = {
      default: "deny",
      allow: [{ glob: "echo [\\[\\]]" }],
    } satisfies BashCommandPolicy;
    assertAllowed(evaluateBashCommandPolicy("echo [", escapedBracketPolicy));
    assertAllowed(evaluateBashCommandPolicy("echo ]", escapedBracketPolicy));
    assertDenied(evaluateBashCommandPolicy("echo x", escapedBracketPolicy));

    const escapedBackslashPolicy = {
      default: "deny",
      allow: [{ glob: "echo path[\\\\]x" }],
    } satisfies BashCommandPolicy;
    assertAllowed(evaluateBashCommandPolicy("echo path\\x", escapedBackslashPolicy));
    assertDenied(evaluateBashCommandPolicy("echo path/x", escapedBackslashPolicy));
  });

  test("malformed glob bracket ranges fail closed as invalid-policy", () => {
    const policy = {
      default: "deny",
      allow: [{ glob: "echo [z-a]" }],
    } satisfies BashCommandPolicy;

    const decision = evaluateBashCommandPolicy("echo z", policy);
    assertDenied(decision);
    assert.equal(decision.rejection.reason, "invalid-policy");
    assert.match(decision.rejection.message, /glob.*valid command string glob/i);
    assert.match(formatBashCommandPolicyRejection(decision), /No shell process was started/);
    assert.throws(
      () => validateBashCommandPolicy(policy),
      /Invalid bash command policy: allow\[0\]\.glob is not a valid command string glob/,
    );
  });

  test("whole mode matches the raw command string", () => {
    assertAllowed(evaluateBashCommandPolicy("browse snapshot; rm -rf /", {
      match: "whole",
      default: "deny",
      allow: [{ prefix: "browse " }],
    }));

    const denied = evaluateBashCommandPolicy("browse snapshot; rm -rf /", {
      match: "whole",
      default: "deny",
      allow: [{ prefix: "browse " }],
      deny: [{ regex: "\\brm\\b" }],
    });
    assertDenied(denied);
    assert.equal(denied.rejection.target?.target, "browse snapshot; rm -rf /");
  });

  test("preserves literal command heads and argument substitutions", () => {
    const commands = [
      "grep pattern file.txt",
      "./script --flag",
      "/usr/bin/env bash",
      "bun test",
      "browse snapshot",
      "my-command_name.v1/sub.tool --help",
      "echo $(printf ok)",
    ] as const;

    const activeDefaultAllowPolicy = {
      default: "allow",
      deny: ["__never_matches__"],
    } satisfies BashCommandPolicy;

    for (const command of commands) {
      assertAllowed(evaluateBashCommandPolicy(command, activeDefaultAllowPolicy));
    }
  });

  test("rejects non-literal command heads when a default-allow segments policy has rules", () => {
    const cases = [
      { command: "$cmd --flag", reason: /parameter-expanded/ },
      { command: "${cmd} --flag", reason: /parameter-expanded/ },
      { command: "r''m -rf /tmp/x", reason: /quote-constructed/ },
      { command: "'rm' -rf /tmp/x", reason: /quote-constructed/ },
      { command: "r\"\"m -rf /tmp/x", reason: /quote-constructed/ },
      { command: "\"rm\" -rf /tmp/x", reason: /quote-constructed/ },
      { command: "r\\m -rf /tmp/x", reason: /escape-constructed/ },
      { command: "~/bin/rm -rf /tmp/x", reason: /tilde-expanded/ },
      { command: "r*m -rf /tmp/x", reason: /glob-expanded/ },
      { command: "r?m -rf /tmp/x", reason: /glob-expanded/ },
      { command: "r[ab]m -rf /tmp/x", reason: /glob-expanded/ },
      { command: "{rm,echo} -rf /tmp/x", reason: /brace-expanded/ },
      { command: "r$(printf m) -rf /tmp/x", reason: /substitutions/ },
      { command: "r`printf m` -rf /tmp/x", reason: /substitutions/ },
      { command: "r<(printf m) -rf /tmp/x", reason: /substitutions/ },
    ] as const;

    const activeDefaultAllowPolicy = {
      default: "allow",
      deny: ["__never_matches__"],
    } satisfies BashCommandPolicy;

    for (const entry of cases) {
      const decision = evaluateBashCommandPolicy(entry.command, activeDefaultAllowPolicy);
      assertDenied(decision);
      assert.equal(decision.rejection.reason, "unsupported-shell-syntax");
      assert.match(decision.rejection.message, entry.reason);
    }
  });

  test("rejects reserved words and compound command heads in segments mode", () => {
    const policy = {
      default: "allow",
      deny: ["__never_matches__"],
    } satisfies BashCommandPolicy;

    for (const command of [
      "coproc echo ok",
      "if true",
      "for name in value",
      "while true",
      "case value",
      "{ echo ok; }",
      "}",
      "! echo ok",
    ] as const) {
      const decision = evaluateBashCommandPolicy(command, policy);
      assertDenied(decision);
      assert.equal(decision.rejection.reason, "unsupported-shell-syntax");
      assert.match(decision.rejection.message, /reserved or compound/i);
    }
  });

  test("rejects leading redirections before command-head selection in segments mode", () => {
    const policy = {
      default: "allow",
      deny: ["__never_matches__"],
    } satisfies BashCommandPolicy;

    for (const command of [
      ">file cmd",
      "> file cmd",
      ">>file cmd",
      "2>file cmd",
      "<file cmd",
      "&>file cmd",
      "&>>file cmd",
      ">|file cmd",
      "<&0 cmd",
      ">&2 cmd",
    ] as const) {
      const decision = evaluateBashCommandPolicy(command, policy);
      assertDenied(decision);
      assert.equal(decision.rejection.reason, "unsupported-shell-syntax");
      assert.equal(decision.rejection.target, undefined);
      assert.match(decision.rejection.message, /leading shell redirection/i);
      assert.match(formatBashCommandPolicyRejection(decision), /No shell process was started/);
    }
  });

  test("rejects redirection operators attached to command-head words in segments mode", () => {
    const policy = {
      default: "allow",
      deny: ["__never_matches__"],
    } satisfies BashCommandPolicy;

    for (const command of [
      "cmd>file",
      "cmd>>file",
      "cmd>|file",
      "cmd2>file",
      "cmd>&2",
      "cmd</tmp/in",
      "cmd<&0",
      "cmd<>file",
      "cmd&>file",
      "cmd&>>file",
    ] as const) {
      const decision = evaluateBashCommandPolicy(command, policy);
      assertDenied(decision);
      assert.equal(decision.rejection.reason, "unsupported-shell-syntax");
      assert.equal(decision.rejection.target, undefined);
      assert.match(decision.rejection.message, /attached shell redirection/i);
      assert.match(formatBashCommandPolicyRejection(decision), /No shell process was started/);
    }
  });

  test("rejects environment assignments in command-head position", () => {
    const policy = {
      default: "deny",
      allow: [{ prefix: "browse " }, { prefix: "echo " }],
    } satisfies BashCommandPolicy;

    for (const command of [
      "PATH=/tmp:$PATH browse snapshot",
      "LD_PRELOAD=/tmp/x browse snapshot",
      "FOO=bar",
      "echo ok; PATH=/tmp:$PATH browse snapshot",
      "cmd=rm; $cmd -rf /tmp/x",
    ] as const) {
      const decision = evaluateBashCommandPolicy(command, policy);
      assertDenied(decision);
      assert.equal(decision.rejection.reason, "unsupported-shell-syntax");
      assert.match(decision.rejection.message, /assignment/i);
    }
  });
});

