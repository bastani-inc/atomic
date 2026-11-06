import type { SessionManager } from "@bastani/atomic";
import { describe } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { assert, createStore, mockSession, run, type StageSessionRuntime, test, workflow } from "./executor-shared.js";

/** Far longer than an aborted run takes to end; a readiness question deaf to the abort never ends. */
const ABORTED_RUN_BOUND_MS = 10_000;

/** Stage sessions whose turn asks the user a question, so the stage asks whether it is ready to advance. */
function askingAdapters() {
	return {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(options: { readonly sessionManager?: unknown }) {
				const manager = options.sessionManager as SessionManager;
				const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
				const session: StageSessionRuntime = {
					...mockSession(manager),
					async prompt(text: string) {
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
						for (const listener of [...listeners]) {
							listener({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask_user_question" });
							listener({
								type: "tool_execution_end",
								toolCallId: "ask",
								toolName: "ask_user_question",
								result: { details: { answers: [{ questionIndex: 0, answer: "yes" }], cancelled: false } },
							});
						}
					},
					subscribe(listener) {
						const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
						listeners.add(typed);
						return () => listeners.delete(typed);
					},
				};
				return session;
			},
		},
	};
}

describe("a readiness question when the run is aborted (#4309)", () => {
	test("the question is told of the run's abort through its signal, and the run ends (#4309)", async () => {
		const controller = new AbortController();
		const asked = Promise.withResolvers<AbortSignal>();
		const definition = workflow({
			name: "readiness-abort",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("interview").prompt("ask the user");
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{
				store: createStore(),
				signal: controller.signal,
				releaseWhenWaiting: false,
				adapters: askingAdapters(),
				confirmStageReadiness: ({ signal }) => {
					asked.resolve(signal);
					return new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false)));
				},
			},
		);
		const signal = await asked.promise;
		controller.abort(new Error("run killed"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			execution,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("the aborted run never ended")), ABORTED_RUN_BOUND_MS);
			}),
		]).finally(() => clearTimeout(timer));

		assert.equal(signal.aborted, true);
		assert.equal(result.status, "killed");
	});
});
