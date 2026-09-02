import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../../../src/core/agent-session-runtime.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

describe("regression #8724: in-memory fork during an active tool turn", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("does not append the aborted turn to the replacement session", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					markToolStarted();
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						{ once: true },
					);
				}),
		};
		const harness = await createHarness({ tools: [blockingTool] });
		const harnessServices: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		// Atomic adaptation: every replacement runtime gets a fresh resource loader. Atomic wraps the
		// loader in the mandatory-Intercom loader, whose extension ctx goes stale once the session it
		// was bound to is replaced, so reusing the harness loader across a fork throws before the
		// assertions run. `test/suite/regressions/2860-replaced-session-context.test.ts` builds fresh
		// services per factory call for the same reason.
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
			const services: AgentSessionServices = { ...harnessServices, resourceLoader: createTestResourceLoader() };
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
					noTools: "all",
				})),
				services,
				diagnostics: [],
			};
		};
		const runtime = new AgentSessionRuntime(harness.session, harnessServices, createRuntime);
		cleanups.push(async () => {
			if (runtime.session !== harness.session) {
				await runtime.dispose();
			}
			harness.cleanup();
		});

		harness.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused after abort"),
		]);
		await runtime.session.prompt("first prompt");
		const firstUserEntryId = runtime.session.getUserMessagesForForking()[0]?.entryId;
		expect(firstUserEntryId).toBeDefined();

		const outgoingPrompt = runtime.session.prompt("start blocking tool");
		await toolStarted;
		const forkResult = await runtime.fork(firstUserEntryId!);
		await outgoingPrompt;
		await runtime.session.bindExtensions({});

		expect(forkResult).toEqual({ cancelled: false, selectedText: "first prompt" });
		expect(runtime.session.messages).toEqual([]);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);

		let capturedRoles: string[] = [];
		harness.setResponses([
			(context) => {
				capturedRoles = context.messages.map((message) => message.role);
				return fauxAssistantMessage("next response");
			},
		]);
		await runtime.session.prompt("next prompt");

		expect(capturedRoles).toEqual(["user"]);
	});
});
