import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai";
import { Type } from "typebox";

/** Text the stage streams before it holds its turn. */
export const RECEIPT_STAGE_FIRST_DELTA = "streamed-before-hold ";
/** The steer whose user message ends the first attempt. */
export const RECEIPT_STAGE_STEER = "steer-ends-the-attempt";

/** Marker files in the child's `directory`: the test creates the gates, the first attempt leaves `killed`. */
export const RECEIPT_STAGE_RELEASE = "release";
export const RECEIPT_STAGE_FINISH = "finish";
export const RECEIPT_STAGE_KILLED = "killed";

function textOf(content: unknown): string {
	return typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : "")).join("")
			: "";
}

function isSteer(message: { readonly role?: string; readonly content?: unknown }): boolean {
	return message.role === "user" && textOf(message.content) === RECEIPT_STAGE_STEER;
}

/**
 * A pooled child whose agent stage streams a first delta and holds its turn. Once the test creates `release`, the first
 * attempt's reply calls a tool, so a steer queued meanwhile enters the session while the turn is still under way; the attempt then ends at `killAt` while that
 * steer's user message is saved: `before-commit` kills the worker after the message ends and before the session writes
 * it, `after-message-commit` kills it once the write that holds the message landed. Every later turn, and every turn of a
 * replacement, holds until the test creates `finish`.
 */
export const child = workflow({
	name: "pool-stage-receipt-child",
	description: "Local worker stage whose attempt ends while a steer is saved",
	inputs: { directory: Type.String(), killAt: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const { directory, killAt } = ctx.inputs;
		const killed = () => existsSync(join(directory, RECEIPT_STAGE_KILLED));
		const kill = () => {
			writeFileSync(join(directory, RECEIPT_STAGE_KILLED), String(process.pid));
			process.kill(process.pid, "SIGKILL");
		};
		const cwd = ctx.cwd!;
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider("pool-fixture", {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "fixture",
			models: [
				{
					id: "fixture",
					name: "Fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100000,
					maxTokens: 1000,
				},
			],
			streamSimple(model, context, options) {
				const stream = createAssistantMessageEventStream();
				const partial = (text: string): AssistantMessage => ({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: [{ type: "text", text }],
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				// The first turn calls a tool, so the turn the steer joins is still under way when the attempt ends.
				const answered = context.messages.some((message) => message.role === "toolResult");
				const gate =
					killed() || answered || context.messages.some((message) => isSteer(message as never))
						? RECEIPT_STAGE_FINISH
						: RECEIPT_STAGE_RELEASE;
				void (async () => {
					stream.push({ type: "start", partial: partial("") });
					stream.push({ type: "text_start", contentIndex: 0, partial: partial("") });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: RECEIPT_STAGE_FIRST_DELTA,
						partial: partial(RECEIPT_STAGE_FIRST_DELTA),
					});
					while (!existsSync(join(directory, gate))) {
						if (options?.signal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: { ...partial(RECEIPT_STAGE_FIRST_DELTA), stopReason: "aborted" },
							});
							stream.end();
							return;
						}
						await delay(25);
					}
					const full = `${RECEIPT_STAGE_FIRST_DELTA}done`;
					stream.push({ type: "text_end", contentIndex: 0, content: full, partial: partial(full) });
					if (answered) stream.push({ type: "done", reason: "stop", message: partial(full) });
					else
						stream.push({
							type: "done",
							reason: "toolUse",
							message: {
								...partial(full),
								content: [
									{ type: "text", text: full },
									{ type: "toolCall", id: "call-noop", name: "noop", arguments: {} },
								],
								stopReason: "toolUse",
							},
						});
					stream.end();
				})();
				return stream;
			},
		});
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					// Runs after the steer's message ended and before the session writes it.
					pi.on("message_end", (event, extensionCtx) => {
						if (killed() || !isSteer(event.message as never)) return;
						if (killAt === "before-commit") kill();
						if (killAt !== "after-message-commit") return;
						// The session's write of this message: the attempt ends as soon as it landed.
						const sessions = extensionCtx.sessionManager as unknown as {
							appendMessage(message: unknown): Promise<string>;
						};
						const append = sessions.appendMessage;
						sessions.appendMessage = async (message) => {
							const id = await append.call(sessions, message);
							if (message === event.message) kill();
							return id;
						};
					});
				},
			],
		});
		await resourceLoader.reload();
		const stage = ctx.stage("agent", {
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: modelRuntime.getModel("pool-fixture", "fixture")!,
			settingsManager,
			resourceLoader,
			customTools: [
				{
					name: "noop",
					label: "No-op",
					description: "Does nothing",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				},
			],
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		} as never);
		return { text: await stage.complete("Stream a reply") };
	},
});
