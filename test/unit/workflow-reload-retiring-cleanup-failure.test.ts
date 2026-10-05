import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
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
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

const HOST_RELOAD_TIMEOUT_MS = 120_000;
const reloadCases = ["transactional", "nontransactional", "cli-services", "successful"] as const;
const WAIT_FOR_MS = 20_000;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + WAIT_FOR_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

function gatedWorkflowSource(): string {
	return `import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "gated-reload",
	description: "Wait between workflow steps until released.",
	inputs: {},
	outputs: { released: Type.Boolean() },
	run: async (ctx) => {
		await ctx.stage("reload-worker", { model: "decision-test/chat", tools: ["bash", "intercom"] })
			.prompt("Wait for the reload steering check.");
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

test.each(reloadCases)(
	"workflow status, stage-name/ID steering and pause/resume survive a %s reload (#3425)",
	async (mode) => {
		const cwd = process.cwd();
		const root = await mkdtemp(join(tmpdir(), "atomic-reload-cleanup-failure-"));
		const project = join(root, "project");
		const agentDir = join(root, "home/.atomic/agent");
		const releasePath = join(root, "release");
		const definition = join(project, ".atomic/workflows/gated-reload.ts");
		await mkdir(dirname(definition), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(definition, gatedWorkflowSource());
		process.chdir(project);
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("USERPROFILE", join(root, "home"));
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("TYPESAFE_API_KEY", "");
		setDurableBackend(new InMemoryDurableBackend());
		const { runtime: modelRuntime } = await registeredDecisionRuntime((_model, context) => {
			if (context.messages.at(-1)?.role === "toolResult") return messageStream(finalReply());
			const stream = createAssistantMessageEventStream();
			const reply: AssistantMessage = {
				...finalReply(),
				content: [
					{
						type: "toolCall",
						id: "wait-for-release",
						name: "bash",
						arguments: {
							command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) clearInterval(timer); }, 20);`)}`,
							wait: { kind: "foreground", budgetMs: HOST_RELOAD_TIMEOUT_MS },
						},
					},
				],
				stopReason: "toolUse",
			};
			stream.push({ type: "done", reason: "toolUse", message: reply });
			stream.end();
			return stream;
		});
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
				if (mode !== "successful" && event.reason === "reload" && startReason === "startup")
					throw new Error("forced retiring cleanup failure");
			});
		};
		const Loader = mode === "nontransactional" ? NontransactionalResourceLoader : DefaultResourceLoader;
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
						builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
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
				() =>
					findRun()?.stages.some((stage) => stage.sessionId !== undefined && stage.status === "running") === true,
				"the live stage to register before reload",
			);
			const runId = findRun()?.id;
			assert.ok(runId);
			const stage = findRun()?.stages.find((candidate) => candidate.name === "reload-worker");
			assert.ok(stage);
			const intercom = (id: string, params: { action: string; group?: string; to?: string; message?: string }) => {
				const tool = session.extensionRunner.getToolDefinition("intercom");
				assert.ok(tool, JSON.stringify(session.getAllTools()));
				return tool.execute(
					id,
					params,
					new AbortController().signal,
					undefined,
					session.extensionRunner.createToolContext(id, undefined),
				);
			};
			const joined = await intercom("join-workflow", { action: "join", group: `workflow:${runId}` });
			assert.equal(joined.isError, false, JSON.stringify(joined));
			const steer = async (label: string) => {
				const listing = await intercom(`list-${label}`, { action: "list" });
				assert.ok(
					JSON.stringify(listing).includes(`workflow:${runId}/${stage.id}`),
					`the canonical live stage stays listed: ${JSON.stringify(listing)}`,
				);
				assert.ok(JSON.stringify(listing).includes(`workflow:${runId}/**`), "future sticky targets stay listed");
				for (const segment of [stage.name, stage.id]) {
					const sent = await intercom(`send-${label}-${segment}`, {
						action: "send",
						to: `workflow:${runId}/${segment}`,
						message: `steering-${label}-${segment}`,
					});
					assert.equal(sent.isError, false, JSON.stringify(sent));
					assert.ok(typeof sent.details === "object" && sent.details !== null && "delivered" in sent.details);
					assert.equal(sent.details.delivered, true, JSON.stringify(sent));
				}
				const future = await intercom(`future-${label}`, {
					action: "send",
					to: `workflow:${runId}/future-worker`,
					message: `future-${label}`,
				});
				assert.equal(future.isError, false, JSON.stringify(future));
				assert.ok(typeof future.details === "object" && future.details !== null && "queued" in future.details);
				assert.equal(future.details.queued, true, "unmaterialized targets still accept sticky steering");
			};
			await steer("before-reload");

			let reloadError: Error | undefined;
			if (mode === "successful") await session.reload();
			else
				await assert.rejects(session.reload(), (error: Error) => {
					reloadError = error;
					return true;
				});
			await steer("after-reload");

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
			if (mode !== "successful")
				assert.match(
					reloadError?.message ?? "",
					/Reload retiring cleanup failed: .*forced retiring cleanup failure/,
				);
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
			await writeFile(releasePath, "release");
			await waitFor(() => findRun()?.endedAt !== undefined, "the workflow to complete after reload");
			assert.equal(findRun()?.status, "completed");
		} finally {
			await writeFile(releasePath, "release");
			await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle before disposal").catch(() => {});
			await session.dispose().catch((error: Error & { code?: string }) => {
				assert.equal(error.code, "ShutdownFailed");
			});
			setDurableBackend(undefined);
			vi.unstubAllEnvs();
			process.chdir(cwd);
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	HOST_RELOAD_TIMEOUT_MS,
);
