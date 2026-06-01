/**
 * Slash dispatch tests.
 *
 * Verifies:
 *   - /workflow <name> [key=value] resolves non-admin first token as workflow
 *     name and dispatches run (not unknown subcommand).
 *   - /workflow inputs <name> shows schema via runtime.dispatch inputs.
 *   - /workflow inputs (missing name) shows usage.
 *   - Unknown workflow name prints "Workflow not found: <name>".
 *   - Per-workflow slash aliases are not registered; /workflow <name> is the
 *     single workflow-run slash surface.
 *   - /workflow completions include admin subcommands, aliases, AND workflow names.
 *   - parseWorkflowArgs correctly parses key=value pairs and JSON objects.
 */

import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    parseWorkflowArgs,
    tokenizeWorkflowArgs,
    makeExecuteWorkflowTool,
    workflowPolicyFromContext,
    WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/index.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import type {
    ExtensionAPI,
    PiArgumentCompletion,
    PiCommandContext,
    PiCommandOptions,
    PiToolOpts,
    WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import {
    createExtensionRuntime,
    type ExtensionRuntime,
} from "../../packages/workflows/src/extension/runtime.js";
import type { ChatSurfacePayload } from "../../packages/workflows/src/tui/chat-surface-message.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { WORKFLOW_AUTH_FAILURE_MESSAGE } from "../../packages/workflows/src/shared/workflow-failures.js";
import { LIFECYCLE_NOTICE_CUSTOM_TYPE } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type {
    PiCustomComponent,
    PiCustomOverlayFactoryTui,
    PiCustomOverlayFunction,
    PiCustomOverlayOptions,
    PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import {
    stageControlRegistry,
    type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { stageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";

beforeEach(() => {
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
});

afterEach(async () => {
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
    stageControlRegistry.clear();
    killAllRuns({ store, cancellation: cancellationRegistry });
    await Promise.all(
        jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise),
    );
    store.clear();
});

async function writeWorkflowFixture(
    filePath: string,
    name: string,
): Promise<void> {
    const encodedName = JSON.stringify(name);
    await writeFile(
        filePath,
        `export default Object.freeze({
  __piWorkflow: true,
  name: ${encodedName},
  normalizedName: ${encodedName},
  async run() {
    return { ok: true };
  },
});
`,
        "utf8",
    );
}

// ---------------------------------------------------------------------------
// parseWorkflowArgs
// ---------------------------------------------------------------------------

describe("parseWorkflowArgs", () => {
    test("empty tokens → empty object", () => {
        assert.deepEqual(parseWorkflowArgs([]), {});
    });

    test("parses key=value string pairs", () => {
        assert.deepEqual(parseWorkflowArgs(["prompt=hello world"]), {
            prompt: "hello world",
        });
    });

    test("multiple key=value pairs", () => {
        assert.deepEqual(parseWorkflowArgs(["a=1", "b=foo"]), {
            a: 1,
            b: "foo",
        });
    });

    test("JSON-typed values: number, boolean", () => {
        assert.deepEqual(parseWorkflowArgs(["count=42", "flag=true"]), {
            count: 42,
            flag: true,
        });
    });

    test("value with = in it splits on first = only", () => {
        assert.deepEqual(parseWorkflowArgs(["url=http://x.com/a=b"]), {
            url: "http://x.com/a=b",
        });
    });

    test("JSON object token merged into result", () => {
        const result = parseWorkflowArgs(['{"key":"val","n":3}']);
        assert.deepEqual(result, { key: "val", n: 3 });
    });

    test("JSON object merged with key=value", () => {
        const result = parseWorkflowArgs(['{"a":1}', "b=two"]);
        assert.deepEqual(result, { a: 1, b: "two" });
    });

    test("tokens without = are ignored", () => {
        assert.deepEqual(parseWorkflowArgs(["positional", "another"]), {});
    });

    test("key with empty value", () => {
        assert.deepEqual(parseWorkflowArgs(["name="]), { name: "" });
    });
});

// ---------------------------------------------------------------------------
// tokenizeWorkflowArgs
// ---------------------------------------------------------------------------

describe("tokenizeWorkflowArgs", () => {
    test("empty string → empty array", () => {
        assert.deepEqual(tokenizeWorkflowArgs(""), []);
    });

    test("whitespace-only string → empty array", () => {
        assert.deepEqual(tokenizeWorkflowArgs("   \t  "), []);
    });

    test("plain whitespace split for bare tokens", () => {
        assert.deepEqual(tokenizeWorkflowArgs("workflow-name a=1 b=foo"), [
            "workflow-name",
            "a=1",
            "b=foo",
        ]);
    });

    test("double-quoted value preserves internal whitespace", () => {
        // Regression: `prompt="map the codebase"` used to split into three
        // tokens (`prompt="map`, `the`, `codebase"`), which then rendered as
        // `prompt=""map"` in the dispatch confirm card.
        assert.deepEqual(
            tokenizeWorkflowArgs(
                'workflow-name prompt="map the codebase" max=4',
            ),
            ["workflow-name", 'prompt="map the codebase"', "max=4"],
        );
    });

    test("single-quoted value preserves internal whitespace", () => {
        assert.deepEqual(tokenizeWorkflowArgs("wf prompt='hello there' n=2"), [
            "wf",
            "prompt='hello there'",
            "n=2",
        ]);
    });

    test("nested quotes of the opposite kind are treated as literal characters", () => {
        assert.deepEqual(tokenizeWorkflowArgs(`wf msg="she said 'hi'"`), [
            "wf",
            `msg="she said 'hi'"`,
        ]);
    });

    test("unterminated quote is recovered as a single tail token", () => {
        // The user can paste a partial value mid-typing; we never throw on
        // their input, the downstream JSON parse just falls back to string.
        assert.deepEqual(tokenizeWorkflowArgs('wf prompt="map the codebase'), [
            "wf",
            'prompt="map the codebase',
        ]);
    });

    test("collapses runs of whitespace", () => {
        assert.deepEqual(tokenizeWorkflowArgs("a   b\t\tc"), ["a", "b", "c"]);
    });

    test("end-to-end: tokenize + parse unquotes the string value", () => {
        const tokens = tokenizeWorkflowArgs(
            'deep-research-codebase prompt="map the codebase" max_partitions=4',
        );
        assert.deepEqual(tokens, [
            "deep-research-codebase",
            'prompt="map the codebase"',
            "max_partitions=4",
        ]);
        assert.deepEqual(parseWorkflowArgs(tokens.slice(1)), {
            prompt: "map the codebase",
            max_partitions: 4,
        });
    });
});

// ---------------------------------------------------------------------------
// Shared test factory helpers
// ---------------------------------------------------------------------------

interface RegisteredCommand {
    name: string;
    options: PiCommandOptions;
}

interface SentMessage {
    customType?: string;
    content?: string;
    display?: boolean;
    details?: unknown;
}

function buildMockPi(): {
    pi: ExtensionAPI;
    commands: RegisteredCommand[];
    sent: SentMessage[];
} {
    const commands: RegisteredCommand[] = [];
    const sent: SentMessage[] = [];
    const pi: ExtensionAPI = {
        registerCommand: (name: string, options: PiCommandOptions) => {
            commands.push({ name, options });
        },
        // Chat surfaces dispatch via `emitChatSurface` → `pi.sendMessage`.
        // Mirror the message store so tests can observe the message stream.
        sendMessage: (msg: SentMessage) => {
            sent.push(msg);
        },
    };
    return { pi, commands, sent };
}

function buildCtx(): { ctx: PiCommandContext; messages: string[] } {
    const messages: string[] = [];
    const ctx: PiCommandContext = {
        ui: {
            notify(msg: string) {
                messages.push(msg);
            },
        },
    };
    return { ctx, messages };
}

function addFactoryStubs(pi: ExtensionAPI): void {
    pi.registerTool = () => {};
    pi.registerMessageRenderer = () => {};
    pi.registerFlag = () => {};
    pi.on = () => {};
    pi.ui = { setWidget: () => {} };
    pi.createAgentSession = async () => ({ session: fakeAgentSession() });
    pi.disableAsyncDiscovery = true;
}

function fakeAgentSession(): StageSessionRuntime {
    let last = "";
    return {
        async prompt(text: string): Promise<string> {
            last = `stub:${text.slice(0, 24)}`;
            return last;
        },
        async steer(text: string): Promise<void> {
            last = `steer:${text}`;
        },
        async followUp(text: string): Promise<void> {
            last = `follow:${text}`;
        },
        subscribe: () => () => {},
        sessionFile: undefined,
        sessionId: "slash-dispatch-test-session",
        async setModel(): Promise<void> {},
        setThinkingLevel(): void {},
        async cycleModel(): Promise<undefined> {
            return undefined;
        },
        cycleThinkingLevel(): undefined {
            return undefined;
        },
        agent: {} as StageSessionRuntime["agent"],
        model: undefined,
        thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
        messages: [],
        isStreaming: false,
        async navigateTree(): Promise<{ cancelled: boolean }> {
            return { cancelled: true };
        },
        async compact(): ReturnType<StageSessionRuntime["compact"]> {
            return undefined as unknown as Awaited<
                ReturnType<StageSessionRuntime["compact"]>
            >;
        },
        abortCompaction(): void {},
        async abort(): Promise<void> {},
        dispose(): void {},
        getLastAssistantText(): string | undefined {
            return last;
        },
    };
}

async function runFactory(pi: ExtensionAPI): Promise<void> {
    addFactoryStubs(pi);
    const factoryModule =
        await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);
}

// ---------------------------------------------------------------------------
// Slash dispatch: non-admin first token → workflow name run
// ---------------------------------------------------------------------------

describe("slash /workflow <name> dispatch", () => {
    test("/workflow <known-name> dispatches run, not unknown subcommand", async () => {
        const wf = defineWorkflow("test-wf")
            .input("prompt", { type: "text" })
            .output("done", { type: "unknown" })
            .run(async (_ctx) => ({ done: true }))
            .compile() as WorkflowDefinition;

        const registry = createRegistry([wf]);
        const runtime = createExtensionRuntime({ registry });

        const { ctx, messages } = buildCtx();

        let dispatchCalled = false;
        let dispatchedArgs: {
            name: string;
            inputs: Record<string, unknown>;
            action: string;
        } | null = null;

        const execute = async (args: string, execCtx: PiCommandContext) => {
            const print = (msg: string): void => execCtx.ui.notify(msg, "info");
            const rawParts = args.trim().split(/\s+/);
            const parts = rawParts[0] === "" ? [] : rawParts;
            const subcommand = parts[0] ?? "";

            const ADMIN = new Set([
                "list",
                "status",
                "interrupt",
                "kill",
                "resume",
                "inputs",
            ]);

            if (!subcommand || subcommand === "list") {
                print(
                    `Registered workflows: ${runtime.registry.names().join(", ")}`,
                );
                return;
            }

            if (!ADMIN.has(subcommand)) {
                dispatchCalled = true;
                const inputTokens = parts.slice(1);
                const inputs = parseWorkflowArgs(inputTokens);
                dispatchedArgs = { name: subcommand, inputs, action: "run" };
                const result = await runtime.dispatch({
                    workflow: subcommand,
                    inputs,
                    action: "run",
                });
                if (result.action === "run" && "runId" in result) {
                    const r = result as {
                        action: "run";
                        runId: string;
                        status: string;
                        error?: string;
                    };
                    if (r.status === "failed" && r.runId === "") {
                        const available = runtime.registry.names();
                        print(
                            `Workflow not found: ${subcommand}\nAvailable: ${available.join(", ")}`,
                        );
                    } else {
                        print(
                            `Workflow "${subcommand}" completed (runId: ${r.runId})`,
                        );
                    }
                }
                return;
            }
            print(`unknown subcommand: ${subcommand}`);
        };

        await execute("test-wf prompt=hello", ctx);

        assert.equal(dispatchCalled, true);
        const d = dispatchedArgs as {
            name: string;
            inputs: Record<string, unknown>;
            action: string;
        } | null;
        assert.equal(d?.name, "test-wf");
        assert.deepEqual(d?.inputs, { prompt: "hello" });
        assert.equal(d?.action, "run");
        assert.equal(
            messages.some((m) => m.includes("completed")),
            true,
        );
        // Must NOT print unknown subcommand
        assert.equal(
            messages.some((m) => m.includes("unknown subcommand")),
            false,
        );
    });

    test("/workflow <unknown-name> prints 'Workflow not found: <name>'", async () => {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        const { ctx, messages } = buildCtx();

        const ADMIN = new Set([
            "list",
            "status",
            "interrupt",
            "kill",
            "resume",
            "inputs",
        ]);
        const execute = async (args: string, execCtx: PiCommandContext) => {
            const print = (msg: string): void => execCtx.ui.notify(msg, "info");
            const rawParts = args.trim().split(/\s+/);
            const parts = rawParts[0] === "" ? [] : rawParts;
            const subcommand = parts[0] ?? "";
            if (!ADMIN.has(subcommand) && subcommand) {
                const result = await runtime.dispatch({
                    workflow: subcommand,
                    inputs: {},
                    action: "run",
                });
                if (result.action === "run" && "runId" in result) {
                    const r = result as {
                        action: "run";
                        runId: string;
                        status: string;
                    };
                    if (r.status === "failed" && r.runId === "") {
                        const available = runtime.registry.names();
                        print(
                            `Workflow not found: ${subcommand}\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`,
                        );
                    }
                }
            }
        };

        await execute("ghost-workflow", ctx);

        assert.ok(messages[0].includes("Workflow not found: ghost-workflow"));
        assert.ok(!messages[0].includes("unknown subcommand"));
    });
});

// ---------------------------------------------------------------------------
// Factory command registration + completion integration tests (using real factory)
// ---------------------------------------------------------------------------

describe("factory command registration (real factory)", () => {
    /** Import factory and call it with a mock pi whose registry contains known workflows. */
    async function runFactoryWithMock(): Promise<RegisteredCommand[]> {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);
        return commands;
    }

    test("per-workflow slash aliases are not registered", async () => {
        const commands = await runFactoryWithMock();
        const names = commands.map((c) => c.name);
        assert.equal(
            names.some((name) => name.startsWith("workflow:")),
            false,
        );
    });

    test("base /workflow command registered", async () => {
        const commands = await runFactoryWithMock();
        const names = commands.map((c) => c.name);
        assert.ok(names.includes("workflow"));
    });
});

// ---------------------------------------------------------------------------
// Completions include workflow names
// ---------------------------------------------------------------------------

describe("getArgumentCompletions includes workflow names", () => {
    test("completions include admin subcommands and workflow names from registry", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        assert.notEqual(workflowCmd, undefined);

        const completions =
            (await workflowCmd!.options.getArgumentCompletions?.("")) ?? [];
        const labels = completions.map((c) => c.label);

        assert.ok(labels.includes("list"));
        assert.ok(labels.includes("status"));
        assert.ok(labels.includes("connect"));
        assert.ok(labels.includes("interrupt"));
        assert.ok(labels.includes("kill"));
        assert.ok(labels.includes("resume"));
        assert.ok(labels.includes("inputs"));
        assert.ok(labels.includes("reload"));
        assert.equal(labels.includes("session"), false);

        assert.ok(labels.includes("deep-research-codebase"));
        assert.ok(labels.includes("ralph"));
        assert.ok(labels.includes("open-claude-design"));
    });

    test("completions filter by partial prefix", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const completions =
            (await workflowCmd!.options.getArgumentCompletions?.("li")) ?? [];
        assert.equal(
            completions.every((c) => c.label.startsWith("li")),
            true,
        );
        assert.ok(completions.map((c) => c.label).includes("list"));
    });

    test("completions cover subcommand arguments without shadowing submit", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const completions =
            workflowCmd!.options.getArgumentCompletions?.("interrupt -") ?? [];
        assert.ok(completions.some((c) => c.value === "interrupt -y "));

        const killCompletions =
            workflowCmd!.options.getArgumentCompletions?.("kill -") ?? [];
        assert.ok(killCompletions.some((c) => c.value === "kill -y "));
    });

    test("trailing-space completion does not throw on empty subcommand", async () => {
        // Regression: typing `/workflow ` (just the slash command + space)
        // forwards `partial = " "` to getArgumentCompletions, which used to
        // fall through to `registry.get("")`, throwing
        // `TypeError: normalizeWorkflowName: name must be a non-empty string`.
        // The trailing-space case should produce the same admin + workflow-name
        // menu as the no-args case (partial = "").
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        let completions: PiArgumentCompletion[] | null | undefined;
        assert.doesNotThrow(() => {
            completions = workflowCmd!.options.getArgumentCompletions?.(" ") as
                | PiArgumentCompletion[]
                | null
                | undefined;
        });
        const labels = (completions ?? []).map((c) => c.label);
        assert.ok(labels.includes("list"), "admin subcommands offered");
        assert.ok(
            labels.includes("deep-research-codebase"),
            "workflow names offered",
        );
    });
});

