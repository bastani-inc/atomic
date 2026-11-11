import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.js";
import type { SessionManager } from "../src/core/session-manager.js";
import { TOOL_DEACTIVATION_ENTRY_TYPE } from "../src/core/tool-deactivation.js";
import {
	reportUnavailableTools,
	showUnavailableToolsNotice,
} from "../src/modes/interactive/interactive-unavailable-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

function extensionTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

const ORCHESTRATION_TOOLS = ["subagent", "workflow"] as const;

async function resume(
	sessionManager: SessionManager | undefined,
	options: { tools?: readonly string[]; excludedToolNames?: string[]; allowedToolNames?: string[] } = {},
): Promise<Harness> {
	const harness = await createHarness({
		sessionManager,
		customTools: (options.tools ?? ORCHESTRATION_TOOLS).map(extensionTool),
		excludedToolNames: options.excludedToolNames,
		allowedToolNames: options.allowedToolNames,
		initialActiveToolNames: options.allowedToolNames,
	});
	harnesses.push(harness);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

async function runTurn(harness: Harness): Promise<void> {
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("continue");
}

function deactivationEntries(sessionManager: SessionManager): string[][] {
	return sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === TOOL_DEACTIVATION_ENTRY_TYPE
				? [[...(entry.data as { tools: string[] }).tools].sort()]
				: [],
		);
}

test("a turn that ran while extension and built-in tools were unregistered does not lose them on the next resume (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	assert.ok(before.session.getActiveToolNames().includes("todo"));

	// The extensions that register subagent and workflow did not load, and todo was unavailable, when this turn ran.
	const degraded = await resume(before.sessionManager, { tools: [] });
	degraded.session.agent.state.tools = degraded.session.agent.state.tools.filter((tool) => tool.name !== "todo");
	await runTurn(degraded);
	const removal = degraded.session.messages.findLast((message) => message.role === "system");
	assert.deepEqual(removal?.role === "system" ? removal.toolsRemoved?.map((tool) => tool.name).sort() : [], [
		"subagent",
		"todo",
		"workflow",
	]);

	const after = await resume(degraded.sessionManager);
	const active = after.session.getActiveToolNames();
	for (const name of [...ORCHESTRATION_TOOLS, "todo"]) assert.ok(active.includes(name), `${name} is active`);
	assert.deepEqual(deactivationEntries(after.sessionManager), []);
});

test("tools deactivated on purpose stay inactive after resume (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	before.session.setActiveToolsByName(
		before.session.getActiveToolNames().filter((name) => name !== "workflow" && name !== "todo"),
	);
	await runTurn(before);
	assert.deepEqual(deactivationEntries(before.sessionManager), [["todo", "workflow"]]);

	const after = await resume(before.sessionManager);
	const active = after.session.getActiveToolNames();
	assert.ok(active.includes("subagent"));
	assert.ok(!active.includes("workflow"));
	assert.ok(!active.includes("todo"));
});

test("a deactivation is not recorded when the tool is active again before the next turn (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	const active = before.session.getActiveToolNames();
	before.session.setActiveToolsByName(active.filter((name) => name !== "workflow"));
	before.session.setActiveToolsByName(active);
	await runTurn(before);
	assert.deepEqual(deactivationEntries(before.sessionManager), []);
});

test("a tool re-added after an explicit deactivation heals when a later removal was not explicit (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	const active = before.session.getActiveToolNames();
	before.session.setActiveToolsByName(active.filter((name) => name !== "workflow"));
	await runTurn(before);
	before.session.setActiveToolsByName(active);
	await runTurn(before);

	const degraded = await resume(before.sessionManager, { tools: ["subagent"] });
	assert.ok(!degraded.session.getActiveToolNames().includes("workflow"));
	await runTurn(degraded);

	const after = await resume(degraded.sessionManager);
	assert.ok(after.session.getActiveToolNames().includes("workflow"));
});

