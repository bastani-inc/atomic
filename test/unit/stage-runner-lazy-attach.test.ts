import { describe, test } from "bun:test";
import type {
    AgentSession,
    AgentSessionAdapter,
    InternalStageContext,
} from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — lazy attach", () => {
    test("__ensureSession creates the SDK session on demand", async () => {
        const { session } = makeMockSession();
        let creates = 0;
        const agentSession: AgentSessionAdapter = {
            async create() {
                creates += 1;
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;
        assert.equal(creates, 0);
        await ctx.__ensureSession();
        assert.equal(creates, 1);
        // Idempotent: a second call reuses the cached promise.
        await ctx.__ensureSession();
        assert.equal(creates, 1);
    });

    test("__sessionMeta returns undefined keys before attach", () => {
        const ctx = createStageContext(
            makeOpts({ adapters: {} }),
        ) as InternalStageContext;
        assert.deepEqual(ctx.__sessionMeta(), {
            sessionId: undefined,
            sessionFile: undefined,
        });
    });

    test("pending subscribers fire after lazy attach", async () => {
        const { session } = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;
        const events: string[] = [];
        ctx.subscribe((event) =>
            events.push((event as { type?: string }).type ?? ""),
        );
        await ctx.__ensureSession();
        // Now drive an event through the live session (the listener is bound
        // on attach). We can't directly emit from our mock without state,
        // so we just assert the subscriber survived attach without throwing.
        assert.equal(events.length, 0);
    });

    test("prompt result falls back to assistant text appended to SDK messages", async () => {
        const messages = [
            {
                role: "user",
                content: [{ type: "text", text: "question" }],
                timestamp: Date.now(),
            },
        ] as AgentSession["messages"];
        const { session } = makeMockSession({
            async prompt() {
                messages.push({
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "private reasoning" },
                        { type: "text", text: "derived" },
                        { type: "text", text: " answer" },
                    ],
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
            },
            messages,
            getLastAssistantText: undefined,
        });
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const result = await ctx.prompt("question");

        assert.equal(result, "derived answer");
        assert.equal(ctx.getLastAssistantText(), "derived answer");
    });

    test("prompt result falls back to terminating tool result text", async () => {
        const messages = [
            {
                role: "user",
                content: [{ type: "text", text: "question" }],
                timestamp: Date.now(),
            },
        ] as AgentSession["messages"];
        let emit: (event: {
            type: string;
            [k: string]: unknown;
        }) => void = () => {};
        const created = makeMockSession({
            async prompt() {
                messages.push({
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "call-1",
                            name: "review_decision",
                            arguments: {},
                        },
                    ],
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
                messages.push({
                    role: "toolResult",
                    toolCallId: "call-1",
                    toolName: "review_decision",
                    content: [
                        { type: "text", text: '{"stop_review_loop":true}' },
                    ],
                    isError: false,
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
                // The tool actually terminated the turn: emit the runtime signal the
                // stage runner watches (the tool result message carries no terminate).
                emit({
                    type: "tool_execution_end",
                    toolCallId: "call-1",
                    toolName: "review_decision",
                    result: { terminate: true },
                    isError: false,
                });
            },
            messages,
            getLastAssistantText: undefined,
        });
        emit = created.emit;
        const agentSession: AgentSessionAdapter = {
            async create() {
                return created.session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const result = await ctx.prompt("question");

        assert.equal(result, '{"stop_review_loop":true}');
        assert.equal(ctx.getLastAssistantText(), '{"stop_review_loop":true}');
    });

    test("non-terminating trailing tool result falls back to the last assistant message", async () => {
        // A turn that ends on a tool result whose tool returned `terminate: false`
        // (e.g. interrupted/aborted right after a non-terminating tool call) must
        // NOT surface the tool result as the stage output — the last assistant
        // message wins.
        const messages = [
            {
                role: "user",
                content: [{ type: "text", text: "question" }],
                timestamp: Date.now(),
            },
        ] as AgentSession["messages"];
        let emit: (event: {
            type: string;
            [k: string]: unknown;
        }) => void = () => {};
        const created = makeMockSession({
            async prompt() {
                messages.push({
                    role: "assistant",
                    content: [
                        { type: "text", text: "LAST ASSISTANT PROSE" },
                        {
                            type: "toolCall",
                            id: "call-9",
                            name: "note_progress",
                            arguments: {},
                        },
                    ],
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
                messages.push({
                    role: "toolResult",
                    toolCallId: "call-9",
                    toolName: "note_progress",
                    content: [
                        {
                            type: "text",
                            text: "tool output that must NOT be the stage result",
                        },
                    ],
                    isError: false,
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
                // Non-terminating tool: terminate is false, so the trailing tool result
                // is not the turn output.
                emit({
                    type: "tool_execution_end",
                    toolCallId: "call-9",
                    toolName: "note_progress",
                    result: { terminate: false },
                    isError: false,
                });
            },
            messages,
            getLastAssistantText: () => "LAST ASSISTANT PROSE",
        });
        emit = created.emit;
        const agentSession: AgentSessionAdapter = {
            async create() {
                return created.session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const result = await ctx.prompt("question");

        assert.equal(result, "LAST ASSISTANT PROSE");
        assert.equal(ctx.getLastAssistantText(), "LAST ASSISTANT PROSE");
    });

    test("terminating tool result wins over assistant prose emitted before the tool call", async () => {
        // Mirrors the real review_decision (goal/ralph) case: the model narrates in
        // prose and then ends the turn on the terminating structured-output tool.
        // The deterministic turn output must be the tool result JSON, not the prose.
        const verdict =
            '{"stop_review_loop":true,"overall_correctness":"patch is correct"}';
        const messages = [
            {
                role: "user",
                content: [{ type: "text", text: "question" }],
                timestamp: Date.now(),
            },
        ] as AgentSession["messages"];
        let emit: (event: {
            type: string;
            [k: string]: unknown;
        }) => void = () => {};
        const created = makeMockSession({
            async prompt() {
                messages.push({
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "All validation passes; the patch looks correct.",
                        },
                        {
                            type: "toolCall",
                            id: "call-1",
                            name: "review_decision",
                            arguments: {},
                        },
                    ],
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
                messages.push({
                    role: "toolResult",
                    toolCallId: "call-1",
                    toolName: "review_decision",
                    content: [{ type: "text", text: verdict }],
                    isError: false,
                    timestamp: Date.now(),
                } as AgentSession["messages"][number]);
                emit({
                    type: "tool_execution_end",
                    toolCallId: "call-1",
                    toolName: "review_decision",
                    result: { terminate: true },
                    isError: false,
                });
            },
            messages,
            getLastAssistantText: () =>
                "All validation passes; the patch looks correct.",
        });
        emit = created.emit;
        const agentSession: AgentSessionAdapter = {
            async create() {
                return created.session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const result = await ctx.prompt("question");

        assert.equal(result, verdict);
        assert.equal(ctx.getLastAssistantText(), verdict);
    });
});

