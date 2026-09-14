/** Deterministic model only: real CLI sessions, workflow tools and Intercom transport remain intact. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateAgentSessionOptions, ExtensionAPI } from "@bastani/atomic";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
	// A custom SDK host may omit post-mortem routing. Do not alter a real workflow session to fake that state.
	pi.registerTool({
		name: "fixture_unavailable_stage",
		label: "Unavailable stage fixture",
		description: "Create and close an isolated custom-host stage without a late-message router.",
		parameters: Type.Object({ group: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const { createAgentSession, SessionManager } = await import("@bastani/atomic");
			const orchestrationContext: NonNullable<CreateAgentSessionOptions["orchestrationContext"]> = {
				kind: "workflow-stage",
				intercomGroup: params.group,
				workflowRunId: "custom-host-unavailable",
				workflowStageId: "unavailable",
				workflowStageName: "unavailable",
				constraints: { disableWorkflowTool: true },
			};
			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				model: ctx.model,
				sessionManager: SessionManager.inMemory(ctx.cwd),
				orchestrationContext,
			});
			await session.bindExtensions({});
			await session.prompt('fixture-call {"name":"intercom","arguments":{"action":"status"}}');
			await orchestrationContext.messageAdmission!.boundary.close();
			return {
				content: [{ type: "text", text: "Custom-host stage closed without post-mortem capability." }],
				details: {},
			};
		},
	});
	pi.registerProvider("nested-discovery-fixture", {
		api: "nested-discovery-fixture",
		apiKey: "fixture-only",
		baseUrl: "http://127.0.0.1:1/unused",
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
			{
				id: "failing",
				name: "Failing primary",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
		// Registered primary fails after extension initialization, not model lookup.
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const stateDir = process.env.NESTED_DISCOVERY_STATE_DIR!;
			const last = context.messages.at(-1);
			const text =
				typeof last?.content === "string"
					? last.content
					: (last?.content ?? [])
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
			if (process.env.NESTED_FALLBACK_CONTROL) {
				appendFileSync(join(stateDir, "model-attempts.jsonl"), `${JSON.stringify({ model: model.id, text })}\n`);
			}
			const command = /^fixture-call (.+)$/.exec(text)?.[1];
			const request =
				command === undefined
					? undefined
					: (JSON.parse(command) as { name: string; arguments: Record<string, unknown> });
			const isHold = text === "fixture-hold";
			const content: AssistantMessage["content"] = request
				? [{ type: "toolCall", id: `fixture-${Date.now()}`, name: request.name, arguments: request.arguments }]
				: last?.role === "user" && text.includes("To reply, use the intercom tool:")
					? [
							{
								type: "toolCall",
								id: `reply-${Date.now()}`,
								name: "intercom",
								arguments: { action: "reply", message: "exact retained reviewer answer" },
							},
						]
					: [{ type: "text", text: "Fixture complete." }];
			if (last?.role === "toolResult")
				appendFileSync(join(stateDir, "tool-results.jsonl"), `${JSON.stringify(last)}\n`);
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content,
				stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			void (async () => {
				if (model.id === "failing") {
					output.stopReason = "error";
					output.errorMessage = "429 rate limit exceeded";
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}
				if (text === "fixture-top-hold") {
					writeFileSync(join(stateDir, "top-hold"), "started\n");
					while (!existsSync(join(stateDir, "top-release")))
						await new Promise((resolve) => setTimeout(resolve, 20));
				}
				if (isHold) {
					appendFileSync(join(stateDir, "holds.jsonl"), "started\n");
					while (!existsSync(join(stateDir, "release"))) await new Promise((resolve) => setTimeout(resolve, 20));
				}
				stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
				stream.end();
			})();
			return stream;
		},
	});
}
