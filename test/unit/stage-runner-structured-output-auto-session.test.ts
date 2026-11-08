import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@bastani/pi-ai";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { STRUCTURED_OUTPUT_CLOSING_INSTRUCTION } from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";
import {
	decisionChatModel,
	decisionMessage,
	inferenceUserContent,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";
import { assert, createStageContext, makeOpts } from "./stage-runner-helpers.js";

/**
 * Structural cost, not a slow test: the case builds a real AgentSession with its resource loader and tool registry,
 * which takes over half the default budget on Windows runners.
 */
const REAL_AGENT_SESSION_TIMEOUT_MS = 90_000;

const SCHEMA = Type.Object({ approved: Type.Boolean(), summary: Type.String() }, { additionalProperties: false });
const FINAL_TEXT = "The change is correct and the focused tests pass.";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
});

/** A user message's text, whether the session sent it as a string or as content blocks. */
function userText(content: ReturnType<typeof inferenceUserContent>): string {
	if (typeof content === "string") return content;
	return (content as ReadonlyArray<{ readonly type: string; readonly text?: string }>)
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("");
}

function proseMessage(text: string): AssistantMessage {
	return { ...decisionMessage(), content: [{ type: "text", text }], stopReason: "stop" };
}

test(
	"a real SDK session finishes a schema stage whose model never calls structured_output, through the runtime's own inference (#4565)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-structured-output-auto-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const chatTurns: string[] = [];
		const inferences: Array<{ readonly model: string; readonly state: { readonly finalAssistantText: string } }> = [];
		const { runtime: modelRuntime } = await registeredDecisionRuntime((model, context: TranscriptContext) => {
			const content = inferenceUserContent(context);
			if (typeof content === "string" && content.startsWith('{"state"')) {
				const { state } = JSON.parse(content) as { state: { finalAssistantText: string } };
				inferences.push({ model: `${model.provider}/${model.id}`, state });
				return messageStream(decisionMessage({ approved: true, summary: state.finalAssistantText }));
			}
			chatTurns.push(userText(content));
			return messageStream(proseMessage(FINAL_TEXT));
		});
		const settingsManager = SettingsManager.inMemory({
			decisionModel: "decision-test/chat",
			compaction: { enabled: false },
			sessionSummary: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
		});
		await resourceLoader.reload();
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const { session } = await createAgentSession({
					cwd: root,
					agentDir,
					modelRuntime,
					model: decisionChatModel,
					settingsManager,
					resourceLoader,
					sessionManager: SessionManager.inMemory(root),
					builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
					...(options.tools === undefined ? {} : { tools: options.tools }),
					...(options.customTools === undefined ? {} : { customTools: options.customTools }),
				});
				return session as unknown as Awaited<ReturnType<AgentSessionAdapter["create"]>>;
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { schema: SCHEMA }, defaultCwd: root }),
		);

		try {
			const result = await ctx.prompt("review the change");

			assert.deepEqual(result, { approved: true, summary: FINAL_TEXT });
			assert.deepEqual(chatTurns, [`review the change${STRUCTURED_OUTPUT_CLOSING_INSTRUCTION}`]);
			assert.deepEqual(inferences, [{ model: "decision-test/chat", state: inferences[0]?.state }]);
			assert.equal(inferences[0]?.state.finalAssistantText, FINAL_TEXT);
		} finally {
			await ctx.__dispose();
		}
	},
	REAL_AGENT_SESSION_TIMEOUT_MS,
);
