import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai";
import { test, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-services.js";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

const HOST_RELOAD_TIMEOUT_MS = 120_000;
const WAIT_FOR_MS = 20_000;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + WAIT_FOR_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

function gatedWorkflowSource(releasePath: string): string {
	return `import { existsSync } from "node:fs";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "gated-reload",
	description: "Wait between workflow steps until released.",
	inputs: {},
	outputs: { released: Type.Boolean() },
	run: async (ctx) => {
		await ctx.tool("checkpoint", {}, async () => true);
		await new Promise((resolve) => {
			const timer = setInterval(() => {
				if (!existsSync(${JSON.stringify(releasePath)})) return;
				clearInterval(timer);
				resolve(true);
			}, 10);
		});
		return { released: true };
	},
});
`;
}

function finalReply(): AssistantMessage {
	return { ...decisionMessage(), content: [{ type: "text", text: "OK" }], stopReason: "stop" };
}

class NontransactionalResourceLoader extends DefaultResourceLoader {
	supportsTransactionalReload(): boolean {
		return false;
	}
}

test.each(["transactional", "nontransactional", "cli-services"] as const)(
	"workflow status and pause/resume still control in-flight runs after a %s retiring-cleanup failure (#3425)",
	async (mode) => {
		const cwd = process.cwd();
		const root = await mkdtemp(join(tmpdir(), "atomic-reload-cleanup-failure-"));
		const project = join(root, "project");
		const agentDir = join(root, "home/.atomic/agent");
		const releasePath = join(root, "release");
		const definition = join(project, ".atomic/workflows/gated-reload.ts");
		await mkdir(dirname(definition), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(definition, gatedWorkflowSource(releasePath));
		process.chdir(project);
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("USERPROFILE", join(root, "home"));
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("TYPESAFE_API_KEY", "");
		setDurableBackend(new InMemoryDurableBackend());
		const { runtime: modelRuntime } = await registeredDecisionRuntime((_model, context) =>
			messageStream(context.messages.at(-1)?.role === "toolResult" ? finalReply() : decisionMessage({ ok: true })),
		);
		const settingsManager = SettingsManager.inMemory({
			routerModel: "decision-test/chat",
			compaction: { enabled: false },
			sessionSummary: { enabled: false },
		});
		const failingRetirement: ExtensionFactory = (pi) => {
			let startReason: string | undefined;
			pi.on("session_start", (event) => {
				startReason = event.reason;
			});
			pi.on("session_shutdown", (event) => {
				if (event.reason === "reload" && startReason === "startup")
					throw new Error("forced retiring cleanup failure");
			});
		};
		const Loader = mode === "transactional" ? DefaultResourceLoader : NontransactionalResourceLoader;
		const resourceLoader = new Loader({
			cwd: project,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
			extensionFactories: [(pi) => workflowExtension(pi as unknown as ExtensionAPI), failingRetirement],
		});
		await resourceLoader.reload();
		const { session } =
			mode === "cli-services"
				? await createAgentSessionFromServices({
						services: await createAgentSessionServices({
							cwd: project,
							agentDir,
							modelRuntime,
							settingsManager,
							resourceLoaderOptions: {
								builtinPackagePaths: [],
								noExtensions: true,
								extensionFactories: [
									(pi) => workflowExtension(pi as unknown as ExtensionAPI),
									failingRetirement,
								],
							},
						}),
						model: decisionModel,
						sessionManager: SessionManager.inMemory(project),
					})
				: await createAgentSession({
						cwd: project,
						agentDir,
						modelRuntime,
						model: decisionModel,
						builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
						settingsManager,
						resourceLoader,
						sessionManager: SessionManager.inMemory(project),
					});
		const store = currentWorkflowStore();
		const findRun = () => store.runs().find((run) => run.name === "gated-reload");
		try {
			await session.bindExtensions({});
			const launchRunner = session.extensionRunner;
			const command = launchRunner.getCommand("workflow");
			assert.ok(command, "the /workflow command must be registered on the real host");
			await command.handler("gated-reload --no-picker", launchRunner.createCommandContext());
			await waitFor(
				() => findRun()?.toolNodes?.some((node) => node.status === "completed") === true,
				"the checkpoint to complete before the gate",
			);
			const runId = findRun()?.id;
			assert.ok(runId);

			let reloadError: Error | undefined;
			await assert.rejects(session.reload(), (error: Error) => {
				reloadError = error;
				return true;
			});

			const workflowTool = session.agent.state.tools.find((tool) => tool.name === "workflow");
			assert.ok(workflowTool, "the workflow tool stays registered after the failed reload");
			const status = await workflowTool.execute(
				"status-after-reload",
				{ action: "status" },
				new AbortController().signal,
			);
			const [content] = status.content;
			const text = content?.type === "text" ? content.text : "";
			assert.match(text, /runs: 1 \(1 in flight\)/);
			assert.ok(text.includes(runId), "the in-flight run stays reachable from the session");
			assert.match(reloadError?.message ?? "", /Reload retiring cleanup failed: .*forced retiring cleanup failure/);
			const pause = await workflowTool.execute(
				"pause-after-reload",
				{ action: "pause", runId },
				new AbortController().signal,
			);
			assert.equal(pause.details.status, "paused");
			assert.equal(findRun()?.status, "paused");
			const resume = await workflowTool.execute(
				"resume-after-reload",
				{ action: "resume", runId },
				new AbortController().signal,
			);
			assert.equal(resume.details.status, "ok");
			assert.equal(findRun()?.status, "running");
		} finally {
			await writeFile(releasePath, "release");
			await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle before disposal").catch(() => {});
			await session.dispose().catch((error: Error & { code?: string }) => {
				assert.equal(error.code, "ShutdownFailed");
			});
			setDurableBackend(undefined);
			vi.unstubAllEnvs();
			process.chdir(cwd);
			await rm(root, { recursive: true, force: true });
		}
	},
	HOST_RELOAD_TIMEOUT_MS,
);
