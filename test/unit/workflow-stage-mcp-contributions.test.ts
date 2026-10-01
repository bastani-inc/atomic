import assert from "node:assert/strict";
import { createServer } from "node:http";
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

/** A real workflow stage session discovers and calls native MCP tools from package and extension contributions. */
const REAL_STAGE_SESSION_TIMEOUT_MS = 60_000;

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
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test(
	"workflow stage sessions discover and call native package and registered MCP tools (#3355)",
	async () => {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const pkgDir = join(root, "acme-mcp");
		const calls: Array<{ server: string; tool: string; arguments: unknown }> = [];
		const server = createServer(async (request, response) => {
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { name: string; arguments: unknown };
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const name = request.url === "/package" ? "stage-package" : "stage-registered";
			if (message.method === "tools/call") {
				calls.push({ server: name, tool: message.params!.name, arguments: message.params!.arguments });
			}
			const result =
				message.method === "initialize"
					? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }
					: message.method === "tools/call"
						? { content: [{ type: "text", text: `${name} native result` }] }
						: {
								tools: [
									{
										name: "echo",
										description: "Workflow stage fixture echo",
										inputSchema: {
											type: "object",
											properties: { text: { type: "string" } },
											required: ["text"],
										},
									},
								],
							};
			response
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			const url = `http://127.0.0.1:${address.port}`;
			await writeFileEnsuringDir(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "acme-mcp",
					pi: {
						extensions: ["./extensions/register.ts"],
						mcpServers: { "stage-package": { url: `${url}/package`, exposure: "direct" } },
					},
				}),
			);
			await writeFileEnsuringDir(
				join(pkgDir, "extensions", "register.ts"),
				[
					'export default function (pi: { registerMcpServer(name: string, config: { url: string; exposure: "direct" }): void }) {',
					`\tpi.registerMcpServer("stage-registered", { url: ${JSON.stringify(`${url}/registered`)}, exposure: "direct" });`,
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
				await vi.waitFor(
					() => {
						for (const name of ["mcp__stage_package__echo", "mcp__stage_registered__echo"]) {
							assert.ok(session.getActiveToolNames().includes(name), `expected native tool ${name}`);
						}
					},
					{ timeout: 10_000 },
				);
				for (const serverName of ["stage-package", "stage-registered"]) {
					const name = `mcp__${serverName.replaceAll("-", "_")}__echo`;
					const tool = session.agent.state.tools.find((entry) => entry.name === name);
					assert.ok(tool, `expected native tool ${name}`);
					const result = await tool.execute(name, { text: "stage contribution" }, new AbortController().signal);
					assert.deepEqual(result.content, [{ type: "text", text: `${serverName} native result` }]);
				}
				assert.deepEqual(calls, [
					{ server: "stage-package", tool: "echo", arguments: { text: "stage contribution" } },
					{ server: "stage-registered", tool: "echo", arguments: { text: "stage contribution" } },
				]);
			} finally {
				await session.dispose();
			}
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	},
	REAL_STAGE_SESSION_TIMEOUT_MS,
);
