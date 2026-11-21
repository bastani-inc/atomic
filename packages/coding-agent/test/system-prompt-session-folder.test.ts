/**
 * The default prompt names the project's session folder in a section near its end, so the guidelines read the same in
 * every project (#6121). A session recorded with the folder in its guidelines keeps that prompt. Real AgentSession
 * against a local provider; no network is contacted.
 */

import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	getSystemMessageText,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const PROVIDER = "session-folder";
const IN_SECTION =
	"Older or JSONL-selected sessions of this project are in its session folder, named under `<session_folder>` at the end of this prompt, where `rg` works.";
const inGuidelines = (folder: string) =>
	`Older or JSONL-selected sessions of this project are in \`${folder}\`, where \`rg\` works.`;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function createRuntime(prompts: string[]) {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const model: Model<"anthropic-messages"> = { ...base, provider: PROVIDER, id: "claude", name: "Claude" };
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider(PROVIDER, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (_model, context) => {
			prompts.push(
				context.messages
					.flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
					.join("\n"),
			);
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: base.api,
				provider: PROVIDER,
				model: model.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(PROVIDER));
	return { runtime, model };
}

/** Runs one turn of a session on `sessionManager`; returns the system prompt text of each request and its messages. */
async function turn(sessionManager: SessionManager, text: string, addendum?: string, tools = ["read"]) {
	const prompts: string[] = [];
	const { runtime, model } = await createRuntime(prompts);
	const extensionsResult = addendum
		? await createTestExtensionsResult([
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.appendSystemPrompt = addendum;
					});
				},
			])
		: undefined;
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		modelRuntime: runtime,
		model,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager,
		resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools,
	});
	cleanups.push(() => session.dispose());
	const before = session.messages.length;
	await session.prompt(text);
	return { prompts, added: session.messages.slice(before) };
}

function sectionUpdates(messages: AgentMessage[]): Record<string, string | null>[] {
	return messages.flatMap((message) => (message.role === "system" && message.sections ? [message.sections] : []));
}

describe("the session folder in the system prompt (#6121)", () => {
	it("a new session names it in a section of its own and keeps that prompt when it resumes", async () => {
		const sessionManager = SessionManager.inMemory(process.cwd());
		const first = await turn(sessionManager, "first");
		const [recorded] = sectionUpdates(first.added);
		expect(recorded?.rules).toContain(IN_SECTION);
		expect(recorded?.session_folder).toMatch(/^<session_folder>\nSession folder of this project: /);

		const resumed = await turn(sessionManager, "after the resume");
		expect(sectionUpdates(resumed.added)).toEqual([]);
		expect(resumed.prompts[0]).toBe(first.prompts[0]);
	});

	it("a session whose addendum quotes the folder as earlier guidelines named it keeps its section", async () => {
		const addendum = `Sample old report: ${inGuidelines(getDefaultSessionDirPath(process.cwd(), getAgentDir()))}`;
		const sessionManager = SessionManager.inMemory(process.cwd());
		const first = await turn(sessionManager, "first", addendum);
		const [recorded] = sectionUpdates(first.added);
		expect(recorded?.addendum).toContain(addendum);
		expect(recorded?.session_folder).toBeDefined();

		const next = await turn(sessionManager, "next", addendum);
		expect(sectionUpdates(next.added)).toEqual([]);
		expect(next.prompts[0]).toBe(first.prompts[0]);

		// Without `read` the guideline is left out at first; it comes with the section once `read` is on.
		const later = SessionManager.inMemory(process.cwd());
		await turn(later, "first", addendum, ["bash"]);
		const withRead = sectionUpdates((await turn(later, "with read", addendum)).added);
		expect(withRead).toHaveLength(1);
		expect(withRead[0]?.rules).toContain(IN_SECTION);
		expect(withRead[0]?.session_folder).toMatch(/^<session_folder>\nSession folder of this project: /);
	});

	/** The session as an earlier version recorded it: the folder, or `folder` instead, in the guidelines and no section. */
	async function recordedEarlier(recorder: SessionManager, folder?: string): Promise<SessionManager> {
		const legacy = SessionManager.inMemory(process.cwd());
		for (const entry of recorder.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "system" && message.sections?.session_folder) {
				const { session_folder: folderSection, ...sections } = message.sections;
				const recordedFolder =
					folder ??
					folderSection.replace(
						/^<session_folder>\nSession folder of this project: (.*)\n<\/session_folder>$/,
						"$1",
					);
				await legacy.appendMessage({
					...message,
					sections: { ...sections, rules: sections.rules!.replace(IN_SECTION, inGuidelines(recordedFolder)) },
				});
			} else await legacy.appendMessage(message);
		}
		return legacy;
	}

	function recordedPrompt(sessionManager: SessionManager): string {
		const [prompt] = sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "system" ? [entry.message] : []));
		return getSystemMessageText(prompt!);
	}

	it("a session recorded with the folder in its guidelines keeps it there when it resumes", async () => {
		const recorder = SessionManager.inMemory(process.cwd());
		await turn(recorder, "first");
		const legacy = await recordedEarlier(recorder);
		expect(recordedPrompt(legacy)).not.toContain("<session_folder>");

		const resumed = await turn(legacy, "after the upgrade");
		expect(sectionUpdates(resumed.added)).toEqual([]);
		expect(resumed.prompts[0]).toBe(recordedPrompt(legacy));
	});

	it("a session recorded with the folder in its guidelines and moved to another folder keeps it in the guidelines", async () => {
		const recorder = SessionManager.inMemory(process.cwd());
		await turn(recorder, "first");
		const moved = await recordedEarlier(recorder, "/old/checkout/sessions/--old-checkout--");

		const resumed = await turn(moved, "after the move");
		const updates = sectionUpdates(resumed.added);
		expect(updates.map((update) => Object.keys(update))).toEqual([["rules"]]);
		expect(updates[0]?.rules).toContain(inGuidelines(getDefaultSessionDirPath(process.cwd(), getAgentDir())));
	});
});
