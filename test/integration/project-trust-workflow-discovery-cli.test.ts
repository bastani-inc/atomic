import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	bunExecutable,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

/** Three real source CLI children, each loading every builtin extension. */
const CLI_CHILDREN_TIMEOUT_MS = 240_000;

const repositoryRoot = join(moduleDir(import.meta.url), "../..");
const cliPath = join(repositoryRoot, "packages/coding-agent/src/cli.ts");
const WORKFLOW_NAME = "project-marker-flow";

/** Inherited storage selections would decide where the children write instead of the scenario. */
const CLEARED_STORAGE_ENV = {
	ATOMIC_STORAGE: "",
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
};

interface Scenario {
	readonly root: string;
	readonly project: string;
	readonly agentDir: string;
	readonly providerPath: string;
	/** Written by the project workflow module's top-level code when it is imported. */
	readonly marker: string;
}

/** A project whose only project resource is a workflow module that records being imported. */
async function makeScenario(label: string): Promise<Scenario> {
	const root = makeTempDirectory(`project-trust-workflow-${label}-`);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const providerPath = join(root, "trust-list-provider.ts");
	const marker = join(root, "workflow-module-loaded");
	await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ onboardedVersion: "0.0.0" }));
	await writeFileEnsuringDir(
		providerPath,
		[
			'import { createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";',
			"export default function (pi) {",
			'  pi.registerProvider("trust-list-fixture", {',
			'    api: "trust-list-fixture",',
			'    apiKey: "fixture-only",',
			'    baseUrl: "http://127.0.0.1:1/unused",',
			'    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],',
			"    streamSimple(model, context) {",
			"      const stream = createAssistantMessageEventStream();",
			'      const hasToolResult = context.messages.some((m) => m.role === "toolResult");',
			"      const message = {",
			'        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),',
			'        content: hasToolResult ? [{ type: "text", text: "done" }] : [{ type: "toolCall", id: "list-1", name: "workflow", arguments: { action: "list" } }],',
			'        stopReason: hasToolResult ? "stop" : "toolUse",',
			"        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },",
			"      };",
			'      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });',
			"      return stream;",
			"    },",
			"  });",
			"}",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(project, ".atomic/workflows/marker.ts"),
		[
			`import { writeFileSync } from "node:fs";`,
			`import { workflow } from "@bastani/atomic/workflows";`,
			`writeFileSync(${JSON.stringify(marker)}, "loaded");`,
			`export default workflow({`,
			`  name: ${JSON.stringify(WORKFLOW_NAME)},`,
			`  description: "records that it was loaded",`,
			`  inputs: {},`,
			`  outputs: {},`,
			`  run: async (ctx) => { await ctx.tool("record", {}, async () => "recorded"); return {}; },`,
			`});`,
		].join("\n"),
	);
	return { root, project, agentDir, providerPath, marker };
}

async function listProjectWorkflows(scenario: Scenario, args: readonly string[]): Promise<string[]> {
	const client = new RpcClient({
		cliPath,
		cwd: scenario.project,
		runtimeExecutable: bunExecutable(),
		args: [
			...args,
			"--offline",
			"--no-session",
			"--extension",
			scenario.providerPath,
			"--provider",
			"trust-list-fixture",
			"--model",
			"fixture",
		],
		env: {
			...CLEARED_STORAGE_ENV,
			ATOMIC_CODING_AGENT_DIR: scenario.agentDir,
			ATOMIC_WORKFLOW_JOURNAL_PATH: join(scenario.root, "journal.sqlite"),
		},
	});
	const listedNames: string[] = [];
	try {
		await client.start();
		client.onEvent((event) => {
			if (event.type !== "tool_execution_end" || event.toolName !== "workflow") return;
			const details = (event.result as { details?: { items?: Array<{ name: string }> } } | undefined)?.details;
			for (const item of details?.items ?? []) listedNames.push(item.name);
		});
		await client.promptAndWait("list workflows");
		return listedNames;
	} finally {
		await client.stop();
	}
}

test(
	"the CLI loads a project's workflow modules only when the project is trusted",
	async () => {
		const scenarios: Scenario[] = [];
		try {
			const notApproved = await makeScenario("no-approve");
			scenarios.push(notApproved);
			const listedNotApproved = await listProjectWorkflows(notApproved, ["--no-approve"]);
			assert.equal(listedNotApproved.includes(WORKFLOW_NAME), false);
			assert.equal(fileExistsSync(notApproved.marker), false);

			const declined = await makeScenario("declined");
			scenarios.push(declined);
			await writeFileEnsuringDir(
				join(declined.agentDir, "trust.json"),
				`${JSON.stringify({ [declined.project]: false }, null, 2)}\n`,
			);
			const listedDeclined = await listProjectWorkflows(declined, []);
			assert.equal(listedDeclined.includes(WORKFLOW_NAME), false);
			assert.equal(fileExistsSync(declined.marker), false);

			const approved = await makeScenario("approve");
			scenarios.push(approved);
			const listedApproved = await listProjectWorkflows(approved, ["--approve"]);
			assert.ok(listedApproved.includes(WORKFLOW_NAME), listedApproved.join(", "));
			assert.equal(fileExistsSync(approved.marker), true);
		} finally {
			for (const scenario of scenarios) await removeTempRootReleasingBroker(scenario.root, scenario.agentDir);
		}
	},
	CLI_CHILDREN_TIMEOUT_MS,
);
