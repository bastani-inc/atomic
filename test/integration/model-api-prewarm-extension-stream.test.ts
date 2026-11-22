import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { sleep } from "../helpers/runtime.js";

/** A real engine child: the built CLI loading every startup resource, on a loaded runner. */
const ENGINE_TEST_TIMEOUT_MS = 120_000;
/** How long the test waits for the engine to load an API implementation after it has a reason to. */
const MODULE_LOAD_WAIT_MS = 30_000;

/** Records, for every module this process loads, when it loaded and its URL. */
function writeModuleLog(dir: string): { preload: string; log: string } {
	const log = join(dir, "modules.log");
	const hooks = join(dir, "module-log-hooks.mjs");
	writeFileSync(
		hooks,
		`import { appendFileSync } from "node:fs";
export async function load(url, context, nextLoad) {
	appendFileSync(${JSON.stringify(log)}, \`\${Date.now()} \${url}\\n\`);
	return nextLoad(url, context);
}
`,
	);
	const preload = join(dir, "module-log.mjs");
	writeFileSync(
		preload,
		`import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
	);
	return { preload, log };
}

/** When the engine first loaded Atomic's own Anthropic Messages implementation, if it has. */
function anthropicImplementationLoadedAt(log: string): number | undefined {
	if (!existsSync(log)) return undefined;
	const line = readFileSync(log, "utf8")
		.split("\n")
		.find((entry) => /[\\/]api[\\/]anthropic-messages\.js$/.test(entry));
	return line === undefined ? undefined : Number(line.split(" ")[0]);
}

test(
	"an engine whose model an extension streams itself loads Atomic's implementation of that api only once a switch selects a model that uses it",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-prewarm-extension-stream-"));
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(project);
		// An extension that streams its provider's requests itself, under the same api as Atomic's Anthropic provider.
		writeFileSync(
			join(agentDir, "extensions", "proxy.ts"),
			`export default function (pi) {
	pi.registerProvider("proxy", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-only",
		api: "anthropic-messages",
		streamSimple: () => {
			throw new Error("no request is sent in this test");
		},
		models: [
			{
				id: "proxy-model",
				name: "proxy-model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
	});
}
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "proxy", defaultModel: "proxy-model", onboardedVersion: "0.0.0" }),
		);
		const { preload, log } = writeModuleLog(root);
		const client = new RpcClient({
			cliPath: fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url)),
			cwd: project,
			runtimeExecutable: process.execPath,
			runtimeArgs: ["--import", pathToFileURL(preload).href],
			args: ["--offline", "--no-session", "--no-mcp", "--approve"],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "test-only-no-requests" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		try {
			await client.start();
			await client.waitForInteractiveEngineResources();
			const state = await client.getState();
			assert.equal(state.model?.provider, "proxy");
			// Long enough for a prewarm the engine starts once its resources are ready to reach the module.
			await sleep(2_000);
			const switchedAt = Date.now();
			await client.setModel("anthropic", "claude-sonnet-4-5");
			const deadline = Date.now() + MODULE_LOAD_WAIT_MS;
			let loadedAt = anthropicImplementationLoadedAt(log);
			while (loadedAt === undefined && Date.now() < deadline) {
				await sleep(50);
				loadedAt = anthropicImplementationLoadedAt(log);
			}
			// The switch to a model of Atomic's own Anthropic provider loads it, and nothing loaded it before.
			assert.ok(loadedAt !== undefined, "the switch loads the implementation its model uses");
			assert.ok(loadedAt >= switchedAt, `loaded ${switchedAt - loadedAt} ms before the switch`);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	ENGINE_TEST_TIMEOUT_MS,
);
