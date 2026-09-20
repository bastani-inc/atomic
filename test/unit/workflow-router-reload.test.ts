// #3089: live discovery/reload must publish routing candidates and contracts as one generation.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import factory from "../../packages/workflows/src/extension/index.js";
import type {
	PiCommandOptions,
	PiExecuteContext,
	PiToolOpts,
	WorkflowResourceInfo,
	WorkflowToolArgs,
} from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowRegisteredToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { messageStream } from "../helpers/structured-output.js";
import {
	workflowDecisionMessage as decisionMessage,
	workflowRouterContext,
	workflowRouterState,
} from "../helpers/workflow-router.js";

const originalCwd = process.cwd();
const roots: string[] = [];
afterEach(async () => {
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	store.clear();
	setDurableBackend(undefined);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function definition(path: string, name: string, description: string, input = "task"): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
export default workflow({ name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)},
inputs: { ${JSON.stringify(input)}: Type.String() }, outputs: {}, run: async () => ({}) });`,
		"utf8",
	);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "atomic-router-reload-"));
	roots.push(root);
	const project = join(root, "project");
	const home = join(root, "home");
	const user = join(home, ".atomic", "agent");
	await mkdir(project, { recursive: true });
	await mkdir(user, { recursive: true });
	process.chdir(project);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", "");
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
	vi.stubEnv("TYPESAFE_API_KEY", "");
	let resources: readonly WorkflowResourceInfo[] = [];
	let failRefresh = false;
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const admissions = vi.spyOn(backend, "registerWorkflow");
	const state = createWorkflowExtensionRuntimeState(
		{
			disableAsyncDiscovery: true,
			refreshWorkflowResources: async () => {
				if (failRefresh) throw new Error("fixture refresh failed");
				return resources;
			},
		},
		{},
	);
	const execute = makeExecuteWorkflowTool(
		(ctx) => state.runtimeForContext(ctx),
		state.reloadWorkflowResources,
		state.ensureWorkflowResourcesLoaded,
	);
	return {
		root,
		project,
		user,
		state,
		execute,
		admissions,
		registryNames: () => state.runtimeProxy.registry.names(),
		setResources: (next: readonly WorkflowResourceInfo[]) => {
			resources = next;
		},
		fail: (value: boolean) => {
			failRefresh = value;
		},
		noAdmission: () => {
			assert.equal(admissions.mock.calls.length, 0);
			assert.equal(store.runs().length, 0);
		},
	};
}

type CapturedWorkflow = { name: string; description: string; inputs: Record<string, { type: string }> };
type CapturedState = {
	workflows: CapturedWorkflow[];
	task: { documents: { content: string }[] };
};
type CapturedRequest = { state: CapturedState; questions: Record<string, { criteria: Record<string, string> }> };

function captureState(content: string): CapturedState {
	const request = JSON.parse(content) as CapturedRequest;
	return {
		...request.state,
		workflows: Object.entries(request.questions.workflow!.criteria)
			.filter(([name]) => name !== "none")
			.map(([, contract]) => JSON.parse(contract) as CapturedWorkflow),
	};
}
type RoutingHarness = {
	execute: (args: WorkflowToolArgs, ctx: PiExecuteContext) => Promise<WorkflowRegisteredToolResult>;
	registryNames: () => readonly string[];
	noAdmission: () => void;
};

async function inspectRoutes(f: RoutingHarness, _target: string) {
	const ctx = workflowRouterContext("none");
	let ordinaryState: CapturedState | undefined;
	let choices: string[] = [];
	ctx.modelRegistry!.streamSimple = (_model, context) => {
		ordinaryState = captureState(context.messages[0]!.content as string);
		const schema = context.tools![0]!.parameters as { properties: { workflowType: { anyOf: { const: string }[] } } };
		choices = schema.properties.workflowType.anyOf.map((option) => option.const);
		return messageStream(decisionMessage({ estimatedDuration: "15min", workflowType: "none", maxBudget: {} }));
	};
	const args = { action: "route" as const, state: workflowRouterState() };
	const ordinary = await f.execute(args, ctx);
	assert.equal(ordinary.action, "route");
	assert.equal(ordinary.status, "not_launched", ordinary.error);
	assert.ok(ordinaryState);
	const expected = ["none", ...f.registryNames()];
	assert.deepEqual(choices, expected);
	assert.deepEqual(
		ordinaryState.workflows.map((item) => item.name),
		expected.slice(1),
	);
	assert.match(ordinaryState.task.documents[0]!.content, /Implement the change/);
	let jev: CapturedRequest | undefined;
	const seenContracts = new Map<string, CapturedWorkflow>();
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-jev-key");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const packed = JSON.parse(init.body as string) as CapturedRequest;
			// Questions may be packed across several requests; merge them so the
			// assertions see the complete set regardless of packing boundaries.
			jev = { state: packed.state, questions: { ...jev?.questions, ...packed.questions } };
			for (const question of Object.values(packed.questions)) {
				for (const [name, contract] of Object.entries(question.criteria)) {
					if (name !== "none" && expected.includes(name))
						seenContracts.set(name, JSON.parse(contract) as CapturedWorkflow);
				}
			}
			const answers = Object.fromEntries(
				Object.entries(packed.questions).map(([id, question]) => {
					const keys = Object.keys(question.criteria);
					const selected = id === "workflow" ? "none" : keys[0]!;
					return [
						id,
						{
							type: "choice",
							choice: selected,
							confidence: 1,
							probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])),
						},
					];
				}),
			);
			return new Response(
				JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 2 } }),
			);
		}),
	);
	ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	const jevResult = await f.execute(args, ctx);
	assert.equal(jevResult.action, "route");
	assert.equal(jevResult.status, "not_launched", jevResult.error);
	assert.ok(jev);
	assert.ok(Object.hasOwn(jev.questions.workflow!.criteria, "none"));
	assert.deepEqual([...seenContracts.keys()], expected.slice(1));
	assert.deepEqual([...seenContracts.values()], ordinaryState.workflows);
	f.noAdmission();
	return ordinaryState;
}

test("all six effective discovery sources and overrides have identical schema, context and Jev candidates", async () => {
	const f = await fixture();
	const builtin = f.state.runtimeProxy.registry.names()[0]!;
	assert.ok(builtin);
	const projectPath = join(f.project, ".atomic/workflows/project.ts");
	const userPath = join(f.user, "workflows/user.ts");
	const packagePath = join(f.root, "extension/package.ts");
	await definition(projectPath, "project-route", "Project contract wins");
	await definition(userPath, "user-route", "User contract");
	await definition(packagePath, "package-route", "Package contract");
	await definition(join(f.user, "workflows/overridden.ts"), "project-route", "Shadowed user contract");
	await definition(
		join(f.project, ".atomic/workflows/builtin-override.ts"),
		builtin,
		"Project replacement for builtin",
	);
	const settingsProjectPath = join(f.project, "configured/project.ts");
	const settingsGlobalPath = join(f.user, "configured/global.ts");
	const settingsGlobalShadowedPath = join(f.user, "configured/shadowed.ts");
	await definition(settingsProjectPath, "settings-project-route", "Settings project wins", "configuredProject");
	await definition(settingsGlobalPath, "settings-global-route", "Settings global wins", "configuredGlobal");
	await definition(settingsGlobalShadowedPath, "project-route", "Shadowed settings global contract", "shadowed");
	await definition(
		join(f.project, ".atomic/workflows/settings-shadowed.ts"),
		"settings-project-route",
		"Shadowed project-local contract",
		"shadowed",
	);
	await definition(
		join(f.user, "workflows/settings-shadowed.ts"),
		"settings-global-route",
		"Shadowed user-global contract",
		"shadowed",
	);
	const projectConfig = join(f.project, ".atomic/extensions/workflow/config.json");
	const globalConfig = join(f.user, "extensions/workflow/config.json");
	await mkdir(dirname(projectConfig), { recursive: true });
	await mkdir(dirname(globalConfig), { recursive: true });
	await writeFile(projectConfig, JSON.stringify({ workflows: { configured: { path: settingsProjectPath } } }));
	await writeFile(
		globalConfig,
		JSON.stringify({
			workflows: {
				configuredGlobal: { path: settingsGlobalPath },
				shadowed: { path: settingsGlobalShadowedPath },
			},
		}),
	);
	f.setResources([{ path: packagePath, enabled: true }]);
	const reload = await f.execute({ action: "reload" }, {});
	assert.equal(reload.action, "reload");
	assert.equal(reload.outcome, "applied");
	const kinds = new Set<string>(f.state.discoveryRef.current!.sources.map((source) => source.kind));
	for (const kind of ["settings-project", "project-local", "settings-global", "user-global", "package", "bundled"])
		assert.ok(kinds.has(kind), kind);
	const captured = await inspectRoutes(f, "project-route");
	assert.equal(captured.workflows.filter((item) => item.name === "project-route").length, 1);
	assert.equal(captured.workflows.find((item) => item.name === "project-route")!.description, "Project contract wins");
	assert.equal(
		captured.workflows.find((item) => item.name === builtin)!.description,
		"Project replacement for builtin",
	);
	for (const name of ["project-route", "user-route", "package-route"])
		assert.ok(captured.workflows.some((item) => item.name === name));
	for (const [name, kind, description, input] of [
		["settings-project-route", "settings-project", "Settings project wins", "configuredProject"],
		["settings-global-route", "settings-global", "Settings global wins", "configuredGlobal"],
		["project-route", "project-local", "Project contract wins", "task"],
	]) {
		assert.equal(f.state.discoveryRef.current!.sources.find((source) => source.id === name)!.kind, kind);
		const matches = captured.workflows.filter((item) => item.name === name);
		assert.equal(matches.length, 1);
		assert.equal(matches[0]!.description, description);
		assert.deepEqual(Object.keys(matches[0]!.inputs), [input]);
	}
	assert.equal(
		captured.workflows.some((item) => item.description.startsWith("Shadowed")),
		false,
	);
});

test("file authoring, removal, rename and same-name edits refresh actual choices and input contracts together", async () => {
	const f = await fixture();
	const path = join(f.project, ".atomic/workflows/authored.ts");
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	assert.equal(f.state.runtimeProxy.registry.has("authored-route"), false);
	await definition(path, "authored-route", "Initial authored contract");
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	await inspectRoutes(f, "authored-route");
	await definition(path, "authored-route", "Changed same-name contract", "replacement");
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	const changed = await inspectRoutes(f, "authored-route");
	const current = changed.workflows.find((item) => item.name === "authored-route")!;
	assert.equal(current.description, "Changed same-name contract");
	assert.deepEqual(Object.keys(current.inputs), ["replacement"]);
	await definition(path, "renamed-route", "Renamed contract");
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	const renamed = await inspectRoutes(f, "renamed-route");
	assert.equal(
		renamed.workflows.some((item) => item.name === "authored-route"),
		false,
	);
	await unlink(path);
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	const afterRemoval = await inspectRoutes(f, f.state.runtimeProxy.registry.names()[0]!);
	assert.equal(
		afterRemoval.workflows.some((item) => item.name === "renamed-route"),
		false,
	);
});

test("failed resource reload retains the previous registry generation and complete routing contracts", async () => {
	const f = await fixture();
	const path = join(f.project, ".atomic/workflows/retained.ts");
	await definition(path, "retained-route", "Retained contract");
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	const registry = f.state.runtimeProxy.registry;
	const generation = f.state.runtimeProxy.routingGeneration;
	const before = await inspectRoutes(f, "retained-route");
	await definition(path, "retained-route", "Not published");
	f.fail(true);
	const failed = await f.execute({ action: "reload" }, {});
	assert.equal(failed.action, "reload");
	assert.equal(failed.outcome, "failed");
	assert.equal(f.state.runtimeProxy.registry, registry);
	assert.equal(f.state.runtimeProxy.routingGeneration, generation);
	const after = await inspectRoutes(f, "retained-route");
	assert.deepEqual(after.workflows, before.workflows);
});

test("overlapping in-flight decisions cannot launch a removed or same-name changed definition after real reload", async () => {
	const f = await fixture();
	const changedPath = join(f.project, ".atomic/workflows/changed.ts");
	const removedPath = join(f.project, ".atomic/workflows/removed.ts");
	await definition(changedPath, "changed-route", "Old changed contract");
	await definition(removedPath, "removed-route", "Old removed contract");
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
	const entered = Promise.withResolvers<void>();
	const captured: CapturedState[] = [];
	const ctx = workflowRouterContext("none");
	ctx.modelRegistry!.streamSimple = (_model, context) => {
		captured.push(captureState(context.messages[0]!.content as string));
		if (captured.length === 2) entered.resolve();
		return streams[captured.length - 1]!;
	};
	const pending = ["changed-route", "removed-route"].map(() =>
		f.execute({ action: "route", state: workflowRouterState() }, ctx),
	);
	await entered.promise;
	f.noAdmission();
	await definition(changedPath, "changed-route", "New changed contract", "newInput");
	await unlink(removedPath);
	assert.equal((await f.state.reloadWorkflowResources()).outcome, "applied");
	streams.forEach((stream, index) => {
		stream.push({
			type: "done",
			reason: "toolUse",
			message: decisionMessage({
				estimatedDuration: "15min",
				workflowType: index === 0 ? "changed-route" : "removed-route",
				maxBudget: {},
			}),
		});
	});
	for (const result of await Promise.all(pending)) {
		assert.equal(result.action, "route");
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /registry changed/);
		assert.equal(result.routerDecision, undefined);
	}
	assert.equal(captured.length, 2, "no automatic second inference");
	assert.deepEqual(
		captured[0]!.workflows,
		captured[1]!.workflows,
		"both requests use their own coherent old generation",
	);
	assert.equal(
		captured[0]!.workflows.find((item) => item.name === "changed-route")!.description,
		"Old changed contract",
	);
	const current = await inspectRoutes(f, "changed-route");
	assert.equal(current.workflows.find((item) => item.name === "changed-route")!.description, "New changed contract");
	assert.equal(
		current.workflows.some((item) => item.name === "removed-route"),
		false,
	);
	f.noAdmission();
});

for (const mutation of ["add", "remove", "rename", "same-name replacement"] as const) {
	test(`user /workflow reload publishes ${mutation} and rejects in-flight approvals at the registered tool`, async () => {
		const f = await fixture();
		const path = join(f.project, ".atomic/workflows/slash-changing.ts");
		await definition(join(f.project, ".atomic/workflows/slash-stable.ts"), "slash-stable", "Stable contract");
		if (mutation !== "add") await definition(path, "slash-changing", "Old slash contract");
		const commands = new Map<string, PiCommandOptions>();
		let registeredTool: PiToolOpts<WorkflowToolArgs, WorkflowRegisteredToolResult> | undefined;
		factory({
			disableAsyncDiscovery: true,
			registerCommand: (name, options) => {
				commands.set(name, options);
			},
			registerTool: (options) => {
				registeredTool = options as unknown as PiToolOpts<WorkflowToolArgs, WorkflowRegisteredToolResult>;
			},
			on: () => {},
			ui: { setWidget: () => {} },
		});
		assert.ok(registeredTool);
		const tool = registeredTool;
		const command = commands.get("workflow");
		assert.ok(command);
		const reload = () => command.handler("reload", { hasUI: false, ui: { notify: () => {} } });
		const listNames = async () => {
			const result = await tool.execute("list", { action: "list" }, undefined, undefined, {});
			assert.equal(result.details.action, "list");
			assert.ok("items" in result.details);
			return result.details.items.map((item) => item.name);
		};
		await reload();
		let currentNames = await listNames();
		const routing: RoutingHarness = {
			execute: async (args, ctx) => (await tool.execute("inspect-route", args, undefined, undefined, ctx)).details,
			registryNames: () => currentNames,
			noAdmission: f.noAdmission,
		};
		const before = await inspectRoutes(routing, "slash-stable");
		assert.equal(currentNames.includes("slash-changing"), mutation !== "add");
		// Hold overlapping approvals for the changed target and an unchanged definition.
		// Both must be invalidated by the slash command's registry publication.
		const targets = mutation === "add" ? ["slash-stable"] : ["slash-changing", "slash-stable"];
		const streams = targets.map(() => createAssistantMessageEventStream());
		const entered = Promise.withResolvers<void>();
		const snapshots: CapturedState[] = [];
		const ctx = workflowRouterContext("none");
		ctx.modelRegistry!.streamSimple = (_model, context) => {
			snapshots.push(captureState(context.messages[0]!.content as string));
			if (snapshots.length === targets.length) entered.resolve();
			return streams[snapshots.length - 1]!;
		};
		const pending = targets.map(() =>
			tool.execute("stale-route", { action: "route", state: workflowRouterState() }, undefined, undefined, ctx),
		);
		await entered.promise;
		f.noAdmission();
		if (mutation === "remove") await unlink(path);
		else
			await definition(
				path,
				mutation === "rename" ? "slash-renamed" : "slash-changing",
				"New slash contract",
				"replacement",
			);
		await reload();
		currentNames = await listNames();
		const after = await inspectRoutes(routing, "slash-stable");
		const selected = mutation === "rename" ? "slash-renamed" : "slash-changing";
		if (mutation === "remove") assert.equal(currentNames.includes(selected), false);
		else {
			const current = after.workflows.find((item) => item.name === selected)!;
			assert.equal(current.description, "New slash contract");
			assert.deepEqual(Object.keys(current.inputs), ["replacement"]);
		}
		if (mutation === "rename") assert.equal(currentNames.includes("slash-changing"), false);
		for (const snapshot of snapshots) assert.deepEqual(snapshot.workflows, before.workflows);
		streams.forEach((stream, index) => {
			stream.push({
				type: "done",
				reason: "toolUse",
				message: decisionMessage({ estimatedDuration: "15min", workflowType: targets[index]!, maxBudget: {} }),
			});
		});
		for (const result of await Promise.all(pending)) {
			assert.equal(result.details.action, "route");
			assert.equal(result.details.status, "failed");
			assert.match("error" in result.details ? (result.details.error ?? "") : "", /registry changed/);
			assert.equal("routerDecision" in result.details, false);
			const visible = JSON.parse(result.content[0]!.text as string);
			assert.equal(visible.workflowId, "");
			assert.equal(visible.status, "failed");
			assert.equal("routerDecision" in visible, false);
			assert.match(visible.error, /retry explicitly with fresh state/);
		}
		assert.equal(snapshots.length, targets.length, "no automatic rerouting");
		f.noAdmission();
	});
}