// ---------------------------------------------------------------------------
// removed session namespace
// ---------------------------------------------------------------------------

describe("/workflow session namespace removed", () => {
    test("/workflow session ... is not treated as a control namespace", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("session kill abc12345", ctx);

        const joined = messages.join("\n");
        assert.match(joined, /Workflow not found: session/);
        assert.doesNotMatch(joined, /Usage: \/workflow session/);
    });
});

// ---------------------------------------------------------------------------
// inputs subcommand via execute handler (factory-registered)
// ---------------------------------------------------------------------------

describe("inputs subcommand", () => {
    test("/workflow inputs with no name prints usage", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("inputs", ctx);

        assert.ok(messages[0].includes("Usage:"));
        assert.ok(messages[0].includes("inputs"));
    });

    test("/workflow inputs <unknown> prints workflow not found plus available", async () => {
        const { pi, commands } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("inputs no-such-workflow-xyz", ctx);

        assert.ok(messages[0].includes("no-such-workflow-xyz"));
        assert.ok(messages[0].includes("Available:"));
    });

    test("/workflow inputs <known> shows schema", async () => {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();
        await workflowCmd!.options.handler("inputs ralph", ctx);

        assert.ok(!messages[0].includes("Workflow not found"));
        assert.ok(messages[0].includes("ralph"));
        assert.equal(
            sent.some(
                (message) =>
                    message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
            ),
            false,
            "interactive schema output should continue using ctx.ui.notify",
        );
    });
});

// ---------------------------------------------------------------------------
// /workflow deep-research-codebase prompt=test dispatch (full factory path)
// ---------------------------------------------------------------------------

describe("/workflow <name> prompt=test dispatches run via factory", () => {
    test("/workflow deep-research-codebase dispatches run action (not unknown subcommand)", async () => {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();

        await workflowCmd!.options.handler(
            "deep-research-codebase prompt=test",
            ctx,
        );

        assert.equal(
            messages.some((m) => m.includes("unknown subcommand")),
            false,
        );
        // Success path: the dispatch confirmation is now emitted as a
        // chat-surface `kind: "dispatch"` message (sendMessage), not a string
        // through ctx.ui.notify. Either error wording in `messages` or a
        // dispatch payload in `sent` counts as evidence the handler resolved.
        const dispatchSent = sent.some(
            (m) =>
                (m.details as { kind?: string } | undefined)?.kind ===
                "dispatch",
        );
        const errored = messages.some(
            (m) =>
                m.includes("completed") ||
                m.includes("failed") ||
                m.includes("Workflow not found"),
        );
        assert.equal(dispatchSent || errored, true);
    });
});

// ---------------------------------------------------------------------------
// /workflow <name> --help prints schema, skips dispatch
// ---------------------------------------------------------------------------

describe("/workflow <name> --help prints schema without dispatching", () => {
    test("--help token short-circuits to the schema printer", async () => {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow");
        const { ctx, messages } = buildCtx();

        await workflowCmd!.options.handler(
            "deep-research-codebase --help",
            ctx,
        );

        // Schema printer prints the pretty themed header or the plain text header.
        assert.ok(
            messages.some((m) =>
                /INPUTS FOR DEEP-RESEARCH-CODEBASE|Inputs for "deep-research-codebase":/.test(
                    m,
                ),
            ),
            `expected schema header in messages; got: ${JSON.stringify(messages)}`,
        );
        assert.equal(
            sent.some(
                (message) =>
                    message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
            ),
            false,
            "interactive help output should continue using ctx.ui.notify",
        );
        // Should NOT have a run completion/failure line
        assert.equal(
            messages.some(
                (m) => m.includes("started") || m.includes("completed (runId:"),
            ),
            false,
        );
    });
});

// ---------------------------------------------------------------------------
// Canonical registerCommand shape — opts.handler, no opts.execute
// ---------------------------------------------------------------------------

interface RawRegisteredCommand {
    name: string;
    options: PiCommandOptions;
}

function buildRawMockPi(): {
    pi: ExtensionAPI;
    commands: RawRegisteredCommand[];
    sent: SentMessage[];
} {
    const commands: RawRegisteredCommand[] = [];
    const sent: SentMessage[] = [];
    const pi: ExtensionAPI = {
        registerCommand: (name: string, options: PiCommandOptions) => {
            commands.push({ name, options });
        },
        sendMessage: (msg: SentMessage) => {
            sent.push(msg);
        },
    };
    return { pi, commands, sent };
}

describe("canonical registerCommand — opts.handler shape", () => {
    async function runFactoryRaw(): Promise<{
        commands: RawRegisteredCommand[];
        sent: SentMessage[];
    }> {
        const { pi, commands, sent } = buildRawMockPi();
        await runFactory(pi);
        return { commands, sent };
    }

    test("registerCommand receives string name 'workflow'", async () => {
        const { commands } = await runFactoryRaw();
        const names = commands.map((c) => c.name);
        assert.ok(names.includes("workflow"));
    });

    test("registerCommand does not receive per-workflow alias names", async () => {
        const { commands } = await runFactoryRaw();
        const names = commands.map((c) => c.name);
        assert.equal(
            names.some((n) => n.startsWith("workflow:")),
            false,
        );
    });

    test("opts passed to registerCommand have 'handler' (function)", async () => {
        const { commands } = await runFactoryRaw();
        for (const { name, options } of commands) {
            assert.equal(
                typeof options.handler,
                "function",
                `${name}: handler should be function`,
            );
        }
    });

    test("opts passed to registerCommand do NOT have 'execute' property", async () => {
        const { commands } = await runFactoryRaw();
        for (const { name, options } of commands) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(options, "execute"),
                false,
                `${name}: opts must not have execute — use handler`,
            );
        }
    });

    test("opts have 'description' string", async () => {
        const { commands } = await runFactoryRaw();
        for (const { name, options } of commands) {
            assert.equal(
                typeof options.description,
                "string",
                `${name}: description should be string`,
            );
        }
    });

    test("handler for 'workflow' is callable — does not throw synchronously", async () => {
        const { commands, sent } = await runFactoryRaw();
        const workflowCmd = commands.find((c) => c.name === "workflow");
        assert.notEqual(workflowCmd, undefined);
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify(message: string) {
                    msgs.push(message);
                },
            },
        };
        await workflowCmd!.options.handler("list", ctx);
        // `/workflow list` now routes through `emitChatSurface` → pi.sendMessage,
        // so the catalogue payload lands in `sent` rather than `msgs`. Either
        // path counts as the handler having produced output.
        assert.ok(msgs.length > 0 || sent.length > 0);
        if (sent.length > 0) {
            const listPayload = sent.find(
                (m) =>
                    (m.details as { kind?: string } | undefined)?.kind ===
                    "list",
            );
            assert.ok(
                listPayload,
                "expected a chat-surface list message to be sent",
            );
        }
    });
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------

function makeInflightRun(id: string) {
    return {
        id,
        name: "test-wf",
        inputs: {},
        status: "running" as const,
        stages: [],
        startedAt: Date.now(),
    };
}

async function registerWorkflowCommand() {
    const { pi, commands, sent } = buildMockPi();
    addFactoryStubs(pi);
    const factoryModule =
        await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);
    const workflowCmd = commands.find((c) => c.name === "workflow");
    assert.notEqual(workflowCmd, undefined);
    return { pi, commands, sent, workflowCmd: workflowCmd! };
}

function recordTerminalRun(
    id: string,
    status: "completed" | "failed" | "killed",
    overrides: { name?: string; startedAt?: number; endedAt?: number } = {},
): void {
    store.recordRunStart({
        ...makeInflightRun(id),
        name: overrides.name ?? "terminal-wf",
        startedAt: overrides.startedAt ?? Date.now() - 10_000,
    });
    const completed = status === "completed";
    store.recordRunEnd(
        id,
        status,
        completed ? { ok: true } : undefined,
        completed ? undefined : status,
    );
    if (overrides.endedAt !== undefined) {
        const run = store.runs().find((r) => r.id === id);
        if (run) {
            run.endedAt = overrides.endedAt;
            run.durationMs = run.endedAt - run.startedAt;
        }
    }
}

function registerTestStageHandle(
    runId: string,
    stageId: string,
    status: StageControlHandle["status"] = "running",
): void {
    const handle: StageControlHandle = {
        runId,
        stageId,
        stageName: "worker",
        status,
        sessionId: undefined,
        sessionFile: undefined,
        isStreaming: false,
        messages: [],
        async ensureAttached(): Promise<void> {},
        async prompt(): Promise<void> {},
        async steer(): Promise<void> {},
        async followUp(): Promise<void> {},
        async pause(): Promise<void> {},
        async resume(): Promise<void> {},
        subscribe: () => () => {},
    };
    stageControlRegistry.register(handle);
}

