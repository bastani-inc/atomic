// @ts-nocheck
import { describe, test } from "bun:test";
import {
    assert,
    parseWorkflowArgs,
    tokenizeWorkflowArgs,
    makeExecuteWorkflowTool,
    workflowPolicyFromContext,
    WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
    renderResult,
    createRegistry,
    defineWorkflow,
    Type,
    createExtensionRuntime,
    store,
    restoreOnSessionStart,
    WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
    WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    LIFECYCLE_NOTICE_CUSTOM_TYPE,
    stageControlRegistry,
    stageUiBroker,
    buildStagePromptAdapter,
    jobTracker,
    mkdtemp,
    rm,
    writeFile,
    tmpdir,
    join,
    makeInflightRun,
    registerWorkflowCommand,
    recordTerminalRun,
    registerTestStageHandle,
    makeRegisteredWorkflowTool,
    makeRegisteredWorkflowToolWithResource,
    registerLiveStageHandle,
    waitForToolPrompt,
    waitForToolRunEnded,
    buildMockPi,
    buildCtx,
    addFactoryStubs,
    fakeAgentSession,
    runFactory,
    writeWorkflowFixture,
} from "./slash-dispatch-utils.js";
import type {
    ExtensionAPI,
    PiArgumentCompletion,
    PiCommandContext,
    PiCommandOptions,
    PiToolOpts,
    WorkflowToolArgs,
    WorkflowDefinition,
    WorkflowPersistencePort,
    ExtensionRuntime,
    ChatSurfacePayload,
    SessionEntry,
    PiCustomComponent,
    PiCustomOverlayFactoryTui,
    PiCustomOverlayFunction,
    PiCustomOverlayOptions,
    PiOverlayHandle,
    StageSessionRuntime,
    StageControlHandle,
} from "./slash-dispatch-utils.js";

describe("parseWorkflowArgs", () => {
    test.serial("empty tokens → empty object", () => {
        assert.deepEqual(parseWorkflowArgs([]), {});
    });

    test.serial("parses key=value string pairs", () => {
        assert.deepEqual(parseWorkflowArgs(["prompt=hello world"]), {
            prompt: "hello world",
        });
    });

    test.serial("multiple key=value pairs", () => {
        assert.deepEqual(parseWorkflowArgs(["a=1", "b=foo"]), {
            a: 1,
            b: "foo",
        });
    });

    test.serial("JSON-typed values: number, boolean", () => {
        assert.deepEqual(parseWorkflowArgs(["count=42", "flag=true"]), {
            count: 42,
            flag: true,
        });
    });

    test.serial("value with = in it splits on first = only", () => {
        assert.deepEqual(parseWorkflowArgs(["url=http://x.com/a=b"]), {
            url: "http://x.com/a=b",
        });
    });

    test.serial("JSON object token merged into result", () => {
        const result = parseWorkflowArgs(['{"key":"val","n":3}']);
        assert.deepEqual(result, { key: "val", n: 3 });
    });

    test.serial("JSON object merged with key=value", () => {
        const result = parseWorkflowArgs(['{"a":1}', "b=two"]);
        assert.deepEqual(result, { a: 1, b: "two" });
    });

    test.serial("tokens without = are ignored", () => {
        assert.deepEqual(parseWorkflowArgs(["positional", "another"]), {});
    });

    test.serial("key with empty value", () => {
        assert.deepEqual(parseWorkflowArgs(["name="]), { name: "" });
    });
});

// ---------------------------------------------------------------------------
// tokenizeWorkflowArgs
// ---------------------------------------------------------------------------

describe("tokenizeWorkflowArgs", () => {
    test.serial("empty string → empty array", () => {
        assert.deepEqual(tokenizeWorkflowArgs(""), []);
    });

    test.serial("whitespace-only string → empty array", () => {
        assert.deepEqual(tokenizeWorkflowArgs("   \t  "), []);
    });

    test.serial("plain whitespace split for bare tokens", () => {
        assert.deepEqual(tokenizeWorkflowArgs("workflow-name a=1 b=foo"), [
            "workflow-name",
            "a=1",
            "b=foo",
        ]);
    });

    test.serial("double-quoted value preserves internal whitespace", () => {
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

    test.serial("single-quoted value preserves internal whitespace", () => {
        assert.deepEqual(tokenizeWorkflowArgs("wf prompt='hello there' n=2"), [
            "wf",
            "prompt='hello there'",
            "n=2",
        ]);
    });

    test.serial("nested quotes of the opposite kind are treated as literal characters", () => {
        assert.deepEqual(tokenizeWorkflowArgs(`wf msg="she said 'hi'"`), [
            "wf",
            `msg="she said 'hi'"`,
        ]);
    });

    test.serial("unterminated quote is recovered as a single tail token", () => {
        // The user can paste a partial value mid-typing; we never throw on
        // their input, the downstream JSON parse just falls back to string.
        assert.deepEqual(tokenizeWorkflowArgs('wf prompt="map the codebase'), [
            "wf",
            'prompt="map the codebase',
        ]);
    });

    test.serial("collapses runs of whitespace", () => {
        assert.deepEqual(tokenizeWorkflowArgs("a   b\t\tc"), ["a", "b", "c"]);
    });

    test.serial("end-to-end: tokenize + parse unquotes the string value", () => {
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
