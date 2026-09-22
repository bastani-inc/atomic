/**
 * A workflow run that survives a preserving host `/reload` must still create
 * stages afterwards. Issue #3201: the launch generation's `pi` and command ctx
 * go stale, so stage creation and the model catalog have to resolve the live
 * generation instead.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, vi } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import { trackLiveHostGeneration } from "../../packages/workflows/src/extension/live-host-generation.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import { decisionModel, messageStream, registeredDecisionRuntime } from "../helpers/structured-output.js";
import { workflowDecisionMessage } from "../helpers/workflow-router.js";

/** Real resource loader, real SDK session, and a real `/reload` transaction. */
const HOST_RELOAD_STAGE_TIMEOUT_MS = 120_000;
const WAIT_FOR_MS = 20_000;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + WAIT_FOR_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

function gatedStageWorkflowSource(releasePath: string): string {
	return `import { existsSync } from "node:fs";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "stale-ctx-repro",
	description: "Wait in a tool node, then create one model stage.",
	inputs: {},
	outputs: { reply: Type.String() },
	run: async (ctx) => {
		await ctx.tool("wait-for-release", {}, ({ signal }) =>
			new Promise((resolve, reject) => {
				const timer = setInterval(() => {
					if (!existsSync(${JSON.stringify(releasePath)})) return;
					clearInterval(timer);
					resolve({ released: true });
				}, 10);
				signal?.addEventListener("abort", () => {
					clearInterval(timer);
					reject(new Error("aborted"));
				}, { once: true });
			}),
		);
		const reply = await ctx
			.stage("after-reload", { model: "decision-test/chat" })
			.prompt("Reply with exactly the word OK and nothing else.");
		return { reply: String(reply) };
	},
});
`;
}

test(
	"a stage created after a preserving host /reload uses the live generation (#3201)",
	async () => {
		const cwd = process.cwd();
		const root = await mkdtemp(join(tmpdir(), "atomic-stage-after-reload-"));
		const project = join(root, "project");
		const agentDir = join(root, "home/.atomic/agent");
		const releasePath = join(root, "release");
		await mkdir(project, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		process.chdir(project);
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("USERPROFILE", join(root, "home"));
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("TYPESAFE_API_KEY", "");
		setDurableBackend(new InMemoryDurableBackend());
		const { runtime: modelRuntime } = await registeredDecisionRuntime(() =>
			messageStream(workflowDecisionMessage({ estimatedDuration: "15min", workflowType: "none", maxBudget: {} })),
		);
		const settingsManager = SettingsManager.inMemory({
			routerModel: "decision-test/chat",
			compaction: { enabled: false },
			sessionSummary: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
			extensionFactories: [(pi) => workflowExtension(pi as unknown as ExtensionAPI)],
		});
		const definition = join(project, ".atomic/workflows/stale-ctx-repro.ts");
		await mkdir(dirname(definition), { recursive: true });
		await writeFile(definition, gatedStageWorkflowSource(releasePath));
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: project,
			agentDir,
			modelRuntime,
			model: decisionModel,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(project),
		});
		const store = currentWorkflowStore();
		const findRun = () => store.runs().find((run) => run.name === "stale-ctx-repro");
		try {
			await session.bindExtensions({});
			const launchRunner = session.extensionRunner;
			const command = launchRunner.getCommand("workflow");
			assert.ok(command, "the /workflow command must be registered on the real host");
			await command.handler("stale-ctx-repro --no-picker", launchRunner.createCommandContext());
			await waitFor(
				() =>
					findRun()?.toolNodes?.some((node) => node.name === "wait-for-release" && node.status === "running") ===
					true,
				"the gate tool node to start",
			);

			await session.reload({ reason: "reload", failOnExtensionErrors: true });
			assert.notEqual(session.extensionRunner, launchRunner, "the SDK transaction replaced the runner");
			assert.equal(findRun()?.status, "running", "a preserving reload keeps the run in flight");

			await writeFile(releasePath, "release");
			await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle after the reload");
			const run = findRun();
			assert.ok(run);
			const stage = run.stages.find((candidate) => candidate.name === "after-reload");
			assert.equal(
				run.status,
				"completed",
				`run error=${run.error ?? ""}; stage status=${stage?.status ?? "missing"}; stage error=${stage?.error ?? ""}`,
			);
			assert.equal(stage?.status, "completed");
			assert.doesNotMatch(run.error ?? "", /extension ctx is stale/);
			assert.deepEqual(
				(stage?.warnings ?? []).filter((warning) => /model catalog unavailable/.test(warning)),
				[],
				"the stage model catalog must read the live registry, not the stale launch ctx",
			);
			assert.equal(stage?.model, "decision-test/chat");
		} finally {
			if (findRun()?.endedAt === undefined) await writeFile(releasePath, "release").catch(() => {});
			await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle before disposal").catch(() => {});
			await session.dispose();
			setDurableBackend(undefined);
			vi.unstubAllEnvs();
			process.chdir(cwd);
			await rm(root, { recursive: true, force: true });
		}
	},
	HOST_RELOAD_STAGE_TIMEOUT_MS,
);

type SessionHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];
type SessionContext = Parameters<SessionHandler>[1];

function generationHost(scope: object): {
	readonly pi: ExtensionAPI;
	readonly emit: (event: string, ctx: SessionContext) => void;
} {
	const handlers = new Map<string, SessionHandler[]>();
	const pi: ExtensionAPI = {
		lifecycleScope: scope,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	return {
		pi,
		emit: (event, ctx) => {
			for (const handler of handlers.get(event) ?? []) handler({ reason: "reload" }, ctx);
		},
	};
}

test("a rolled-back successor generation hands the run back to its live predecessor (#3201)", () => {
	const scope = {};
	const predecessor = generationHost(scope);
	const resolve = trackLiveHostGeneration(predecessor.pi);
	assert.equal(resolve().pi, predecessor.pi);

	const successor = generationHost(scope);
	trackLiveHostGeneration(successor.pi);
	const successorContext: SessionContext = { model: decisionModel, ui: { notify() {} } };
	successor.emit("session_start", successorContext);
	assert.equal(resolve().pi, successor.pi, "the transactional successor is live once it loads");
	assert.equal(
		resolve().modelContext,
		successorContext,
		"the successor's session_start ctx is the live model context",
	);

	successor.emit("session_shutdown", undefined);
	assert.equal(resolve().pi, predecessor.pi, "a rolled-back successor must not stay the live generation");

	predecessor.emit("session_shutdown", undefined);
	assert.equal(resolve().pi, predecessor.pi, "with no live generation the launch surface is the only fallback");
});
