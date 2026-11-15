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
	sleep,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

/** Three real source CLI children, each loading every builtin extension. */
const CLI_CHILDREN_TIMEOUT_MS = 240_000;
const STEP_TIMEOUT_MS = 60_000;

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
	/** Written by the project workflow module's top-level code when it is imported. */
	readonly marker: string;
}

/** A project whose only project resource is a workflow module that records being imported. */
async function makeScenario(label: string): Promise<Scenario> {
	const root = makeTempDirectory(`project-trust-workflow-${label}-`);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const marker = join(root, "workflow-module-loaded");
	await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ onboardedVersion: "0.0.0" }));
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
	return { root, project, agentDir, marker };
}

interface ListedWorkflows {
	readonly details?: { readonly kind?: string; readonly entries?: readonly { readonly name: string }[] };
}

/** Starts a CLI child in the scenario's project, asks for `/workflow list`, and returns the names it listed. */
async function listWorkflows(scenario: Scenario, args: readonly string[]): Promise<string[]> {
	const client = new RpcClient({
		cliPath,
		cwd: scenario.project,
		runtimeExecutable: bunExecutable(),
		args: [...args, "--offline", "--no-session"],
		env: {
			...CLEARED_STORAGE_ENV,
			ATOMIC_CODING_AGENT_DIR: scenario.agentDir,
			ATOMIC_WORKFLOW_JOURNAL_PATH: join(scenario.root, "journal.sqlite"),
			ANTHROPIC_API_KEY: "test-only-no-requests",
		},
	});
	const listings: ListedWorkflows[] = [];
	try {
		await client.start();
		client.onEvent((event) => {
			if (event.type !== "message_start") return;
			const message = event.message as ListedWorkflows;
			if (message.details?.kind === "list") listings.push(message);
		});
		await client.prompt("/workflow list");
		const deadline = Date.now() + STEP_TIMEOUT_MS;
		while (listings.length === 0) {
			if (Date.now() > deadline)
				throw new Error(`timed out waiting for the workflow listing.\nCLI stderr:\n${client.getStderr()}`);
			await sleep(100);
		}
		return (listings[0]!.details?.entries ?? []).map((entry) => entry.name);
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
			const listedNotApproved = await listWorkflows(notApproved, ["--no-approve"]);
			assert.equal(listedNotApproved.includes(WORKFLOW_NAME), false);
			assert.equal(fileExistsSync(notApproved.marker), false);

			const declined = await makeScenario("declined");
			scenarios.push(declined);
			await writeFileEnsuringDir(
				join(declined.agentDir, "trust.json"),
				`${JSON.stringify({ [declined.project]: false }, null, 2)}\n`,
			);
			const listedDeclined = await listWorkflows(declined, []);
			assert.equal(listedDeclined.includes(WORKFLOW_NAME), false);
			assert.equal(fileExistsSync(declined.marker), false);

			const approved = await makeScenario("approve");
			scenarios.push(approved);
			const listedApproved = await listWorkflows(approved, ["--approve"]);
			assert.ok(listedApproved.includes(WORKFLOW_NAME), listedApproved.join(", "));
			assert.equal(fileExistsSync(approved.marker), true);
		} finally {
			for (const scenario of scenarios) await removeTempRootReleasingBroker(scenario.root, scenario.agentDir);
		}
	},
	CLI_CHILDREN_TIMEOUT_MS,
);