describe("/workflow interrupt chat command", () => {
    test.each([["completed"], ["failed"], ["killed"]] as const)(
        "top-level /workflow kill <id> reports %s runs as already ended and retained",
        async (status) => {
            const runId = `slash-kill-${status}-${Date.now()}`;
            recordTerminalRun(runId, status);

            const { workflowCmd } = await registerWorkflowCommand();
            const msgs: string[] = [];
            let confirmCalls = 0;
            const ctx: PiCommandContext = {
                ui: {
                    notify: (message: string) => {
                        msgs.push(message);
                    },
                    confirm: async () => {
                        confirmCalls++;
                        return true;
                    },
                },
            };

            await workflowCmd.options.handler(`kill ${runId}`, ctx);

            const joined = msgs.join("\n");
            assert.equal(confirmCalls, 0);
            assert.match(joined, /already ended/i);
            assert.match(joined, /retained/i);
            assert.doesNotMatch(joined, /Run not found/);
            assert.equal(
                store.runs().find((r) => r.id === runId)?.status,
                status,
            );
        },
    );

    test("picker kill on a terminal row is a no-op", async () => {
        const runId = `picker-kill-ended-${Date.now()}`;
        recordTerminalRun(runId, "completed");

        const { workflowCmd } = await registerWorkflowCommand();
        const msgs: string[] = [];
        const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
            const tui: PiCustomOverlayFactoryTui = {
                requestRender: () => undefined,
            };
            const component = factoryArg(tui, {}, {}, () => undefined);
            if (component instanceof Promise)
                throw new Error("expected sync factory");
            if (options.overlay) {
                (component as PiCustomComponent).handleInput?.("y");
            } else {
                (component as PiCustomComponent).render(80);
                (component as PiCustomComponent).handleInput?.("x");
                (component as PiCustomComponent).handleInput?.("\x1b");
            }
            return undefined;
        };
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                custom: customFn,
            },
        };

        await workflowCmd.options.handler("connect", ctx);

        assert.deepEqual(msgs, []);
    });

    test("/workflow connect no-custom-UI fallback includes older retained terminal runs", async () => {
        const oldEndedAt = Date.now() - 2 * 60 * 60 * 1000;
        recordTerminalRun("old-connect-terminal-run", "completed", {
            name: "old-connect-terminal",
            startedAt: oldEndedAt - 5_000,
            endedAt: oldEndedAt,
        });

        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("connect", ctx);

        const joined = messages.join("\n");
        assert.match(joined, /old-connect-terminal/);
        assert.match(joined, /Picker requires an interactive UI surface/);
    });

    test("/workflow attach no-custom-UI fallback includes older retained terminal runs", async () => {
        const oldEndedAt = Date.now() - 2 * 60 * 60 * 1000;
        recordTerminalRun("old-attach-terminal-run", "failed", {
            name: "old-attach-terminal",
            startedAt: oldEndedAt - 5_000,
            endedAt: oldEndedAt,
        });

        const { workflowCmd } = await registerWorkflowCommand();
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("attach", ctx);

        const joined = messages.join("\n");
        assert.match(joined, /old-attach-terminal/);
        assert.match(joined, /Picker requires an interactive UI surface/);
    });

    test("top-level /workflow kill <id> kills and retains run without requiring confirmation", async () => {
        const runId = `kill-chat-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands, sent } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        let confirmCalls = 0;
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                confirm: async () => {
                    confirmCalls++;
                    return false;
                },
            },
        };

        await workflowCmd.options.handler(`kill ${runId}`, ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(confirmCalls, 0);
        assert.equal(run?.status, "killed");
        assert.equal(
            msgs.some((m) => m.includes("killed and retained for inspection")),
            true,
        );
        assert.equal(
            sent.some(
                (m) =>
                    (m.details as { kind?: string } | undefined)?.kind ===
                    "killed",
            ),
            true,
        );
    });

    test("top-level /workflow interrupt defaults to the active run", async () => {
        const runId = `interrupt-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                confirm: async () => false,
            },
        };

        await workflowCmd.options.handler("interrupt", ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(run?.status, "running");
        assert.equal(
            msgs.some((m) => m.includes("No active stages to interrupt")),
            true,
        );
    });

    test("top-level /workflow interrupt <id> reports no active stages without confirmation", async () => {
        const runId = `interrupt-chat-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        let confirmCalls = 0;
        const ctx: PiCommandContext = {
            ui: {
                notify: (message: string) => {
                    msgs.push(message);
                },
                confirm: async () => {
                    confirmCalls++;
                    return false;
                },
            },
        };

        await workflowCmd.options.handler(`interrupt ${runId}`, ctx);

        const run = store.runs().find((r) => r.id === runId);
        assert.equal(confirmCalls, 0);
        assert.equal(run?.status, "running");
        assert.equal(
            msgs.some((m) => m.includes("No active stages to interrupt")),
            true,
        );
    });

    test("top-level /workflow reload is skipped while workflows are in flight", async () => {
        const runId = `reload-slash-blocked-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("reload", ctx);

        assert.equal(
            messages.some((message) => message.includes("still in flight")),
            true,
        );
        assert.equal(
            messages.some((message) =>
                message.includes("Reloaded workflow resources"),
            ),
            false,
        );
    });

    test("top-level /workflow reload reports reload failures", async () => {
        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        pi.getWorkflowResources = () => {
            throw new Error("package loader unavailable");
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const { ctx, messages } = buildCtx();

        await workflowCmd.options.handler("reload", ctx);

        assert.equal(
            messages.some((message) =>
                message.includes("Reload failed: package loader unavailable"),
            ),
            true,
        );
    });

    test("top-level /workflow reload refreshes package workflow resources before discovery", async () => {
        const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-refresh-"));
        try {
            const existingWorkflow = join(dir, "existing.ts");
            const addedWorkflow = join(dir, "added.ts");
            await writeWorkflowFixture(existingWorkflow, "refresh-existing");
            await writeWorkflowFixture(addedWorkflow, "refresh-added");

            const { pi, commands } = buildMockPi();
            addFactoryStubs(pi);
            let refreshCalls = 0;
            pi.getWorkflowResources = () => [
                { path: existingWorkflow, enabled: true },
            ];
            pi.refreshWorkflowResources = async () => {
                refreshCalls += 1;
                return [
                    { path: existingWorkflow, enabled: true },
                    { path: addedWorkflow, enabled: true },
                ];
            };

            const factoryModule =
                await import("../../packages/workflows/src/extension/index.js");
            factoryModule.default(pi);

            const workflowCmd = commands.find((c) => c.name === "workflow")!;
            const { ctx, messages } = buildCtx();

            await workflowCmd.options.handler("reload", ctx);

            assert.equal(refreshCalls, 1);
            assert.equal(
                messages.some((message) =>
                    message.includes("Reloaded workflow resources."),
                ),
                true,
            );
            const completions =
                workflowCmd.options.getArgumentCompletions?.("refresh-added");
            assert.equal(
                completions?.some(
                    (completion) => completion.label === "refresh-added",
                ),
                true,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("top-level /workflow reload falls back to getWorkflowResources when refresh is unavailable", async () => {
        const dir = await mkdtemp(
            join(tmpdir(), "atomic-workflow-refresh-fallback-"),
        );
        try {
            const fallbackWorkflow = join(dir, "fallback.ts");
            await writeWorkflowFixture(fallbackWorkflow, "refresh-fallback");

            const { pi, commands } = buildMockPi();
            addFactoryStubs(pi);
            let getCalls = 0;
            pi.getWorkflowResources = () => {
                getCalls += 1;
                return [{ path: fallbackWorkflow, enabled: true }];
            };

            const factoryModule =
                await import("../../packages/workflows/src/extension/index.js");
            factoryModule.default(pi);

            const workflowCmd = commands.find((c) => c.name === "workflow")!;
            const { ctx, messages } = buildCtx();

            await workflowCmd.options.handler("reload", ctx);

            assert.equal(getCalls, 1);
            assert.equal(
                messages.some((message) =>
                    message.includes("Reloaded workflow resources."),
                ),
                true,
            );
            const completions =
                workflowCmd.options.getArgumentCompletions?.(
                    "refresh-fallback",
                );
            assert.equal(
                completions?.some(
                    (completion) => completion.label === "refresh-fallback",
                ),
                true,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------

describe("/workflow resume <runId> — overlay open + no legacy message", () => {
    test("seeds active run; /workflow resume calls overlay.open with overlay:true", async () => {
        const runId = `resume-slash-overlay-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const openCalls: Array<{ overlay: boolean }> = [];
        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        const customFn: PiCustomOverlayFunction = (
            factoryArg,
            options: PiCustomOverlayOptions,
        ) => {
            openCalls.push({ overlay: options.overlay });
            // Mirror Pi's runtime: invoke the factory and surface a handle
            // so the adapter has the same control surface it would in prod.
            const handle: PiOverlayHandle = {
                hide: () => undefined,
                setHidden: () => undefined,
                isHidden: () => false,
                focus: () => undefined,
                unfocus: () => undefined,
                isFocused: () => true,
            };
            options.onHandle?.(handle);
            const tui: PiCustomOverlayFactoryTui = {
                requestRender: () => undefined,
            };
            const component = factoryArg(tui, {}, {}, () => undefined);
            if (component instanceof Promise)
                throw new Error("expected sync factory");
            // Touch render so the GraphView's render path is exercised.
            (component as PiCustomComponent).render(80);
            return undefined;
        };
        pi.ui = {
            setWidget: () => {},
            custom: customFn,
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify: (m: string) => {
                    msgs.push(m);
                },
            },
        };

        await workflowCmd.options.handler(`resume ${runId}`, ctx);

        assert.ok(openCalls.length > 0);
        assert.equal(openCalls[0].overlay, true);
    });

    test("active run resume output does NOT include 'still active — no resume needed'", async () => {
        const runId = `resume-nomsg-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const { pi, commands } = buildMockPi();
        addFactoryStubs(pi);
        const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
            const handle: PiOverlayHandle = {
                hide: () => undefined,
                setHidden: () => undefined,
                isHidden: () => false,
                focus: () => undefined,
                unfocus: () => undefined,
                isFocused: () => true,
            };
            options.onHandle?.(handle);
            const tui: PiCustomOverlayFactoryTui = {
                requestRender: () => undefined,
            };
            factoryArg(tui, {}, {}, () => undefined);
            return undefined;
        };
        pi.ui = {
            setWidget: () => {},
            custom: customFn,
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        const workflowCmd = commands.find((c) => c.name === "workflow")!;
        const msgs: string[] = [];
        const ctx: PiCommandContext = {
            ui: {
                notify: (m: string) => {
                    msgs.push(m);
                },
            },
        };

        await workflowCmd.options.handler(`resume ${runId}`, ctx);

        assert.equal(
            msgs.every((m) => !m.includes("still active")),
            true,
        );
        assert.equal(
            msgs.every((m) => !m.includes("no resume needed")),
            true,
        );
    });
});

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------

describe("tool run-control actions", () => {
    function makeToolHandler() {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        return makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => undefined,
        );
    }

    function makeDispatchTrackingWorkflowHandler(): {
        handler: ReturnType<typeof makeExecuteWorkflowTool>;
        wasDispatched: () => boolean;
    } {
        let dispatched = false;
        const runtime = {
            dispatch: async () => {
                dispatched = true;
                return {
                    action: "run",
                    runId: "unexpected",
                    status: "running",
                    stages: [],
                };
            },
        } as unknown as ExtensionRuntime;

        return {
            handler: makeExecuteWorkflowTool(
                runtime,
                () => undefined,
                () => undefined,
            ),
            wasDispatched: () => dispatched,
        };
    }

    function restoreWorkflowStageGuard(
        previousGuard: string | undefined,
    ): void {
        if (previousGuard === undefined) {
            delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
            return;
        }
        process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
    }

    function assertWorkflowToolBlocked(
        result: WorkflowToolResult,
        wasDispatched: () => boolean,
    ): void {
        assert.equal(wasDispatched(), false);
        assert.match(
            (result as { error?: string }).error ?? "",
            /workflows cannot invoke workflows/,
        );
    }

    test("makeExecuteWorkflowTool blocks workflow tool execution from workflow-stage context", async () => {
        const { handler, wasDispatched } =
            makeDispatchTrackingWorkflowHandler();

        const result = await handler(
            { action: "run", workflow: "demo" },
            {
                orchestrationContext: {
                    kind: "workflow-stage",
                    workflowRunId: "run-1",
                    workflowStageId: "stage-1",
                    workflowStageName: "Stage",
                    constraints: {
                        disableWorkflowTool: true,
                        maxSubagentDepth: 1,
                    },
                },
            },
        );

        assertWorkflowToolBlocked(result, wasDispatched);
    });

    test("makeExecuteWorkflowTool blocks workflow tool execution from env workflow-stage guard", async () => {
        const previousGuard = process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
        const { handler, wasDispatched } =
            makeDispatchTrackingWorkflowHandler();

        try {
            process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = "1";
            const result = await handler(
                { action: "run", workflow: "demo" },
                {},
            );

            assertWorkflowToolBlocked(result, wasDispatched);
        } finally {
            restoreWorkflowStageGuard(previousGuard);
        }
    });

    test("registered workflow tool suppresses lifecycle notices while awaiting a headless run", async () => {
        const resource = await makeRegisteredWorkflowToolWithResource(
            "tool-headless-lifecycle.ts",
            `import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("tool-headless-lifecycle")
  .description("Completes under the registered workflow tool")
  .output("ok", { type: "unknown" })
  .output("source", { type: "unknown" })
  .run(async (ctx) => {
    await ctx.stage("terminal-stage").prompt("finish");
    return { ok: true, source: "tool" };
  })
  .compile();
`,
        );

        try {
            const result = await resource.tool.execute(
                "tool-headless-lifecycle-call",
                {
                    action: "run",
                    workflow: "tool-headless-lifecycle",
                    inputs: {},
                },
                undefined,
                undefined,
                { hasUI: false } as never,
            );

            assert.equal(result.details.action, "run");
            const run = result.details as Extract<
                WorkflowToolResult,
                { action: "run" }
            >;
            assert.equal(run.status, "completed");
            assert.deepEqual(run.result, { ok: true, source: "tool" });
            assert.equal(
                resource.sent.some(
                    (message) =>
                        message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
                ),
                false,
                "headless tool completion should not emit a lifecycle steer notice before returning",
            );
        } finally {
            await resource.cleanup();
        }
    });

    async function makeRegisteredWorkflowTool(): Promise<
        PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
    > {
        const { pi } = buildMockPi();
        addFactoryStubs(pi);
        let registered:
            | PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
            | undefined;
        pi.registerTool = (opts) => {
            registered = opts as unknown as PiToolOpts<
                WorkflowToolArgs,
                WorkflowToolResult
            >;
        };
        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);
        assert.ok(registered, "expected workflow tool registration");
        return registered;
    }

    async function makeRegisteredWorkflowToolWithResource(
        fileName: string,
        source: string,
    ): Promise<{
        tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
        sent: SentMessage[];
        cleanup: () => Promise<void>;
    }> {
        const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-tool-"));
        const filePath = join(dir, fileName);
        await writeFile(filePath, source, "utf8");

        const { pi, sent } = buildMockPi();
        addFactoryStubs(pi);
        pi.disableAsyncDiscovery = false;
        pi.getWorkflowResources = () => [{ path: filePath, enabled: true }];

        const events = new Map<
            string,
            Array<Parameters<NonNullable<ExtensionAPI["on"]>>[1]>
        >();
        pi.on = (event, handler) => {
            const handlers = events.get(event) ?? [];
            handlers.push(handler);
            events.set(event, handlers);
        };

        let registered:
            | PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
            | undefined;
        pi.registerTool = (opts) => {
            registered = opts as unknown as PiToolOpts<
                WorkflowToolArgs,
                WorkflowToolResult
            >;
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        for (const startHandler of events.get("session_start") ?? []) {
            await startHandler(
                {},
                { hasUI: false, ui: { notify: () => undefined } },
            );
        }

        assert.ok(registered, "expected workflow tool registration");
        return {
            tool: registered,
            sent,
            cleanup: () => rm(dir, { recursive: true, force: true }),
        };
    }

    function registerLiveStageHandle(
        runId: string,
        stageId: string,
        options?: {
            status?: StageControlHandle["status"];
            isStreaming?: boolean;
            messages?: StageControlHandle["messages"];
        },
    ): {
        followUps: string[];
        prompts: string[];
        steers: string[];
        dispose: () => void;
    } {
        const followUps: string[] = [];
        const prompts: string[] = [];
        const steers: string[] = [];
        const handle: StageControlHandle = {
            runId,
            stageId,
            stageName: "ask",
            status: options?.status ?? "running",
            sessionId: undefined,
            sessionFile: undefined,
            isStreaming: options?.isStreaming ?? false,
            messages: options?.messages ?? [],
            async ensureAttached(): Promise<void> {},
            async prompt(text: string): Promise<void> {
                prompts.push(text);
            },
            async steer(text: string): Promise<void> {
                steers.push(text);
            },
            async followUp(text: string): Promise<void> {
                followUps.push(text);
            },
            async pause(): Promise<void> {},
            async resume(): Promise<void> {},
            subscribe: () => () => {},
        };
        return {
            followUps,
            prompts,
            steers,
            dispose: stageControlRegistry.register(handle),
        };
    }

    async function waitForToolPrompt(
        runId: string,
        timeoutMs = 1000,
    ): Promise<{ stageId: string; promptId: string }> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const run = store
                .runs()
                .find((candidate) => candidate.id === runId);
            const stage = run?.stages.find(
                (candidate) => candidate.pendingPrompt !== undefined,
            );
            if (stage?.pendingPrompt)
                return { stageId: stage.id, promptId: stage.pendingPrompt.id };
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`pending prompt did not appear for run ${runId}`);
    }

    async function waitForToolRunEnded(
        runId: string,
        timeoutMs = 1000,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const run = store
                .runs()
                .find((candidate) => candidate.id === runId);
            if (run?.endedAt !== undefined) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`run ${runId} did not end`);
    }

    test("workflow tool answers ctx.ui.input prompts on running workflows", async () => {
        const def = defineWorkflow("tool-answers-ctx-ui-input")
            .output("answer", { type: "unknown" })
            .run(async (ctx) => {
                const answer = await ctx.ui.input("Value?");
                return { answer };
            })
            .compile();
        const runtime = createExtensionRuntime({
            registry: createRegistry([def]),
        });
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => undefined,
        );

        const started = await handler(
            { action: "run", workflow: "tool-answers-ctx-ui-input" },
            {} as never,
        );
        assert.equal(started.action, "run");
        const runId = (started as { runId: string }).runId;
        assert.ok(runId);

        const prompt = await waitForToolPrompt(runId);
        const stages = await handler(
            { action: "stages", runId, statusFilter: "all" },
            {} as never,
        );
        assert.equal(stages.action, "stages");
        const awaitingStage = (
            stages as {
                stages: Array<{
                    id: string;
                    status: string;
                    pendingPrompt?: { kind: string; message: string };
                }>;
            }
        ).stages.find((stage) => stage.id === prompt.stageId);
        assert.equal(awaitingStage?.status, "awaiting_input");
        assert.equal(awaitingStage?.pendingPrompt?.kind, "input");
        assert.equal(awaitingStage?.pendingPrompt?.message, "Value?");

        const sent = await handler(
            {
                action: "send",
                runId,
                stageId: prompt.stageId,
                text: "from workflow tool",
            },
            {} as never,
        );
        assert.equal(sent.action, "send");
        assert.equal(
            (sent as { delivery: string; status: string }).delivery,
            "answer",
        );
        assert.equal(
            (sent as { delivery: string; status: string }).status,
            "ok",
        );

        await waitForToolRunEnded(runId);
        const completed = store
            .runs()
            .find((candidate) => candidate.id === runId);
        assert.equal(completed?.status, "completed");
        assert.deepEqual(completed?.result, { answer: "from workflow tool" });
    });

    test("registered workflow tool content is reference-first with default preview and supports explicit transcript entries", async () => {
        const runId = `tool-content-transcript-${Date.now()}`;
        const longText = `start-${"x".repeat(180)}-sentinel-end`;
        const sessionFile = "C:\\Users\\atomic runner\\tool-content.jsonl";
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-tool-content-1",
            name: "summarize",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: longText,
            sessionId: "session-tool-content",
            sessionFile,
        });
        const tool = await makeRegisteredWorkflowTool();

        const textResult = await tool.execute(
            "tool-content-text",
            { action: "transcript", runId, stageId: "summarize" },
            undefined,
            undefined,
            {} as never,
        );
        const textBlock = textResult.content[0];
        assert.equal(textBlock?.type, "text");
        const textContent = textBlock.type === "text" ? textBlock.text : "";
        assert.equal(
            textContent.includes(longText),
            true,
            "default tool content should inline the small recent-entry preview",
        );
        assert.ok(textContent.includes(`sessionFile: ${sessionFile}`));
        assert.ok(textContent.includes(`sessionFileJson: ${JSON.stringify(sessionFile)}`));
        assert.ok(textContent.includes(`transcriptPath: ${sessionFile}`));
        assert.ok(textContent.includes(`transcriptPathJson: ${JSON.stringify(sessionFile)}`));
        assert.ok(textContent.includes("entries:"));
        assert.equal(textContent.includes("do not rewrite Windows backslashes"), false);
        assert.equal(
            textContent.includes("╭"),
            false,
            "tool content should not use clipped UI chrome",
        );
        const referenceDetails = textResult.details as Extract<
            WorkflowToolResult,
            { action: "transcript" }
        >;
        assert.equal(referenceDetails.entries.length, 1);
        assert.equal(referenceDetails.entryCount, 1);
        assert.equal(referenceDetails.entryLimit, 5);
        assert.equal(referenceDetails.transcriptPath, sessionFile);

        const explicitTextResult = await tool.execute(
            "tool-content-text-tail",
            { action: "transcript", runId, stageId: "summarize", tail: 1 },
            undefined,
            undefined,
            {} as never,
        );
        const explicitTextBlock = explicitTextResult.content[0];
        assert.equal(explicitTextBlock?.type, "text");
        const explicitTextContent = explicitTextBlock.type === "text"
            ? explicitTextBlock.text
            : "";
        assert.ok(
            explicitTextContent.includes(longText),
            "explicit tail should inline the requested transcript entry",
        );

        const defaultJsonResult = await tool.execute(
            "tool-content-json-default",
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                format: "json",
            },
            undefined,
            undefined,
            {} as never,
        );
        const defaultJsonBlock = defaultJsonResult.content[0];
        assert.equal(defaultJsonBlock?.type, "text");
        const defaultParsed = JSON.parse(
            defaultJsonBlock.type === "text" ? defaultJsonBlock.text : "{}",
        );
        assert.equal(defaultParsed.entries.length, 1);
        assert.equal(defaultParsed.entryCount, 1);
        assert.equal(defaultParsed.entryLimit, 5);
        assert.equal(defaultParsed.transcriptPath, sessionFile);
        assert.equal(
            (defaultJsonBlock.type === "text" ? defaultJsonBlock.text : "").includes(longText),
            true,
        );

        const jsonResult = await tool.execute(
            "tool-content-json",
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                tail: 1,
                format: "json",
            },
            undefined,
            undefined,
            {} as never,
        );
        const jsonBlock = jsonResult.content[0];
        assert.equal(jsonBlock?.type, "text");
        const parsed = JSON.parse(
            jsonBlock.type === "text" ? jsonBlock.text : "{}",
        );
        assert.equal(parsed.entries[0].text, longText);
        assert.equal(parsed.entryLimit, 1);
    });

    test("registered workflow tool content elides empty send targets", async () => {
        const tool = await makeRegisteredWorkflowTool();

        const result = await tool.execute(
            "tool-content-send-empty-target",
            { action: "send", text: "hello" },
            undefined,
            undefined,
            {} as never,
        );

        assert.equal(result.details.action, "send");
        const textBlock = result.content[0];
        assert.equal(textBlock?.type, "text");
        const textContent = textBlock.type === "text" ? textBlock.text : "";
        assert.match(textContent, /^send: noop — /);
        assert.doesNotMatch(textContent, /^send:\s{2,}noop/);
    });

    test("makeExecuteWorkflowTool kill without runId defaults to the active run", async () => {
        const runId = `kill-tool-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler({ action: "kill" }, {} as never);

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string; runId: string };
        assert.equal(r.status, "killed");
        assert.equal(r.runId, runId);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "killed",
        );
    });

    test("makeExecuteWorkflowTool kill supports unique run id prefixes", async () => {
        const runId = `kill-tool-prefix-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler(
            { action: "kill", runId: runId.slice(0, 12) },
            {} as never,
        );

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string; runId: string };
        assert.equal(r.status, "killed");
        assert.equal(r.runId, runId);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "killed",
        );
    });

    test("makeExecuteWorkflowTool kill supports all:true", async () => {
        const r1 = `kill-tool-all-1-${Date.now()}`;
        const r2 = `kill-tool-all-2-${Date.now()}`;
        const ended = `kill-tool-all-ended-${Date.now()}`;
        store.recordRunStart(makeInflightRun(r1));
        store.recordRunStart(makeInflightRun(r2));
        store.recordRunStart(makeInflightRun(ended));
        store.recordRunEnd(ended, "completed");
        const handler = makeToolHandler();

        const result = await handler(
            { action: "kill", all: true },
            {} as never,
        );

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string };
        assert.equal(r.status, "killed");
        assert.equal(
            store.runs().find((run) => run.id === r1)?.status,
            "killed",
        );
        assert.equal(
            store.runs().find((run) => run.id === r2)?.status,
            "killed",
        );
        assert.equal(
            store.runs().find((run) => run.id === ended)?.status,
            "completed",
        );
    });

    test("makeExecuteWorkflowTool pause all reports noop when no runs are in flight", async () => {
        const handler = makeToolHandler();

        const result = await handler(
            { action: "pause", all: true },
            {} as never,
        );

        assert.equal(result.action, "pause");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.runId, "--all");
        assert.equal(r.status, "noop");
        assert.match(r.message, /No in-flight runs to pause/);
    });

    test("makeExecuteWorkflowTool rejects all run-control with stageId", async () => {
        const runId = `pause-tool-all-stage-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler(
            { action: "pause", all: true, stageId: "stage-a" },
            {} as never,
        );

        assert.equal(result.action, "pause");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.runId, "--all");
        assert.equal(r.status, "noop");
        assert.match(r.message, /Cannot pause --all with a stageId/);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "running",
        );
    });

    test("makeExecuteWorkflowTool interrupt without runId defaults to the active run", async () => {
        const runId = `interrupt-tool-active-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        const handler = makeToolHandler();

        const result = await handler({ action: "interrupt" }, {} as never);

        assert.equal(result.action, "interrupt");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "noop");
        assert.equal(r.runId, runId);
        assert.match(r.message, /No active stages to interrupt/);
        assert.equal(
            store.runs().find((run) => run.id === runId)?.status,
            "running",
        );
    });

    test("makeExecuteWorkflowTool pause reports pause wording for inactive stages", async () => {
        const runId = `pause-tool-inactive-stage-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-paused-1",
            name: "paused-stage",
            status: "paused",
            parentIds: [],
            toolEvents: [],
        });
        const { dispose } = registerLiveStageHandle(runId, "stage-paused-1", {
            status: "paused",
        });
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "pause", runId, stageId: "paused-stage" },
                {} as never,
            );

            assert.equal(result.action, "pause");
            const r = result as {
                action: string;
                status: string;
                message: string;
            };
            assert.equal(r.status, "noop");
            assert.match(r.message, /No active stages to pause/);
            assert.doesNotMatch(r.message, /interrupt/);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool lists and inspects workflow stages", async () => {
        const runId = `stage-tool-list-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-running-1",
            name: "scan",
            status: "running",
            parentIds: [],
            toolEvents: [],
            sessionFile: "/tmp/scan-session.jsonl",
        });
        store.recordStageStart(runId, {
            id: "stage-failed-1",
            name: "review",
            status: "failed",
            parentIds: [],
            toolEvents: [],
            error: "boom",
            sessionFile: "/tmp/review-session.jsonl",
        });
        const handler = makeToolHandler();

        const listResult = await handler(
            { action: "stages", runId, statusFilter: "failed" },
            {} as never,
        );
        assert.equal(listResult.action, "stages");
        const list = listResult as {
            action: string;
            stages: Array<{
                name: string;
                status: string;
                error?: string;
                sessionFile?: string;
                transcriptPath?: string;
            }>;
        };
        assert.deepEqual(
            list.stages.map((stage) => stage.name),
            ["review"],
        );
        assert.equal(list.stages[0]!.status, "failed");
        assert.equal(list.stages[0]!.sessionFile, "/tmp/review-session.jsonl");
        assert.equal(list.stages[0]!.transcriptPath, "/tmp/review-session.jsonl");

        const detailResult = await handler(
            { action: "stage", runId, stageId: "scan" },
            {} as never,
        );
        assert.equal(detailResult.action, "stage");
        const detail = detailResult as {
            action: string;
            stage?: {
                id: string;
                name: string;
                status: string;
                sessionFile?: string;
                transcriptPath?: string;
            };
        };
        assert.equal(detail.stage?.id, "stage-running-1");
        assert.equal(detail.stage?.status, "running");
        assert.equal(detail.stage?.sessionFile, "/tmp/scan-session.jsonl");
        assert.equal(detail.stage?.transcriptPath, "/tmp/scan-session.jsonl");
    });

    test("makeExecuteWorkflowTool stages clones pending prompts", async () => {
        const runId = `stage-tool-prompt-clone-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-clone",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-clone", {
            id: "prompt-clone",
            kind: "select",
            message: "Original?",
            choices: ["yes"],
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler({ action: "stages", runId }, {} as never);

        assert.equal(result.action, "stages");
        const stages = result as {
            action: string;
            stages: Array<{
                pendingPrompt?: { message: string; choices?: string[] };
            }>;
        };
        assert.equal(stages.stages[0]?.pendingPrompt?.message, "Original?");
        stages.stages[0]!.pendingPrompt!.message = "Mutated";
        stages.stages[0]!.pendingPrompt!.choices!.push("no");
        const storedPrompt = store.runs().find((run) => run.id === runId)
            ?.stages[0]?.pendingPrompt;
        assert.equal(storedPrompt?.message, "Original?");
        assert.deepEqual(storedPrompt?.choices, ["yes"]);
    });

    test("makeExecuteWorkflowTool stage rejects all-run inspection", async () => {
        const handler = makeToolHandler();

        const result = await handler(
            { action: "stage", all: true },
            {} as never,
        );

        assert.equal(result.action, "stage");
        const stage = result as {
            action: string;
            runId: string;
            error?: string;
        };
        assert.equal(stage.runId, "--all");
        assert.match(stage.error ?? "", /requires a single run/);
    });

    test("makeExecuteWorkflowTool stages supports all stage status filters", async () => {
        const runId = `stage-tool-status-filters-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        for (const status of [
            "pending",
            "running",
            "awaiting_input",
            "paused",
            "blocked",
            "completed",
            "failed",
            "skipped",
        ] as const) {
            store.recordStageStart(runId, {
                id: `stage-${status}`,
                name: status,
                status,
                parentIds: [],
                toolEvents: [],
            });
        }
        const handler = makeToolHandler();

        const completedResult = await handler(
            { action: "stages", runId, statusFilter: "completed" },
            {} as never,
        );

        assert.equal(completedResult.action, "stages");
        const completed = completedResult as {
            action: string;
            stages: Array<{ name: string; status: string }>;
        };
        assert.deepEqual(
            completed.stages.map(({ name, status }) => ({ name, status })),
            [{ name: "completed", status: "completed" }],
        );
    });

    test("makeExecuteWorkflowTool stages reports missing and ambiguous run targets", async () => {
        const handler = makeToolHandler();

        const missing = await handler({ action: "stages" }, {} as never);
        assert.equal(missing.action, "stages");
        const missingStages = missing as {
            action: string;
            runId: string;
            error?: string;
            stages: unknown[];
        };
        assert.equal(missingStages.runId, "");
        assert.deepEqual(missingStages.stages, []);
        assert.match(missingStages.error ?? "", /No active run to inspect/);
        assert.match(
            renderResult(missing, { plain: true }),
            /No active run to inspect/,
        );

        store.recordRunStart(makeInflightRun("stages-ambiguous-run-a"));
        store.recordRunStart(makeInflightRun("stages-ambiguous-run-b"));
        const ambiguous = await handler(
            { action: "stages", runId: "stages-ambiguous-run" },
            {} as never,
        );
        assert.equal(ambiguous.action, "stages");
        const ambiguousStages = ambiguous as {
            action: string;
            runId: string;
            error?: string;
            stages: unknown[];
        };
        assert.equal(ambiguousStages.runId, "stages-ambiguous-run");
        assert.deepEqual(ambiguousStages.stages, []);
        assert.match(ambiguousStages.error ?? "", /Ambiguous run prefix/);
        assert.match(
            renderResult(ambiguous, { plain: true }),
            /Ambiguous run prefix/,
        );
    });

    test("makeExecuteWorkflowTool returns chronologically final snapshot result after tools", async () => {
        const runId = `stage-tool-transcript-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-1",
            name: "summarize",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 1,
                    endedAt: 2,
                },
            ],
            result: "done",
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "summarize",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            source: string;
            entries: Array<{ role: string; text?: string; output?: string }>;
            truncated: boolean;
            sessionFile?: string;
            transcriptPath?: string;
        };
        assert.equal(transcript.source, "snapshot");
        assert.equal(transcript.sessionFile, "/tmp/session.jsonl");
        assert.equal(transcript.transcriptPath, "/tmp/session.jsonl");
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [
            { role: "assistant", text: "done" },
        ]);
    });

    test("makeExecuteWorkflowTool applies limit and lets tail override limit", async () => {
        const runId = `stage-tool-transcript-limit-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-limit-1",
            name: "limited",
            status: "completed",
            parentIds: [],
            toolEvents: [
                { name: "one", output: "1", startedAt: 1, endedAt: 1 },
                { name: "two", output: "2", startedAt: 2, endedAt: 2 },
                { name: "three", output: "3", startedAt: 3, endedAt: 3 },
            ],
            result: "done",
            endedAt: 4,
        });
        const handler = makeToolHandler();

        const limited = await handler(
            {
                action: "transcript",
                runId,
                stageId: "limited",
                limit: 2,
                includeToolOutput: true,
            },
            {} as never,
        );
        assert.equal(limited.action, "transcript");
        const limitedTranscript = limited as {
            action: string;
            truncated: boolean;
            entries: Array<{ role: string; toolName?: string; text?: string }>;
        };
        assert.equal(limitedTranscript.truncated, true);
        assert.deepEqual(
            limitedTranscript.entries.map(
                (entry) => entry.toolName ?? entry.text,
            ),
            ["three", "done"],
        );

        const tailOverride = await handler(
            {
                action: "transcript",
                runId,
                stageId: "limited",
                limit: 3,
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );
        assert.equal(tailOverride.action, "transcript");
        const tailTranscript = tailOverride as {
            action: string;
            truncated: boolean;
            entries: Array<{ text?: string }>;
        };
        assert.equal(tailTranscript.truncated, true);
        assert.deepEqual(tailTranscript.entries, [
            { role: "assistant", text: "done", timestamp: 4 },
        ]);
    });

    test("makeExecuteWorkflowTool labels empty live handles as live transcript source", async () => {
        const runId = `stage-tool-live-empty-handle-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-live-empty-handle-1",
            name: "live-empty-handle",
            status: "running",
            parentIds: [],
            toolEvents: [],
            result: "snapshot-result",
            sessionId: "snapshot-session",
            sessionFile: "/tmp/live-empty-snapshot.jsonl",
        });
        const { dispose } = registerLiveStageHandle(
            runId,
            "stage-live-empty-handle-1",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "transcript", runId, stageId: "live-empty-handle" },
                {} as never,
            );

            assert.equal(result.action, "transcript");
            const transcript = result as {
                action: string;
                source: string;
                entries: unknown[];
                truncated: boolean;
                sessionId?: string;
                sessionFile?: string;
                transcriptPath?: string;
            };
            assert.equal(transcript.source, "live");
            assert.equal(transcript.truncated, false);
            assert.deepEqual(transcript.entries, []);
            assert.equal(
                (transcript as { entryLimit?: number }).entryLimit,
                5,
            );
            assert.equal(transcript.sessionId, "snapshot-session");
            assert.equal(transcript.sessionFile, "/tmp/live-empty-snapshot.jsonl");
            assert.equal(transcript.transcriptPath, "/tmp/live-empty-snapshot.jsonl");
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool uses error transcript source for target errors", async () => {
        const handler = makeToolHandler();

        const result = await handler(
            { action: "transcript", runId: "missing-run", stageId: "stage" },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            source: string;
            entries: Array<{ role: string; text?: string }>;
        };
        assert.equal(transcript.source, "error");
        assert.equal(transcript.entries[0]?.role, "notice");
    });

    test("makeExecuteWorkflowTool preserves empty live transcript text blocks", async () => {
        const runId = `stage-tool-live-empty-block-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-live-empty-block-1",
            name: "live-empty",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { dispose } = registerLiveStageHandle(
            runId,
            "stage-live-empty-block-1",
            {
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "" }],
                        timestamp: 1,
                    },
                ],
            },
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "transcript", runId, stageId: "live-empty", tail: 1 },
                {} as never,
            );

            assert.equal(result.action, "transcript");
            const transcript = result as {
                action: string;
                source: string;
                entries: Array<{ role: string; text?: string }>;
            };
            assert.equal(transcript.source, "live");
            assert.equal(transcript.entries.length, 1);
            assert.equal(transcript.entries[0]?.role, "user");
            assert.equal(transcript.entries[0]?.text, "");
            assert.equal(Object.hasOwn(transcript.entries[0]!, "text"), true);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool omits text for live non-text content blocks", async () => {
        const runId = `stage-tool-live-non-text-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-live-non-text-1",
            name: "live-non-text",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { dispose } = registerLiveStageHandle(
            runId,
            "stage-live-non-text-1",
            {
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "image", data: "", mimeType: "image/png" },
                        ],
                        timestamp: 1,
                    },
                ],
            },
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "transcript", runId, stageId: "live-non-text", tail: 1 },
                {} as never,
            );

            assert.equal(result.action, "transcript");
            const transcript = result as {
                action: string;
                source: string;
                entries: Array<{ role: string; text?: string }>;
            };
            assert.equal(transcript.source, "live");
            assert.equal(transcript.entries.length, 1);
            assert.equal(Object.hasOwn(transcript.entries[0]!, "text"), false);
            assert.equal(transcript.entries[0]?.text, undefined);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool returns no truncation marker for tail zero", async () => {
        const runId = `stage-tool-transcript-tail-zero-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-tail-zero-1",
            name: "tail-zero",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 1,
                    endedAt: 2,
                },
            ],
            result: "done",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "tail-zero",
                tail: 0,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: unknown[];
            truncated: boolean;
        };
        assert.equal(transcript.truncated, false);
        assert.deepEqual(transcript.entries, []);
    });

    test("makeExecuteWorkflowTool returns final snapshot error after timestamped tools", async () => {
        const runId = `stage-tool-transcript-error-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-error-1",
            name: "review",
            status: "failed",
            parentIds: [],
            toolEvents: [
                { name: "grep", output: "matches", startedAt: 10, endedAt: 11 },
            ],
            error: "boom",
            endedAt: 12,
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "review",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string; timestamp?: number }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [
            { role: "notice", text: "boom", timestamp: 12 },
        ]);
    });

    test("makeExecuteWorkflowTool keeps terminal snapshot entries after tools for tied timestamps", async () => {
        const runId = `stage-tool-transcript-tie-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-tie-1",
            name: "tie",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 4,
                    endedAt: 5,
                },
            ],
            result: "finished",
            endedAt: 5,
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "tie",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string; timestamp?: number }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [
            { role: "assistant", text: "finished", timestamp: 5 },
        ]);
    });

    test("makeExecuteWorkflowTool preserves empty final snapshot result after tools", async () => {
        const runId = `stage-tool-transcript-empty-result-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-empty-result-1",
            name: "empty-result",
            status: "completed",
            parentIds: [],
            toolEvents: [
                {
                    name: "read",
                    output: "file contents",
                    startedAt: 1,
                    endedAt: 2,
                },
            ],
            result: "",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "empty-result",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [{ role: "assistant", text: "" }]);
    });

    test("makeExecuteWorkflowTool preserves empty final snapshot error after tools", async () => {
        const runId = `stage-tool-transcript-empty-error-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-transcript-empty-error-1",
            name: "empty-error",
            status: "failed",
            parentIds: [],
            toolEvents: [
                { name: "grep", output: "matches", startedAt: 10, endedAt: 11 },
            ],
            error: "",
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "transcript",
                runId,
                stageId: "empty-error",
                tail: 1,
                includeToolOutput: true,
            },
            {} as never,
        );

        assert.equal(result.action, "transcript");
        const transcript = result as {
            action: string;
            entries: Array<{ role: string; text?: string }>;
            truncated: boolean;
        };
        assert.equal(transcript.truncated, true);
        assert.deepEqual(transcript.entries, [{ role: "notice", text: "" }]);
    });

    test("makeExecuteWorkflowTool answers stage pending prompts", async () => {
        const runId = `stage-tool-send-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-1",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-1", {
            id: "prompt-1",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "send", runId, stageId: "ask", text: "42" },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "ok");
        assert.match(send.message, /Answered prompt/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-1");
        assert.equal(stage?.pendingPrompt, undefined);
        assert.equal(
            store.getStagePromptAnswer(runId, "stage-prompt-1")?.answerSource,
            "workflow_tool",
        );
    });

    test("makeExecuteWorkflowTool tags brokered prompt answers as workflow-tool sourced", async () => {
        const runId = `stage-tool-send-broker-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-broker-prompt",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        const adapter = buildStagePromptAdapter(
            "ask-1",
            "ask_user_question",
            {
                questions: [
                    {
                        question: "What color?",
                        options: [{ label: "Red" }, { label: "Blue" }],
                    },
                ],
            },
            1,
        )!;
        stageUiBroker.provideStagePrompt(runId, "stage-broker-prompt", adapter);
        const events: Array<{ answerSource?: string }> = [];
        const unsubscribe = stageUiBroker.onStagePromptResolved((event) => {
            if (
                event.runId === runId &&
                event.stageId === "stage-broker-prompt"
            ) {
                events.push({ answerSource: event.answerSource });
            }
        });
        const pending = stageUiBroker.requestCustomUi(
            runId,
            "stage-broker-prompt",
            () => ({
                render: () => [],
                invalidate: () => {},
            }),
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "send", runId, stageId: "ask", text: "Blue" },
                {} as never,
            );
            await pending;

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "answer");
            assert.equal(send.status, "ok");
            assert.match(send.message, /Answered input request/);
            assert.equal(events[0]?.answerSource, "workflow_tool");
        } finally {
            unsubscribe();
        }
    });

    test("makeExecuteWorkflowTool leaves pending prompts untouched when payload is omitted", async () => {
        const runId = `stage-tool-send-omitted-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-omitted",
            name: "ask-omitted",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-omitted", {
            id: "prompt-omitted",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "send", runId, stageId: "ask-omitted" },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "noop");
        assert.match(send.message, /requires text, response, or message/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-omitted");
        assert.equal(stage?.pendingPrompt?.id, "prompt-omitted");
    });

    test("makeExecuteWorkflowTool delivery answer without a pending prompt does not fall through to live followUp", async () => {
        const runId = `stage-tool-send-answer-no-prompt-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-no-prompt",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, dispose } = registerLiveStageHandle(
            runId,
            "stage-no-prompt",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    delivery: "answer",
                    text: "42",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "answer");
            assert.equal(send.status, "noop");
            assert.match(send.message, /No pending prompt/);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool auto delivery without a targeted prompt still queues a live followUp", async () => {
        const runId = `stage-tool-send-auto-live-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-auto-live",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, dispose } = registerLiveStageHandle(
            runId,
            "stage-auto-live",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                { action: "send", runId, stageId: "ask", text: "next" },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "followUp");
            assert.equal(send.status, "ok");
            assert.deepEqual(followUps, ["next"]);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool sends explicit prompt delivery to live handles", async () => {
        const runId = `stage-tool-send-prompt-live-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-live",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, prompts, steers, dispose } = registerLiveStageHandle(
            runId,
            "stage-prompt-live",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    delivery: "prompt",
                    text: "start next",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
            };
            assert.equal(send.delivery, "prompt");
            assert.equal(send.status, "ok");
            assert.deepEqual(prompts, ["start next"]);
            assert.deepEqual(steers, []);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool sends explicit steer delivery to live handles", async () => {
        const runId = `stage-tool-send-steer-live-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-steer-live",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const { followUps, prompts, steers, dispose } = registerLiveStageHandle(
            runId,
            "stage-steer-live",
            { isStreaming: true },
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    delivery: "steer",
                    text: "adjust course",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
            };
            assert.equal(send.delivery, "steer");
            assert.equal(send.status, "ok");
            assert.deepEqual(steers, ["adjust course"]);
            assert.deepEqual(prompts, []);
            assert.deepEqual(followUps, []);
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool promptId mismatch does not fall through to live followUp", async () => {
        const runId = `stage-tool-send-prompt-mismatch-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-mismatch",
            name: "ask",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-mismatch", {
            id: "prompt-real",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const { followUps, dispose } = registerLiveStageHandle(
            runId,
            "stage-prompt-mismatch",
        );
        const handler = makeToolHandler();

        try {
            const result = await handler(
                {
                    action: "send",
                    runId,
                    stageId: "ask",
                    promptId: "prompt-missing",
                    text: "42",
                },
                {} as never,
            );

            assert.equal(result.action, "send");
            const send = result as {
                action: string;
                delivery: string;
                status: string;
                message: string;
            };
            assert.equal(send.delivery, "answer");
            assert.equal(send.status, "noop");
            assert.match(
                send.message,
                /No matching pending prompt prompt-missing/,
            );
            assert.deepEqual(followUps, []);
            const stage = store
                .runs()
                .find((run) => run.id === runId)
                ?.stages.find((s) => s.id === "stage-prompt-mismatch");
            assert.equal(stage?.pendingPrompt?.id, "prompt-real");
        } finally {
            dispose();
        }
    });

    test("makeExecuteWorkflowTool treats explicit empty text prompt payload as an answer", async () => {
        const runId = `stage-tool-send-empty-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-empty",
            name: "ask-empty",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-empty", {
            id: "prompt-empty",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "send", runId, stageId: "ask-empty", text: "" },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "ok");
        assert.match(send.message, /Answered prompt/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-empty");
        assert.equal(stage?.pendingPrompt, undefined);
    });

    test("makeExecuteWorkflowTool treats explicit empty response prompt payload as an answer", async () => {
        const runId = `stage-tool-send-empty-response-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-empty-response",
            name: "ask-empty-response",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-empty-response", {
            id: "prompt-empty-response",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "send",
                runId,
                stageId: "ask-empty-response",
                response: "",
            },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "ok");
        assert.match(send.message, /Answered prompt/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-empty-response");
        assert.equal(stage?.pendingPrompt, undefined);
    });

    test("makeExecuteWorkflowTool ignores explicit undefined prompt payloads", async () => {
        const runId = `stage-tool-send-undefined-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-prompt-undefined",
            name: "ask-undefined",
            status: "awaiting_input",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStagePendingPrompt(runId, "stage-prompt-undefined", {
            id: "prompt-undefined",
            kind: "input",
            message: "Value?",
            createdAt: Date.now(),
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "send",
                runId,
                stageId: "ask-undefined",
                text: undefined,
            },
            {} as never,
        );

        assert.equal(result.action, "send");
        const send = result as {
            action: string;
            delivery: string;
            status: string;
            message: string;
        };
        assert.equal(send.delivery, "answer");
        assert.equal(send.status, "noop");
        assert.match(send.message, /requires text, response, or message/);
        const stage = store
            .runs()
            .find((run) => run.id === runId)
            ?.stages.find((s) => s.id === "stage-prompt-undefined");
        assert.equal(stage?.pendingPrompt?.id, "prompt-undefined");
    });

    test("makeExecuteWorkflowTool reloads directly without sending a literal slash command", async () => {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        let reloads = 0;
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            async () => {
                reloads += 1;
            },
        );
        const sent: string[] = [];

        const result = await handler({ action: "reload", reason: "test" }, {
            // Sentinel-only property: production ExtensionAPI does not expose this.
            sendUserMessage: (content: string) => {
                sent.push(content);
            },
        } as never);

        assert.equal(result.action, "reload");
        const reload = result as {
            action: string;
            status: string;
            message: string;
        };
        assert.equal(reload.status, "ok");
        assert.match(reload.message, /Reloaded workflow resources/);
        assert.equal(reloads, 1);
        assert.deepEqual(sent, []);
    });

    test("registered workflow tool reload refreshes package workflow resources before discovery", async () => {
        const dir = await mkdtemp(
            join(tmpdir(), "atomic-workflow-tool-refresh-"),
        );
        try {
            const addedWorkflow = join(dir, "tool-refresh-added.ts");
            await writeWorkflowFixture(addedWorkflow, "tool-refresh-added");

            const { pi, commands } = buildMockPi();
            addFactoryStubs(pi);
            let refreshCalls = 0;
            pi.getWorkflowResources = () => [];
            pi.refreshWorkflowResources = async () => {
                refreshCalls += 1;
                return [{ path: addedWorkflow, enabled: true }];
            };
            let registered:
                | PiToolOpts<WorkflowToolArgs, WorkflowToolResult>
                | undefined;
            pi.registerTool = (opts) => {
                registered = opts as unknown as PiToolOpts<
                    WorkflowToolArgs,
                    WorkflowToolResult
                >;
            };

            const factoryModule =
                await import("../../packages/workflows/src/extension/index.js");
            factoryModule.default(pi);
            assert.ok(registered, "expected workflow tool registration");

            const result = await registered.execute(
                "tool-reload-refresh-call",
                { action: "reload", reason: "manifest changed" },
                undefined,
                undefined,
                {} as never,
            );

            assert.equal(refreshCalls, 1);
            assert.equal(result.details.action, "reload");
            const reload = result.details as Extract<
                WorkflowToolResult,
                { action: "reload" }
            >;
            assert.equal(reload.status, "ok");
            assert.match(reload.message, /Reloaded workflow resources/);
            const workflowCmd = commands.find(
                (command) => command.name === "workflow",
            );
            assert.ok(workflowCmd, "expected workflow command registration");
            const completions =
                workflowCmd.options.getArgumentCompletions?.(
                    "tool-refresh-added",
                ) ?? [];
            assert.equal(
                completions.some(
                    (completion) => completion.label === "tool-refresh-added",
                ),
                true,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("makeExecuteWorkflowTool treats explicit empty reload reason as omitted", async () => {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => undefined,
        );

        const result = await handler(
            { action: "reload", reason: "" },
            {} as never,
        );

        assert.equal(result.action, "reload");
        const reload = result as {
            action: string;
            status: string;
            message: string;
        };
        assert.equal(reload.status, "ok");
        assert.equal(reload.message, "Reloaded workflow resources.");
    });

    test("makeExecuteWorkflowTool reload is skipped while workflows are in flight", async () => {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        let reloads = 0;
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => {
                reloads += 1;
            },
        );
        store.recordRunStart(makeInflightRun(`reload-blocked-${Date.now()}`));

        const result = await handler(
            { action: "reload", reason: "test" },
            {} as never,
        );

        assert.equal(result.action, "reload");
        const reload = result as {
            action: string;
            status: string;
            message: string;
        };
        assert.equal(reload.status, "noop");
        assert.match(reload.message, /still in flight/);
        assert.equal(reloads, 0);
    });

    test("makeExecuteWorkflowTool reload surfaces callback failures as noop", async () => {
        const registry = createRegistry([]);
        const runtime = createExtensionRuntime({ registry });
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            async () => {
                throw new Error("bad workflow config");
            },
        );

        const result = await handler(
            { action: "reload", reason: "test" },
            {} as never,
        );

        assert.equal(result.action, "reload");
        const reload = result as {
            action: string;
            status: string;
            message: string;
        };
        assert.equal(reload.status, "noop");
        assert.match(reload.message, /Reload failed: bad workflow config/);
    });

    test("makeExecuteWorkflowTool returns ambiguous run-prefix messages", async () => {
        store.recordRunStart(makeInflightRun("ambiguous-run-a"));
        store.recordRunStart(makeInflightRun("ambiguous-run-b"));
        const handler = makeToolHandler();

        const result = await handler(
            { action: "kill", runId: "ambiguous-run" },
            {} as never,
        );

        assert.equal(result.action, "kill");
        const r = result as { action: string; status: string; message: string };
        assert.equal(r.status, "noop");
        assert.match(r.message, /Ambiguous run prefix/);
        assert.equal(
            store.runs().some((run) => run.id === "ambiguous-run-a"),
            true,
        );
        assert.equal(
            store.runs().some((run) => run.id === "ambiguous-run-b"),
            true,
        );
    });

    test("makeExecuteWorkflowTool resume accepts run prefixes, stage names, and messages", async () => {
        const runId = `resume-tool-stage-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-abc123",
            name: "review-stage",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const handler = makeToolHandler();

        const result = await handler(
            {
                action: "resume",
                runId: runId.slice(0, 12),
                stageId: "review-stage",
                message: "continue please",
            },
            {} as never,
        );

        assert.equal(result.action, "resume");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "ok");
        assert.equal(r.runId, runId);
        assert.match(r.message, /Snapshot available/);
    });

    test("makeExecuteWorkflowTool resume against in-flight run returns status:'ok'", async () => {
        const runId = `resume-tool-ok-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        const handler = makeToolHandler();

        const result = await handler({ action: "resume", runId }, {} as never);

        assert.equal(result.action, "resume");
        const r = result as { action: string; status: string; runId: string };
        assert.equal(r.status, "ok");
        assert.equal(r.runId, runId);
    });

    test("runtime runDirect classifies direct pre-run model auth failures", async () => {
        const runtime = createExtensionRuntime({
            registry: createRegistry([]),
            models: {
                async listModels() {
                    throw { message: "request failed", status: 401 };
                },
            },
        });

        const result = await runtime.runDirect({
            task: { name: "scout", task: "inspect repo", model: "openai/gpt" },
            async: true,
        });

        assert.equal(result.status, "failed");
        assert.equal(result.error, WORKFLOW_AUTH_FAILURE_MESSAGE);
    });

    test("makeExecuteWorkflowTool resume rejects ambiguous stage prefixes", async () => {
        const runId = `resume-tool-ambiguous-stage-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        for (const stageId of ["ambiguous-stage-aaa", "ambiguous-stage-bbb"]) {
            store.recordStageStart(runId, {
                id: stageId,
                name: stageId,
                status: "failed",
                parentIds: [],
                toolEvents: [],
            });
            store.recordStageEnd(runId, {
                id: stageId,
                name: stageId,
                status: "failed",
                parentIds: [],
                toolEvents: [],
                error: "boom",
            });
        }
        store.recordRunEnd(runId, "failed", undefined, "boom", {
            resumable: true,
            failedStageId: "ambiguous-stage-aaa",
        });
        const handler = makeToolHandler();

        const result = await handler(
            { action: "resume", runId, stageId: "ambiguous-stage" },
            {} as never,
        );

        assert.equal(result.action, "resume");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "noop");
        assert.equal(r.runId, runId);
        assert.match(r.message, /Ambiguous stage identifier/);
        assert.match(r.message, /ambiguous-stage-aaa/);
        assert.match(r.message, /ambiguous-stage-bbb/);
    });

    test("makeExecuteWorkflowTool resume starts linked continuation for failed resumable workflow", async () => {
        const sourceRunId = `resume-tool-source-${Date.now()}`;
        const def = defineWorkflow("tool-resume-wf")
            .output("first", { type: "unknown" })
            .output("second", { type: "unknown" })
            .run(async (ctx) => {
                const first = await ctx.stage("first").prompt("first");
                const second = await ctx
                    .stage("second")
                    .prompt(`second:${first}`);
                return { first, second };
            })
            .compile();

        store.recordRunStart({
            id: sourceRunId,
            name: def.name,
            inputs: {},
            status: "running",
            startedAt: Date.now(),
            stages: [],
        });
        store.recordStageStart(sourceRunId, {
            id: "old-first",
            name: "first",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: "first-old",
        });
        store.recordStageEnd(sourceRunId, {
            id: "old-first",
            name: "first",
            status: "completed",
            parentIds: [],
            toolEvents: [],
            result: "first-old",
        });
        store.recordStageStart(sourceRunId, {
            id: "old-second",
            name: "second",
            status: "failed",
            parentIds: ["old-first"],
            toolEvents: [],
            error: "rate limit",
        });
        store.recordStageEnd(sourceRunId, {
            id: "old-second",
            name: "second",
            status: "failed",
            parentIds: ["old-first"],
            toolEvents: [],
            error: "rate limit",
        });
        store.recordRunEnd(sourceRunId, "failed", undefined, "rate limit", {
            resumable: true,
            failedStageId: "old-second",
            failureKind: "rate_limit",
        });

        const calls: string[] = [];
        const runtime = createExtensionRuntime({
            registry: createRegistry([def]),
            store,
            adapters: {
                prompt: {
                    prompt: async (text) => {
                        calls.push(text);
                        return "second-new";
                    },
                },
            },
        });
        const handler = makeExecuteWorkflowTool(
            runtime,
            () => undefined,
            () => undefined,
        );

        const result = await handler(
            { action: "resume", runId: sourceRunId },
            {} as never,
        );

        assert.equal(result.action, "resume");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "running");
        assert.notEqual(r.runId, sourceRunId);
        assert.match(r.message, /Resuming failed workflow/);
        await jobTracker.get(r.runId)?.promise;
        assert.deepEqual(calls, ["second:first-old"]);
        const continued = store.runs().find((run) => run.id === r.runId)!;
        assert.equal(continued.status, "completed");
        assert.equal(continued.resumedFromRunId, sourceRunId);
        assert.equal(continued.stages[0]!.replayed, true);
        assert.equal(
            store.runs().find((run) => run.id === sourceRunId)!.status,
            "failed",
        );
    });

    test("makeExecuteWorkflowTool resume surfaces workflow_not_found for failed resumable run without registry definition", async () => {
        const runId = `resume-tool-failed-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));
        store.recordStageStart(runId, {
            id: "stage-a",
            name: "stage-a",
            status: "failed",
            parentIds: [],
            toolEvents: [],
        });
        store.recordStageEnd(runId, {
            id: "stage-a",
            name: "stage-a",
            status: "failed",
            parentIds: [],
            toolEvents: [],
            error: "boom",
        });
        store.recordRunEnd(runId, "failed", undefined, "boom", {
            resumable: true,
            failedStageId: "stage-a",
        });

        const handler = makeToolHandler();

        const result = await handler({ action: "resume", runId }, {} as never);

        assert.equal(result.action, "resume");
        const r = result as {
            action: string;
            status: string;
            runId: string;
            message: string;
        };
        assert.equal(r.status, "noop");
        assert.equal(r.runId, runId);
        assert.match(r.message, /workflow_not_found/);
    });
});

// ---------------------------------------------------------------------------
// Non-interactive (-p) mode: /workflow remains available, but UI pickers are
// skipped and deterministic validation errors are surfaced instead.
// Issue #1156 specifically guards against `atomic -p '/workflow <name>'`
// silently exiting 0 with empty stdout/stderr after a terminal success/failure.
// ---------------------------------------------------------------------------

describe("/workflow command in non-interactive (-p) mode (#1156 regressions)", () => {
    async function registerWorkflowCommand(): Promise<{
        handler: NonNullable<PiCommandOptions["handler"]>;
        sent: SentMessage[];
    }> {
        const { pi, commands, sent } = buildMockPi();
        await runFactory(pi);
        const cmd = commands.find((c) => c.name === "workflow");
        assert.ok(cmd, "expected /workflow command registration");
        return { handler: cmd.options.handler, sent };
    }

    type ExtensionEventHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];
    type NotificationType = "info" | "warning" | "error";
    interface RecordedNotification {
        message: string;
        type?: NotificationType;
    }

    function commandCtx(hasUI: boolean | undefined): {
        ctx: PiCommandContext;
        messages: string[];
        notifications: RecordedNotification[];
        pickerCalls: string[];
    } {
        const messages: string[] = [];
        const notifications: RecordedNotification[] = [];
        const pickerCalls: string[] = [];
        const ctx: PiCommandContext = {
            ...(hasUI === undefined ? {} : { hasUI }),
            ui: {
                notify: (msg: string, type?: NotificationType) => {
                    messages.push(msg);
                    notifications.push({ message: msg, type });
                },
                setEditorComponent: () => {
                    pickerCalls.push("inline");
                    throw new Error("inline form unsupported in test");
                },
                custom: async (factory) => {
                    pickerCalls.push("overlay");
                    const component = await factory(
                        { requestRender: () => undefined },
                        {},
                        {},
                        () => undefined,
                    );
                    component.dispose?.();
                    return undefined;
                },
            },
        };
        return { ctx, messages, notifications, pickerCalls };
    }

    function headlessNoOpCtx(): PiCommandContext {
        return {
            hasUI: false,
            ui: { notify: () => undefined },
        };
    }

    function isHeadlessWorkflowCommandError(
        pattern: RegExp,
    ): (error: unknown) => boolean {
        return (error: unknown): boolean =>
            error instanceof Error &&
            error.name === "WorkflowHeadlessCommandError" &&
            pattern.test(error.message);
    }

    async function assertRejectsHeadlessCommand(
        action: () => Promise<void> | void,
        messagePattern: RegExp,
    ): Promise<void> {
        await assert.rejects(async () => {
            await action();
        }, isHeadlessWorkflowCommandError(messagePattern));
    }

    function chatSurfacePayload(
        message: SentMessage,
    ): ChatSurfacePayload | undefined {
        const details = message.details;
        if (
            typeof details !== "object" ||
            details === null ||
            !("kind" in details)
        ) {
            return undefined;
        }
        return details as ChatSurfacePayload;
    }

    function commandOutputMessages(
        sent: readonly SentMessage[],
    ): SentMessage[] {
        return sent.filter(
            (message) =>
                message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
        );
    }

    async function registerWorkflowCommandWithResource(
        fileName: string,
        source: string,
    ): Promise<{
        handler: NonNullable<PiCommandOptions["handler"]>;
        sent: SentMessage[];
        cleanup: () => Promise<void>;
    }> {
        const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-slash-"));
        const filePath = join(dir, fileName);
        await writeFile(filePath, source, "utf8");

        const { pi, commands, sent } = buildMockPi();
        addFactoryStubs(pi);
        pi.disableAsyncDiscovery = false;
        pi.getWorkflowResources = () => [{ path: filePath, enabled: true }];

        const events = new Map<string, ExtensionEventHandler[]>();
        pi.on = (event, handler) => {
            const handlers = events.get(event) ?? [];
            handlers.push(handler);
            events.set(event, handlers);
        };

        const factoryModule =
            await import("../../packages/workflows/src/extension/index.js");
        factoryModule.default(pi);

        for (const startHandler of events.get("session_start") ?? []) {
            await startHandler({}, { ui: { notify: () => undefined } });
        }

        const cmd = commands.find((c) => c.name === "workflow");
        assert.ok(cmd, "expected /workflow command registration");
        return {
            handler: cmd.options.handler,
            sent,
            cleanup: () => rm(dir, { recursive: true, force: true }),
        };
    }

    test("workflowPolicyFromContext derives non-interactive policy from hasUI false", () => {
        assert.equal(
            workflowPolicyFromContext({ hasUI: false }).mode,
            "non_interactive",
        );
        assert.equal(
            workflowPolicyFromContext({ hasUI: false }).allowInputPicker,
            false,
        );
        assert.equal(
            workflowPolicyFromContext({ hasUI: true }).mode,
            "interactive",
        );
        assert.equal(workflowPolicyFromContext({}).mode, "interactive");
    });

    test("/workflow list proceeds when no UI is available and emits printable content", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(false);

        await handler("list", ctx);

        assert.equal(messages.length, 0);
        assert.ok(
            sent.length > 0,
            "expected /workflow list to emit a chat surface",
        );
        const listMessage = sent.find(
            (message) => chatSurfacePayload(message)?.kind === "list",
        );
        assert.ok(listMessage, "expected a list chat-surface message");
        assert.match(listMessage.content ?? "", /WORKFLOWS/);
        assert.match(
            listMessage.content ?? "",
            /deep-research-codebase|ralph|open-claude-design/,
        );
        assert.doesNotMatch(
            listMessage.content ?? "",
            /^workflows · \d+ registered$/,
        );
    });

    test("/workflow status emits printable list and detail content when no UI is available", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const runId = `headless-printable-status-${Date.now()}`;
        recordTerminalRun(runId, "completed", {
            name: "headless-printable-workflow",
        });

        await handler("status", headlessNoOpCtx());
        await handler(`status ${runId}`, headlessNoOpCtx());

        const statusMessage = sent.find(
            (message) => chatSurfacePayload(message)?.kind === "status",
        );
        assert.ok(statusMessage, "expected a status chat-surface message");
        assert.match(statusMessage.content ?? "", /BACKGROUND/);
        assert.match(
            statusMessage.content ?? "",
            /headless-printable-workflow/,
        );
        assert.match(statusMessage.content ?? "", /completed/);
        assert.match(statusMessage.content ?? "", new RegExp(runId));
        assert.doesNotMatch(
            statusMessage.content ?? "",
            /^status · \d+ runs?$/,
        );

        const detailMessage = sent.find(
            (message) => chatSurfacePayload(message)?.kind === "detail",
        );
        assert.ok(detailMessage, "expected a detail chat-surface message");
        assert.match(detailMessage.content ?? "", /RUN/);
        assert.match(
            detailMessage.content ?? "",
            /headless-printable-workflow/,
        );
        assert.match(detailMessage.content ?? "", /completed/);
        assert.match(detailMessage.content ?? "", new RegExp(runId));
        assert.doesNotMatch(detailMessage.content ?? "", /^run detail · /);
    });

    test("/workflow inputs <known> emits displayable command output in headless mode", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(false);

        await handler("inputs ralph", ctx);

        assert.deepEqual(messages, []);
        assert.equal(
            store.runs().length,
            0,
            "inputs inspection must not dispatch a run",
        );
        const outputs = commandOutputMessages(sent);
        assert.equal(outputs.length, 1);
        const output = outputs[0]!;
        assert.equal(output.display, true);
        assert.equal(typeof output.content, "string");
        assert.match(
            output.content ?? "",
            /INPUTS FOR RALPH|Inputs for "ralph":/,
        );
        assert.deepEqual(output.details, {
            command: "inputs",
            workflowName: "ralph",
        });
    });

    test("/workflow <known> --help emits displayable command output and skips dispatch headlessly", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(false);

        await handler("deep-research-codebase --help", ctx);

        assert.deepEqual(messages, []);
        assert.equal(store.runs().length, 0, "--help must not dispatch a run");
        assert.equal(
            sent.some(
                (message) => chatSurfacePayload(message)?.kind === "dispatch",
            ),
            false,
            "--help must not emit the run dispatch surface",
        );
        const outputs = commandOutputMessages(sent);
        assert.equal(outputs.length, 1);
        const output = outputs[0]!;
        assert.equal(output.display, true);
        assert.equal(typeof output.content, "string");
        assert.match(
            output.content ?? "",
            /INPUTS FOR DEEP-RESEARCH-CODEBASE|Inputs for "deep-research-codebase":/,
        );
        assert.deepEqual(output.details, {
            command: "help",
            workflowName: "deep-research-codebase",
        });
    });

    test("/workflow rejects missing required input in headless mode without relying on notify", async () => {
        const { handler } = await registerWorkflowCommand();
        const { ctx, messages, pickerCalls } = commandCtx(false);

        await assertRejectsHeadlessCommand(
            () => handler("deep-research-codebase", ctx),
            /required input "prompt" not provided/,
        );

        assert.deepEqual(pickerCalls, []);
        assert.deepEqual(messages, []);
    });

    test("/workflow rejects unknown workflow in headless mode with a visible command error", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("ghost-workflow", headlessNoOpCtx()),
            /Workflow not found: ghost-workflow/,
        );
    });

    test("/workflow status <missing> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("status definitely-missing", headlessNoOpCtx()),
            /Run not found: definitely-missing/,
        );
    });

    test("/workflow connect <missing> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("connect definitely-missing", headlessNoOpCtx()),
            /Run not found: definitely-missing/,
        );
    });

    test("/workflow connect without a run id rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("connect", headlessNoOpCtx()),
            /Pass a runId: \/workflow connect <id>/,
        );
    });

    test("/workflow connect <valid> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();
        const runId = `headless-connect-valid-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        await assertRejectsHeadlessCommand(
            () => handler(`connect ${runId}`, headlessNoOpCtx()),
            /requires an interactive UI surface.*Use \/workflow status/i,
        );
    });

    test("/workflow attach <valid> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();
        const runId = `headless-attach-valid-${Date.now()}`;
        store.recordRunStart(makeInflightRun(runId));

        await assertRejectsHeadlessCommand(
            () => handler(`attach ${runId}`, headlessNoOpCtx()),
            /requires an interactive UI surface.*Use \/workflow status/i,
        );
    });

    test("/workflow attach <valid> <stage> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();
        const runId = `headless-attach-stage-${Date.now()}`;
        const stageId = "stage-headless-attach";
        store.recordRunStart({
            ...makeInflightRun(runId),
            stages: [
                {
                    id: stageId,
                    name: "review",
                    status: "running",
                    parentIds: [],
                    startedAt: Date.now(),
                    toolEvents: [],
                },
            ],
        });

        await assertRejectsHeadlessCommand(
            () => handler(`attach ${runId} ${stageId}`, headlessNoOpCtx()),
            /requires an interactive UI surface.*workflow tool.*inspection/i,
        );
    });

    test("/workflow kill <missing> rejects visibly in headless mode", async () => {
        const { handler } = await registerWorkflowCommand();

        await assertRejectsHeadlessCommand(
            () => handler("kill definitely-missing", headlessNoOpCtx()),
            /Run not found: definitely-missing/,
        );
    });

    test.each([
        ["reload", "reload", /Reloaded workflow resources\./],
        ["interrupt", "interrupt", /interrupted and can be resumed/],
        ["kill", "kill", /killed and retained for inspection/],
        ["pause", "pause", /Paused 1 stage\(s\)/],
        ["resume", "resume", /Resumed 1 stage\(s\)/],
    ])(
        "/workflow %s emits displayable success output in headless mode",
        async (_label, action, expected) => {
            const { handler, sent } = await registerWorkflowCommand();
            const runId = `headless-success-${action}-${Date.now()}`;
            const stageId = `stage-${action}`;

            if (action !== "reload") {
                const stageStatus = action === "resume" ? "paused" : "running";
                store.recordRunStart({
                    ...makeInflightRun(runId),
                    stages: [
                        {
                            id: stageId,
                            name: "worker",
                            status: stageStatus,
                            parentIds: [],
                            startedAt: Date.now(),
                            toolEvents: [],
                        },
                    ],
                });
                registerTestStageHandle(runId, stageId, stageStatus);
            }

            await handler(
                action === "reload" ? "reload" : `${action} ${runId}`,
                headlessNoOpCtx(),
            );

            const outputs = commandOutputMessages(sent);
            assert.ok(
                outputs.length > 0,
                `expected /workflow ${action} to emit command output`,
            );
            const content = outputs
                .map((message) => message.content ?? "")
                .join("\n");
            assert.match(content, expected);
        },
    );

    test("/workflow interrupt --all emits displayable success output in headless mode", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const runId = `headless-interrupt-all-${Date.now()}`;
        const stageId = "stage-interrupt-all";
        store.recordRunStart({
            ...makeInflightRun(runId),
            stages: [
                {
                    id: stageId,
                    name: "worker",
                    status: "running",
                    parentIds: [],
                    startedAt: Date.now(),
                    toolEvents: [],
                },
            ],
        });
        registerTestStageHandle(runId, stageId);

        await handler("interrupt --all", headlessNoOpCtx());

        const content = commandOutputMessages(sent)
            .map((message) => message.content ?? "")
            .join("\n");
        assert.match(content, /Interrupted 1 run\(s\)\./);
    });

    test("/workflow kill --all emits displayable success output in headless mode", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        store.recordRunStart(
            makeInflightRun(`headless-kill-all-${Date.now()}`),
        );

        await handler("kill --all", headlessNoOpCtx());

        const content = commandOutputMessages(sent)
            .map((message) => message.content ?? "")
            .join("\n");
        assert.match(
            content,
            /Killed and retained 1 run\(s\) for inspection\./,
        );
    });

    test("issue #1156: headless terminal workflow failure throws a command-visible error", async () => {
        const resource = await registerWorkflowCommandWithResource(
            "terminal-failure.ts",
            `import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("terminal-failure")
  .description("Fails after dispatch")
  .run(async () => {
    throw new Error("terminal boom");
  })
  .compile();
`,
        );

        try {
            await assertRejectsHeadlessCommand(
                () => resource.handler("terminal-failure", headlessNoOpCtx()),
                /Workflow "terminal-failure" failed: terminal boom/,
            );
        } finally {
            await resource.cleanup();
        }
    }, 15_000);

    test("issue #1156: headless /workflow success emits a printable terminal detail summary", async () => {
        const resource = await registerWorkflowCommandWithResource(
            "headless-terminal-success.ts",
            `import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("headless-terminal-success")
  .description("Completes without user input")
  .output("ok", { type: "unknown" })
  .output("value", { type: "unknown" })
  .run(async (ctx) => {
    await ctx.stage("terminal-stage").prompt("finish");
    return { ok: true, value: "terminal" };
  })
  .compile();
`,
        );

        try {
            await resource.handler(
                "headless-terminal-success",
                headlessNoOpCtx(),
            );

            assert.equal(
                resource.sent.some(
                    (message) =>
                        chatSurfacePayload(message)?.kind === "dispatch",
                ),
                false,
                "headless success must not emit an interactive dispatch surface",
            );

            const detailMessage = resource.sent.find(
                (message) => chatSurfacePayload(message)?.kind === "detail",
            );
            assert.ok(
                detailMessage,
                "expected a terminal run detail chat surface",
            );
            const detailPayload = chatSurfacePayload(detailMessage);
            assert.ok(
                detailPayload?.kind === "detail",
                "expected terminal run detail payload",
            );
            assert.equal(detailPayload.detail.status, "completed");
            assert.deepEqual(detailPayload.detail.result, {
                ok: true,
                value: "terminal",
            });
            assert.ok(
                detailPayload.detail.stages.length > 0,
                "expected completed stage details",
            );
            assert.equal(
                detailPayload.detail.stages.some(
                    (stage) => stage.status === "completed",
                ),
                true,
            );
            assert.equal(
                resource.sent.some(
                    (message) =>
                        message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
                ),
                false,
                "headless slash completion should not emit a lifecycle steer notice before terminal detail",
            );
            assert.equal(
                detailMessage.display,
                true,
                "terminal detail must be displayable for print mode",
            );
            assert.equal(typeof detailMessage.content, "string");

            const printableDetail = detailMessage.content ?? "";
            assert.match(printableDetail, /headless-terminal-success/);
            assert.match(printableDetail, /completed/);
            assert.match(printableDetail, /STAGES/);
            assert.match(printableDetail, /terminal-stage/);
            assert.match(printableDetail, /"value":"terminal"/);
        } finally {
            await resource.cleanup();
        }
    }, 15_000);

    test("/workflow unknown workflow remains notify-and-handled with an interactive UI", async () => {
        const { handler } = await registerWorkflowCommand();
        const { ctx, notifications } = commandCtx(true);

        await assert.doesNotReject(async () => {
            await handler("ghost-workflow", ctx);
        });

        const error = notifications.find((entry) => entry.type === "error");
        assert.ok(
            error,
            "expected interactive errors to be reported via notify('error')",
        );
        assert.match(error.message, /Workflow not found: ghost-workflow/);
    });

    test("/workflow still uses picker-capable path when a UI is available", async () => {
        const { handler } = await registerWorkflowCommand();
        const { ctx, pickerCalls } = commandCtx(true);

        await handler("deep-research-codebase", ctx);

        assert.ok(
            pickerCalls.length > 0,
            "expected interactive picker path to be attempted",
        );
    });

    test("/workflow proceeds when hasUI is unset (degraded runtimes)", async () => {
        const { handler, sent } = await registerWorkflowCommand();
        const { ctx, messages } = commandCtx(undefined);

        await handler("list", ctx);

        assert.equal(messages.length, 0);
        assert.ok(
            sent.length > 0,
            "expected /workflow list to emit a chat surface",
        );
    });
});
