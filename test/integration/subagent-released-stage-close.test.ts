import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	subagentChildRecordsAppended,
	WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE,
	WORKFLOW_STAGE_END_CHILDREN_STATE,
	type WorkflowStageChildrenEnd,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** A real stage session loads the editable subagents extension. */
const STAGE_TIMEOUT_MS = 120_000;

test.each(["shipped", "wrapped"] as const)(
	"a released workflow stage that ends for good records its settled child stage-closed (#3760, %s extension)",
	async (extensionKind) => {
		const cwd = makeTempDirectory("atomic-released-stage-close-");
		const agentDir = join(cwd, "profile");
		await mkdir(agentDir, { recursive: true });
		const extension = fileURLToPath(new URL("../../packages/subagents/src/extension/index.ts", import.meta.url));
		// An extension that loads the shipped one itself gets no host record writer.
		const entry = extensionKind === "shipped" ? extension : join(cwd, "wrapped-subagents.ts");
		if (extensionKind === "wrapped")
			await writeFile(
				entry,
				`import subagents from ${JSON.stringify(extension)};\nexport default (pi) => subagents(pi);\n`,
			);
		const store = await JsonlSessionStore.open(join(cwd, "sessions"), {
			exactDirectory: true,
			scanExisting: false,
		});
		const manager = await SessionManager.create(store, cwd);
		const sessionId = manager.getSessionId();
		const childId = "settled-worker:0";
		const orchestration = {
			kind: "workflow-stage",
			workflowRunId: "released-run",
			workflowStageId: "stage",
			workflowStageName: "stage",
		} as const;
		await manager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
			version: 1,
			childId,
			runId: "settled-worker",
			index: 0,
			agent: "worker",
			cwd,
			state: "terminal",
			terminalStatus: "ok",
			owner: { ...orchestration, sessionId },
		});
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		const errors = vi.spyOn(console, "error");
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			additionalExtensionPaths: [entry],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
		});
		await loader.reload();
		const boundary = new WorkflowStageAdmissionBoundary();
		const extensionState = new Map<string, object>();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			sessionManager: manager,
			resourceLoader: loader,
			builtins: {
				subagents: extensionKind === "shipped",
				intercom: false,
				mcp: false,

				"web-access": false,
			},
			orchestrationContext: {
				...orchestration,
				constraints: { disableWorkflowTool: true },
				messageAdmission: { boundary, extensionState, isOpen: () => boundary.isOpen() },
			},
		});
		let released = false;
		try {
			const watch = extensionState.get(WORKFLOW_STAGE_END_CHILDREN_STATE) as WorkflowStageChildrenEnd | undefined;
			assert.ok(watch, JSON.stringify(loader.getExtensions().errors));
			// The stage gives its session up while it waits; then its run ends and closes it for good, as
			// closeGeneration(true) does for a generation that already closed resumably.
			await session.release();
			released = true;
			await boundary.close();
			extensionState.set(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE, { closedForGood: true });
			watch.endChildren();
			await subagentChildRecordsAppended(sessionId);

			const durable = (await store.load(sessionId)).entries.flatMap((entry) =>
				entry.type === "custom" &&
				entry.customType === SUBAGENT_CHILD_RECORD_TYPE &&
				(entry.data as { childId?: string }).childId === childId
					? [(entry.data as { terminalStatus?: string }).terminalStatus]
					: [],
			);
			assert.deepEqual(durable, ["ok", "stage-closed"], "the settled child ends with its stage on disk");
			assert.deepEqual(
				errors.mock.calls.filter((call) => String(call[0]).includes("subagent-child record")),
				[],
				"closing the released stage reports no failed save",
			);
		} finally {
			errors.mockRestore();
			if (!released) await session.dispose();
			await store.close();
			vi.unstubAllEnvs();
			removeTempDirectory(cwd);
		}
	},
	STAGE_TIMEOUT_MS,
);