test("a removed built-in tool outside the default selection is not re-activated on resume (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	before.session.setActiveToolsByName([...before.session.getActiveToolNames(), "ls"]);
	await runTurn(before);
	const degraded = await resume(before.sessionManager, { excludedToolNames: ["ls"] });
	await runTurn(degraded);

	const after = await resume(degraded.sessionManager);
	assert.ok(!after.session.getActiveToolNames().includes("ls"));
});

test("startup names tools the history records as active when nothing registered them (#4660)", async () => {
	const before = await resume(undefined, { tools: [...ORCHESTRATION_TOOLS, "mcp__docs__search"] });
	await runTurn(before);

	const after = await resume(before.sessionManager, { tools: [] });
	const missing = after.session.getToolStatus().missing;
	assert.deepEqual(
		missing.map((tool) => tool.name),
		["subagent", "workflow"],
	);
	assert.match(missing[0]?.reason ?? "", /active in this session's history/);

	const warnings: string[] = [];
	await showUnavailableToolsNotice({
		session: after.session,
		startupNoticesContainer: undefined as never,
		showWarning: (message) => warnings.push(message),
	});
	assert.deepEqual(warnings, [
		"Tools this session was using aren't available right now: subagent, workflow. /tools shows why; /reload retries once that is fixed.",
	]);

	const healthy = await resume(before.sessionManager, { tools: [...ORCHESTRATION_TOOLS, "mcp__docs__search"] });
	const quiet: string[] = [];
	await showUnavailableToolsNotice({
		session: healthy.session,
		startupNoticesContainer: undefined as never,
		showWarning: (message) => quiet.push(message),
	});
	assert.deepEqual(quiet, []);
});

test("a malformed or foreign deactivation entry does not keep a tool off (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	const degraded = await resume(before.sessionManager, { tools: ["subagent"] });
	await runTurn(degraded);
	await degraded.sessionManager.appendCustomEntry(TOOL_DEACTIVATION_ENTRY_TYPE, { tools: "workflow" });
	await degraded.sessionManager.appendCustomEntry("another.extension", { tools: ["workflow"] });

	const after = await resume(degraded.sessionManager);
	assert.ok(after.session.getActiveToolNames().includes("workflow"));
});

test("a resume with --tools or --no-tools names nothing as unavailable and shows no notice (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	for (const allowedToolNames of [["read", "bash"], []]) {
		const restricted = await resume(before.sessionManager, { tools: [], allowedToolNames });
		assert.deepEqual(restricted.session.getToolStatus().missing, []);
		const warnings: string[] = [];
		await reportUnavailableTools({
			session: restricted.session,
			startupNoticesContainer: undefined as never,
			showWarning: (message) => warnings.push(message),
		});
		assert.deepEqual(warnings, []);
	}
});

test("a --tools modifier that removes a tool does not report it unavailable (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	const after = await resume(before.sessionManager, { tools: [] });
	assert.ok(after.session.getToolStatus().missing.some((tool) => tool.name === "subagent"));

	(after.session as unknown as { _defaultToolModifiers: string[] })._defaultToolModifiers = ["-subagent"];
	const missing = after.session.getToolStatus().missing.map((tool) => tool.name);
	assert.deepEqual(missing, ["workflow"]);
});

test("a tool status that cannot be read leaves the notice out without failing (#4660)", async () => {
	const warnings: string[] = [];
	await assert.doesNotReject(
		reportUnavailableTools({
			session: {
				getToolStatus: () => {
					throw new Error("status exploded");
				},
			},
			startupNoticesContainer: undefined as never,
			showWarning: (message) => warnings.push(message),
		}),
	);
	assert.deepEqual(warnings, []);
});

