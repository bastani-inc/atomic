/**
 * #3811 at the SDK boundary: a host that disposes an `AgentSession` as soon as a workflow run reports that it
 * ended must still find the run's terminal status in the journal it supplied.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai";
import { test, vi } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";
import { journalEventTypes, journalWithAppendLatency } from "../helpers/workflow-ended-run-host.js";

/** A real resource loader and SDK session, and a full session disposal. */
const SDK_SESSION_TIMEOUT_MS = 120_000;
const JOURNAL_ROUND_TRIP_MS = 50;

const endingWorkflowSource = `import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "quick",
	description: "Ends at once.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("step", {}, async () => true);
		return {};
	},
});
`;

function doneReply(): AssistantMessage {
	return { ...decisionMessage(), content: [{ type: "text", text: "Done." }], stopReason: "stop" };
}

test(
	"a session disposed as its workflow run reports it ended leaves the run completed in the supplied journal (#3811)",
	async () => {
		const cwd = process.cwd();
		const root = await mkdtemp(join(tmpdir(), "atomic-dispose-ended-run-"));
		const project = join(root, "project");
		const agentDir = join(root, "home/.atomic/agent");
		const definition = join(project, ".atomic/workflows/quick.ts");
		await mkdir(dirname(definition), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(definition, endingWorkflowSource);
		process.chdir(project);
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("USERPROFILE", join(root, "home"));
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		setDurableBackend(undefined);
		const memory = new MemoryRunJournal();
		const { runtime: modelRuntime } = await registeredDecisionRuntime(() => messageStream(doneReply()));
		const settingsManager = SettingsManager.inMemory({
			routerModel: "decision-test/chat",
			compaction: { enabled: false },
			sessionSummary: { enabled: false },
		});
		const ended = Promise.withResolvers<string>();
		const resourceLoader = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("workflow_lifecycle", (event) => {
						const { target } = event;
						if (target.kind === "run" && target.runId === event.rootRunId && target.status === "completed")
							ended.resolve(event.rootRunId);
					});
					workflowExtension(pi as unknown as ExtensionAPI);
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			modelRuntime,
			model: decisionModel,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(project),
			journal: journalWithAppendLatency(memory, JOURNAL_ROUND_TRIP_MS),
		});
		try {
			await session.bindExtensions({});
			const command = session.extensionRunner.getCommand("workflow");
			assert.ok(command, "the /workflow command must be registered on the real host");
			await command.handler("quick --no-picker", session.extensionRunner.createCommandContext());
			const runId = await ended.promise;

			const disposal = await session.dispose().then(
				() => undefined,
				(error: AggregateError) => error,
			);

			const reported = disposal?.errors.map((error: Error) => error.message) ?? [];
			assert.deepEqual(
				reported.filter((message: string) => /ended but its ending was not recorded/.test(message)),
				[],
			);
			assert.equal((await memory.getRun(runId))?.status, "completed");
			const events = await journalEventTypes(memory, runId);
			assert.ok(events.includes("StatusChanged"), events.join(", "));
			assert.equal((await memory.leaseState(runId))?.holderId ?? null, null);
		} finally {
			await session.dispose().catch(() => {});
			setDurableBackend(undefined);
			vi.unstubAllEnvs();
			process.chdir(cwd);
			await rm(root, { recursive: true, force: true });
		}
	},
	SDK_SESSION_TIMEOUT_MS,
);
