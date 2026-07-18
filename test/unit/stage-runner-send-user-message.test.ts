import { describe, test } from "bun:test";
import { sendStageUserMessage } from "../../packages/workflows/src/runs/foreground/stage-runner-send-user-message.js";
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
        assert.equal(await ctx.__sendUserMessage("continue after idle"), "prompt");

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
        assert.equal(await ctx.__sendUserMessage("queued while streaming"), "followUp");
        assert.equal(await ctx.__sendUserMessage("steer while streaming", { deliverAs: "steer" }), "steer");

        assert.deepEqual(userMessages, [
            { text: "queued while streaming", deliverAs: "followUp" },
            { text: "steer while streaming", deliverAs: "steer" },
        ]);
    });

    test("reports the post-preflight delivery branch instead of the initial streaming snapshot", async () => {
        const preflight = Promise.withResolvers<void>();
        let streaming = true;
        const calls: string[] = [];
        const { session } = makeMockSession({
            get isStreaming() { return streaming; },
            async sendUserMessage(text, options) {
                assert.equal(text, "race-safe delivery");
                await preflight.promise;
                streaming = false;
                options?.__workflowDelivery?.beforeDelivery?.();
                options?.__workflowDelivery?.delivered?.("prompt");
                calls.push("prompt");
            },
        });

        const deliveryPromise = sendStageUserMessage(session, "race-safe delivery");
        streaming = false;
        preflight.resolve();

        assert.equal(await deliveryPromise, "prompt");
        assert.deepEqual(calls, ["prompt"]);
    });

    test("keeps a second idle send behind admission until the first prompt has entered its turn", async () => {
        const firstPreflight = Promise.withResolvers<void>();
        const firstBeforeDelivery = Promise.withResolvers<void>();
        const allowFirstPromptStartup = Promise.withResolvers<void>();
        const firstPromptStarted = Promise.withResolvers<void>();
        const firstTurn = Promise.withResolvers<void>();
        let streaming = false;
        let promptStarts = 0;
        const admittedMessages: string[] = [];
        const consumedMessages: string[] = [];
        const actions: string[] = [];
        const { session } = makeMockSession({
            async sendUserMessage(text, options) {
                if (typeof text !== "string") throw new Error("expected string content");
                admittedMessages.push(text);
                if (text === "first") {
                    await firstPreflight.promise;
                    firstBeforeDelivery.resolve();
                    options?.__workflowDelivery?.beforeDelivery?.();
                    await allowFirstPromptStartup.promise;
                    streaming = true;
                    promptStarts += 1;
                    firstPromptStarted.resolve();
                    options?.__workflowDelivery?.promptStarted?.();
                    options?.__workflowDelivery?.delivered?.("prompt");
                    actions.push("prompt");
                    consumedMessages.push(text);
                    await firstTurn.promise;
                    streaming = false;
                    return;
                }
                options?.__workflowDelivery?.beforeDelivery?.();
                const action = options?.deliverAs ?? "prompt";
                if (action === "prompt") promptStarts += 1;
                if (action === "prompt") options?.__workflowDelivery?.promptStarted?.();
                options?.__workflowDelivery?.delivered?.(action);
                actions.push(action);
                consumedMessages.push(text);
            },
        });
        Object.defineProperty(session, "isStreaming", { get: () => streaming });
        const ctx = createStageContext(makeOpts({
            adapters: { agentSession: { async create() { return session; } } },
        })) as InternalStageContext;

        const first = ctx.__sendUserMessage("first");
        const second = ctx.__sendUserMessage("second");
        firstPreflight.resolve();
        await firstBeforeDelivery.promise;
        await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

        let earlyAdmissionError: Error | undefined;
        try {
            assert.deepEqual(admittedMessages, ["first"]);
            assert.equal(promptStarts, 0);
        } catch (error) {
            earlyAdmissionError = error instanceof Error ? error : new Error(String(error));
        }

        allowFirstPromptStartup.resolve();
        await firstPromptStarted.promise;
        assert.equal(await second, "followUp");
        firstTurn.resolve();
        assert.equal(await first, "prompt");
        if (earlyAdmissionError) throw earlyAdmissionError;

        assert.equal(promptStarts, 1);
        assert.deepEqual(actions, ["prompt", "followUp"]);
        assert.deepEqual(consumedMessages, ["first", "second"]);
    });

    test("releases admission after a lifecycle gate rejects prompt startup", async () => {
        const admitted: string[] = [];
        const { session } = makeMockSession({
            sendUserMessage(text, options) {
                if (typeof text !== "string") throw new Error("expected string content");
                admitted.push(text);
                options?.__workflowDelivery?.beforeDelivery?.();
                options?.__workflowDelivery?.promptStarted?.();
                options?.__workflowDelivery?.delivered?.("prompt");
                return Promise.resolve();
            },
        });
        const ctx = createStageContext(makeOpts({
            adapters: { agentSession: { async create() { return session; } } },
        })) as InternalStageContext;

        const rejected = ctx.__sendUserMessage("rejected", undefined, () => {
            throw new DOMException("workflow exited", "AbortError");
        });
        const accepted = ctx.__sendUserMessage("accepted");

        await assert.rejects(rejected, /workflow exited/);
        assert.equal(await accepted, "prompt");
        assert.deepEqual(admitted, ["rejected", "accepted"]);
    });
    test("rechecks lifecycle after asynchronous preflight before admitting a prompt", async () => {
        const preflight = Promise.withResolvers<void>();
        let blocked = false;
        let prompts = 0;
        const { session } = makeMockSession({
            async sendUserMessage(_text, options) {
                await preflight.promise;
                options?.__workflowDelivery?.beforeDelivery?.();
                options?.__workflowDelivery?.delivered?.("prompt");
                prompts += 1;
            },
        });

        const deliveryPromise = sendStageUserMessage(
            session,
            "must not become late prompt",
            undefined,
            () => {
                if (blocked) throw new DOMException("workflow exited", "AbortError");
            },
        );
        blocked = true;
        preflight.resolve();

        await assert.rejects(deliveryPromise, /workflow exited/);
        assert.equal(prompts, 0);
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