test("a turn still completes and the tools still come back when recording a deactivation fails (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	before.session.setActiveToolsByName(before.session.getActiveToolNames().filter((name) => name !== "workflow"));
	const append = before.sessionManager.appendCustomEntry.bind(before.sessionManager);
	before.sessionManager.appendCustomEntry = async (customType, data) => {
		if (customType === TOOL_DEACTIVATION_ENTRY_TYPE) throw new Error("disk full");
		return append(customType, data);
	};
	await assert.doesNotReject(runTurn(before));
	before.sessionManager.appendCustomEntry = append;

	assert.deepEqual(deactivationEntries(before.sessionManager), []);
	const after = await resume(before.sessionManager);
	assert.ok(after.session.getActiveToolNames().includes("workflow"));
	assert.ok(after.session.getActiveToolNames().includes("subagent"));
});

test("a tool turned off and on again in one session is not recorded as deactivated when it later goes missing (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	const active = before.session.getActiveToolNames();
	before.session.setActiveToolsByName(active.filter((name) => name !== "workflow"));
	before.session.setActiveToolsByName(active);
	before.session.agent.state.tools = before.session.agent.state.tools.filter((tool) => tool.name !== "workflow");
	await runTurn(before);

	assert.deepEqual(deactivationEntries(before.sessionManager), []);
	const after = await resume(before.sessionManager);
	assert.ok(after.session.getActiveToolNames().includes("workflow"));
});

test("a resume with --no-extensions does not report the tools the extensions would have registered (#4660)", async () => {
	const before = await resume(undefined);
	await runTurn(before);
	const withoutExtensions = await createHarness({
		sessionManager: before.sessionManager,
		resourceLoader: { ...createTestResourceLoader(), getInheritanceSnapshot: () => ({ noExtensions: true }) },
	});
	harnesses.push(withoutExtensions);
	withoutExtensions.session.agent.state.messages = withoutExtensions.sessionManager.buildSessionContext().messages;

	assert.deepEqual(withoutExtensions.session.getToolStatus().missing, []);
	assert.ok(withoutExtensions.session.getActiveToolNames().includes("todo"));

	const withExtensionsLost = await resume(before.sessionManager, { tools: [] });
	assert.deepEqual(
		withExtensionsLost.session.getToolStatus().missing.map((tool) => tool.name),
		["subagent", "workflow"],
	);
});

for (const restriction of [
	{
		name: "--tools",
		options: { allowedToolNames: ["read", "bash"] },
		off: ["todo", "subagent", "workflow"],
		on: ["read", "bash"],
	},
	{
		name: "--no-tools",
		options: { allowedToolNames: [] as string[] },
		off: ["read", "todo", "subagent", "workflow"],
		on: [],
	},
	{
		name: "--exclude-tools",
		options: { excludedToolNames: ["workflow"] },
		off: ["workflow"],
		on: ["read", "todo", "subagent"],
	},
]) {
	test(`${restriction.name} on one run carries into a later plain resume, as in upstream pi (#4660)`, async () => {
		const first = await resume(undefined);
		await runTurn(first);
		const restricted = await resume(first.sessionManager, restriction.options);
		await runTurn(restricted);

		const later = await resume(restricted.sessionManager);

		const active = later.session.getActiveToolNames();
		for (const name of restriction.off) assert.ok(!active.includes(name), `${name} stays off`);
		for (const name of restriction.on) assert.ok(active.includes(name), `${name} is on`);
	});
}

test("a tool a --tools restriction left out comes back with --tools +name (#4660)", async () => {
	const first = await resume(undefined);
	await runTurn(first);
	const restricted = await resume(first.sessionManager, { allowedToolNames: ["read", "bash"] });
	await runTurn(restricted);
	const later = await resume(restricted.sessionManager);
	later.session.setActiveToolsByName([...later.session.getActiveToolNames(), "subagent"]);
	await runTurn(later);

	const again = await resume(later.sessionManager);
	assert.ok(again.session.getActiveToolNames().includes("subagent"));
	assert.ok(!again.session.getActiveToolNames().includes("workflow"));
});
