import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    makeFakeKeybindings,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
    fakeFooterAgentSession,
    stripAnsi,
    RETURN_HINT_TEXT,
    expectRightAlignedReturnHint,
    assistantTextMessage,
    type StageControlHandle,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("failed resume keeps the local paused state", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "paused");
        const { handle } = makeHandle(undefined, [], "paused");
        Object.assign(handle, {
            async resume() {
                throw new Error("resume failed");
            },
        });
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });

        for (const ch of "go on") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();

        assert.equal(view._isLocalPaused, true);
        view.dispose();
    });

    test("idle attached stage renders no welcome panel and keeps a cursor in the editor", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle } = makeHandle();
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        const rendered = view.render(96).join("\n");
        const visibleLines = rendered.split("\n").map(stripAnsi);
        assert.doesNotMatch(rendered, /Attached to/);
        assert.doesNotMatch(rendered, /This stage is idle/);
        assert.doesNotMatch(rendered, /type a message to start this stage/i);
        assert.match(rendered, /❯/);
        assert.match(rendered, /\x1b\[7m \x1b\[0m/);
        const hintIndex = expectRightAlignedReturnHint(visibleLines, 96);
        assert.ok(
            hintIndex > visibleLines.findIndex((line) => line.includes("❯")),
            "expected orchestrator hint below the chat box",
        );
        view.dispose();
    });

    test("live pi editor path renders an empty composer without placeholder text", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle } = makeHandle();
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 40, columns: 96 },
            } as never,
            piKeybindings: makeFakeKeybindings(),
        });
        const emptyRendered = view.render(96).join("\n");
        assert.match(emptyRendered, /❯/);
        assert.doesNotMatch(
            emptyRendered,
            /type a message to start this stage/i,
        );
        for (const ch of "hello") view.handleInput(ch);
        const rendered = view.render(96).join("\n");
        assert.match(rendered, /hello/);
        assert.doesNotMatch(rendered, /type a message to start this stage/i);
        view.dispose();
    });

    test("renders pi-style spacing between a full transcript and the streaming loader", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const messages = Array.from({ length: 30 }, (_, i) =>
            assistantTextMessage(`msg-${i}`),
        );
        const { handle } = makeHandle(
            {
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: true,
            },
            messages,
        );
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });

        const lines = view.render(96).map(stripAnsi);
        const workingIndex = lines.findIndex((line) =>
            line.includes("Working"),
        );
        assert.ok(
            workingIndex > 1,
            "expected working spinner after transcript",
        );
        const previousContent = lines
            .slice(0, workingIndex)
            .findLast((line) => line.trim() !== "");
        assert.match(previousContent ?? "", /msg-\d+/);
        assert.equal(lines[workingIndex - 1]?.trim(), "");
        assert.match(lines[workingIndex] ?? "", /^\s+\S Working/);
        view.dispose();
    });

    test("attached live sessions render the usage ribbon, orchestrator hint, and coding-agent footer", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const { handle } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        const handleWithSession: StageControlHandle = {
            ...handle,
            agentSession: fakeFooterAgentSession(true),
        };
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle: handleWithSession,
            footerData: {
                getGitBranch: () => "main",
                getExtensionStatuses: () => new Map(),
                getAvailableProviderCount: () => 2,
                onBranchChange: () => () => {},
            },
            onDetach: () => {},
            onClose: () => {},
        });
        const lines = view.render(120).map(stripAnsi);
        const rendered = lines.join("\n");
        assert.match(rendered, /\$0\.123/);
        assert.match(rendered, /23\.4%\/200k/);
        assert.match(rendered, /Working/);
        assert.doesNotMatch(rendered, /╌/);

        const workingIndex = lines.findIndex((line) =>
            line.includes("Working"),
        );
        const usageIndex = lines.findIndex((line) => line.includes("$0.123"));
        const promptIndex = lines.findIndex((line) => line.includes("❯"));
        const hintIndex = expectRightAlignedReturnHint(lines, 120);
        const identityIndex = lines.findIndex((line) =>
            line.includes("esc to interrupt"),
        );
        const commandsIndex = lines.findIndex((line) =>
            line.includes("esc pause"),
        );
        assert.ok(workingIndex >= 0, "expected working spinner line");
        assert.ok(
            usageIndex > workingIndex,
            "expected usage below working line",
        );
        assert.ok(
            promptIndex > usageIndex,
            "expected composer below usage line",
        );
        assert.ok(
            hintIndex > promptIndex,
            "expected orchestrator hint below the chat box",
        );
        assert.equal(identityIndex, hintIndex);
        assert.notEqual(lines[hintIndex]?.trim(), RETURN_HINT_TEXT);
        assert.equal(commandsIndex, -1);
        assert.doesNotMatch(lines[identityIndex] ?? "", /steer|follow-up/);
        assert.doesNotMatch(
            rendered,
            /pageup\/pagedown|follow-up|steer/,
        );
        view.dispose();
    });

    test("footer keeps model context and Ctrl+D orchestrator hint on one line", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const { handle } = makeHandle();
        const handleWithSession: StageControlHandle = {
            ...handle,
            agentSession: fakeFooterAgentSession(false),
        };
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle: handleWithSession,
            footerData: {
                getGitBranch: () => "main",
                getExtensionStatuses: () => new Map(),
                getAvailableProviderCount: () => 2,
                onBranchChange: () => () => {},
            },
            onDetach: () => {},
            onClose: () => {},
        });

        const lines = view.render(120).map(stripAnsi);
        const hintIndex = expectRightAlignedReturnHint(lines, 120);
        assert.match(
            lines[hintIndex] ?? "",
            /\(openai-codex\) gpt-5\.5 high .*Documents\/projects\/atomic/,
        );
        assert.notEqual(lines[hintIndex]?.trim(), RETURN_HINT_TEXT);
        view.dispose();
    });

    test("Enter after Escape pause resumes with the typed message", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        const originalPause = handle.pause.bind(handle);
        const originalResume = handle.resume.bind(handle);
        Object.assign(handle, {
            async pause() {
                await originalPause();
                store.recordStagePaused("run-1", "stage-a");
            },
            async resume(message?: string) {
                await originalResume(message);
                store.recordStageResumed("run-1", "stage-a");
            },
        });
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        view.handleInput("\x1b");
        await flush();
        await flush();
        assert.equal(state.pauseCalls, 1);
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");
        for (const ch of "go on") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.resumeCalls, ["go on"]);
        assert.deepEqual(state.steerCalls, []);
        assert.equal(store.runs()[0]?.stages[0]?.status, "running");
        view.dispose();
    });

});
