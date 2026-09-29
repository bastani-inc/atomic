import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { getBuiltinPackagePaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { type PackageSource, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	type PiCodingAgentSdk,
	type PiSdkResourceLoader,
	type PiSdkSettingsManager,
	prepareAtomicStageSessionOptions,
} from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

/** A real workflow stage session loads the MCP builtin and a package extension from TypeScript sources. */
const REAL_STAGE_SESSION_TIMEOUT_MS = 60_000;

type McpGatewayTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, string>,
		signal: AbortSignal,
	): Promise<{ details?: { servers?: Array<{ name: string }> } }>;
};

class StageDefaultResourceLoader extends DefaultResourceLoader implements PiSdkResourceLoader {
	constructor(options: {
		readonly cwd: string;
		readonly agentDir: string;
		readonly settingsManager?: PiSdkSettingsManager;
		readonly builtinPackagePaths?: PackageSource[];
	}) {
		super({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager as SettingsManager | undefined,
			builtinPackagePaths: options.builtinPackagePaths,
		});
	}
}

const STAGE_BUILTINS = { workflows: false, subagents: false, "web-access": false, intercom: false } as const;

let root = "";

beforeEach(() => {
	root = makeTempDirectory("workflow-stage-mcp-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("MCP_OAUTH_DIR", join(root, "oauth"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test(
	"workflow stage sessions see package and registered MCP server contributions (#3355)",
	async () => {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const pkgDir = join(root, "acme-mcp");
		await writeFileEnsuringDir(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "acme-mcp",
				atomic: {
					extensions: ["./extensions/register.ts"],
					mcpServers: { "stage-package": { url: "https://package.test/mcp" } },
				},
			}),
		);
		await writeFileEnsuringDir(
			join(pkgDir, "extensions", "register.ts"),
			[
				"export default function (pi: { registerMcpServer(name: string, config: { url: string }): void }) {",
				'\tpi.registerMcpServer("stage-registered", { url: "http://127.0.0.1:4318/mcp" });',
				"}",
			].join("\n"),
		);
		await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));

		const mcpBuiltin = getBuiltinPackagePaths().filter((path) => basename(path) === "mcp");
		assert.equal(mcpBuiltin.length, 1);
		const sdk: PiCodingAgentSdk = {
			getAgentDir: () => agentDir,
			getBuiltinPackagePaths: () => mcpBuiltin,
			SettingsManager,
			DefaultResourceLoader: StageDefaultResourceLoader,
			async createAgentSession(options) {
				const result = await createAgentSession(options as CreateAgentSessionOptions);
				return { session: result.session as unknown as StageSessionRuntime };
			},
		};
		const orchestrationContext = {
			kind: "workflow-stage",
			workflowRunId: "run-3355",
			workflowStageId: "stage-3355",
			workflowStageName: "Stage 3355",
			intercomGroup: "workflow-3355",
			constraints: { disableWorkflowTool: true },
		} satisfies CreateAgentSessionOptions["orchestrationContext"];
		const model = getModel("anthropic", "claude-sonnet-4-5");
		assert.ok(model);
		const stageOptions = await prepareAtomicStageSessionOptions(
			{ cwd, agentDir, builtins: STAGE_BUILTINS, model, orchestrationContext },
			sdk,
		);
		assert.ok(stageOptions?.resourceLoader, "expected a stage resource loader");

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager: stageOptions.settingsManager as SettingsManager,
			resourceLoader: stageOptions.resourceLoader as DefaultResourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			orchestrationContext,
			subagentPolicy: stageOptions.subagentPolicy,
			builtins: STAGE_BUILTINS,
		});
		try {
			const gateway = session.agent.state.tools.find((tool) => tool.name === "mcp") as McpGatewayTool | undefined;
			assert.ok(gateway, "expected the MCP gateway tool in the stage session");
			const status = await gateway.execute("status", {}, new AbortController().signal);
			const names = (status.details?.servers ?? []).map((server) => server.name);
			assert.ok(names.includes("stage-package"), names.join(", "));
			assert.ok(names.includes("stage-registered"), names.join(", "));
		} finally {
			await session.dispose();
		}
	},
	REAL_STAGE_SESSION_TIMEOUT_MS,
);
