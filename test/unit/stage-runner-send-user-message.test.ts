import { describe, test } from "bun:test";
import type {
    AgentSessionAdapter,
    InternalStageContext,
    StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import {
    Type,
    type StageUserMessageContent,
    assert,
    createStageContext,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — sendUserMessage", () => {
    test("sends an idle post-prompt user turn through the SDK session", async () => {
        const prompts: string[] = [];
        const userMessages: Array<{ text: string; deliverAs?: "steer" | "followUp" }> = [];
        const { session } = makeMockSession({
            async prompt(text) {
                prompts.push(text);
            },
            async sendUserMessage(text, options) {
                if (typeof text !== "string") throw new Error("expected string content");
                userMessages.push({ text, deliverAs: options?.deliverAs });
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        assert.equal(await ctx.prompt("initial"), "ok");
        await ctx.sendUserMessage("continue after idle");

        assert.deepEqual(prompts, ["initial"]);
        assert.deepEqual(userMessages, [{ text: "continue after idle", deliverAs: undefined }]);
    });

    test("defaults streaming user messages to follow-up delivery", async () => {
        const userMessages: Array<{ text: string; deliverAs?: "steer" | "followUp" }> = [];
        const { session } = makeMockSession({
            isStreaming: true,
            async sendUserMessage(text, options) {
                if (typeof text !== "string") throw new Error("expected string content");
                userMessages.push({ text, deliverAs: options?.deliverAs });
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.__ensureSession();
        await ctx.sendUserMessage("queued while streaming");
        await ctx.sendUserMessage("steer while streaming", { deliverAs: "steer" });

        assert.deepEqual(userMessages, [
            { text: "queued while streaming", deliverAs: "followUp" },
            { text: "steer while streaming", deliverAs: "steer" },
        ]);
    });

    test("passes multimodal content through native sendUserMessage", async () => {
        const content = [
            { type: "text", text: "describe this" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
        ] satisfies StageUserMessageContent;
        const userMessages: Array<{ content: StageUserMessageContent; deliverAs?: "steer" | "followUp" }> = [];
        const { session } = makeMockSession({
            async sendUserMessage(messageContent, options) {
                userMessages.push({ content: messageContent, deliverAs: options?.deliverAs });
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.__ensureSession();
        await ctx.sendUserMessage(content);

        assert.deepEqual(userMessages, [{ content, deliverAs: undefined }]);
    });

    test("rejects multimodal fallback when the runtime lacks native sendUserMessage", async () => {
        const content = [
            { type: "text", text: "describe this" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
        ] satisfies StageUserMessageContent;
        const { session } = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.__ensureSession();
        await assert.rejects(
            () => ctx.sendUserMessage(content),
            /does not support non-string sendUserMessage content/,
        );
    });

    test("queues streaming messages on runtimes without native sendUserMessage", async () => {
        const queued: string[] = [];
        const steered: string[] = [];
        const { session } = makeMockSession({
            isStreaming: true,
            async followUp(text) {
                queued.push(text);
            },
            async steer(text) {
                steered.push(text);
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.__ensureSession();
        await ctx.sendUserMessage("fallback follow-up");
        await ctx.sendUserMessage("fallback steer", { deliverAs: "steer" });

        assert.deepEqual(queued, ["fallback follow-up"]);
        assert.deepEqual(steered, ["fallback steer"]);
    });

    test("schema-backed stages can send a user message after their one prompt resolves", async () => {
        let createOptions: StageSessionCreateOptions | undefined;
        const prompts: string[] = [];
        const userMessages: string[] = [];
        const { session } = makeMockSession({
            async prompt(promptText) {
                prompts.push(promptText);
                const structuredTool = createOptions?.customTools?.find(
                    (tool) => tool.name === "structured_output",
                );
                assert.ok(structuredTool);
                await structuredTool.execute(
                    "structured-call-send-user-message",
                    { ok: true },
                    undefined,
                    undefined,
                    undefined as never,
                );
            },
            async sendUserMessage(text) {
                if (typeof text !== "string") throw new Error("expected string content");
                userMessages.push(text);
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                createOptions = options;
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
                },
            }),
        );

        assert.deepEqual(await ctx.prompt("produce structured output"), { ok: true });
        await ctx.sendUserMessage("post-schema follow-on");

        assert.deepEqual(prompts, ["produce structured output"]);
        assert.deepEqual(userMessages, ["post-schema follow-on"]);
    });
});
