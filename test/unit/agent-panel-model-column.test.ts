import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelExtensionItems,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type AgentPanelRow,
	type AgentPanelStyle,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelRows, bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

const TASK = "Read docs/model-partner-template.md and do what it says for each package";

const debugger_: AgentPanelRow = {
	id: "task:debugger",
	kind: "agent",
	state: "running",
	name: "debugger",
	task: TASK,
	elapsedMs: 16 * 60_000,
	tokens: 437_300,
	model: "github-copilot/claude-opus-5.5",
	thinking: "medium",
};
const worker: AgentPanelRow = {
	id: "task:worker",
	kind: "agent",
	state: "running",
	name: "worker",
	task: "fix shipping batches",
	elapsedMs: 41 * 60_000,
	tokens: 96_100,
	model: "faux/faux-2",
	thinking: "low",
};
/** A row from an extension source that names no model. */
const deployer: AgentPanelRow = {
	id: "ext:deploy",
	kind: "agent",
	state: "running",
	name: "deployer",
	task: "build",
	elapsedMs: 3 * 60_000,
};

function withoutModel(row: AgentPanelRow): AgentPanelRow {
	const { model: _model, thinking: _thinking, ...rest } = row;
	return rest;
}

function lines(rows: readonly AgentPanelRow[], width: number, showMain = false): string[] {
	return renderAgentPanelRows(rows, width, plain, { showMain }).map((line) => stripVTControlCharacters(line));
}

/** Text cut to `width` cells as every list cuts it. */
function cut(text: string, width: number): string {
	return stripVTControlCharacters(truncateToWidth(text, width));
}

/** A row as the panel lays it out: the left part, then the right column flush with the row's end. */
function row(left: string, right: string, width: number): string {
	return `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;
}

beforeAll(() => {
	initTheme("dark");
});

test("a subagent row shows the model it runs on and its reasoning level after its name, in a column aligned across rows", () => {
	assert.deepEqual(lines([debugger_, worker, deployer], 160), [
		row(`  ◯ debugger  github-copilot/claude-opus-5.5 medium  ${TASK}`, "16m · ↓ 437.3k tokens", 160),
		row("  ◯ worker    faux/faux-2 low                        fix shipping batches", "41m · ↓ 96.1k tokens", 160),
		row("  ◯ deployer                                         build", "3m", 160),
	]);
});

test("a row whose model has no reasoning level shows the model alone, and a level of off is shown as given", () => {
	assert.deepEqual(
		lines(
			[
				{ ...worker, model: "faux/plain", thinking: undefined },
				{ ...deployer, model: "faux/faux-2", thinking: "off" },
			],
			120,
		),
		[
			row("  ◯ worker    faux/plain       fix shipping batches", "41m · ↓ 96.1k tokens", 120),
			row("  ◯ deployer  faux/faux-2 off  build", "3m", 120),
		],
	);
});

test("as the row narrows the task truncates first, then below 100 columns the model column is dropped and the row reads as without it", () => {
	const rows = [debugger_, worker, deployer];
	for (let width = 160; width >= 100; width--) {
		const [first] = lines(rows, width);
		const room = width - 53 - "16m · ↓ 437.3k tokens".length - 2;
		assert.equal(
			first,
			row(`  ◯ debugger  github-copilot/claude-opus-5.5 medium  ${cut(TASK, room)}`, "16m · ↓ 437.3k tokens", width),
			`width ${width}`,
		);
	}
	for (let width = 99; width >= 1; width--) {
		assert.deepEqual(lines(rows, width), lines(rows.map(withoutModel), width), `width ${width}`);
	}
});

test("the model column never changes the rest of a row: the main row, glyph, name and right column read as without it at every width", () => {
	const rows = [debugger_, worker, deployer];
	const rights = ["16m · ↓ 437.3k tokens", "41m · ↓ 96.1k tokens", "3m"];
	for (let width = 1; width <= 220; width++) {
		const shown = lines(rows, width, true);
		const before = lines(rows.map(withoutModel), width, true);
		if (width < 100) {
			assert.deepEqual(shown, before, `width ${width}`);
			continue;
		}
		assert.equal(shown.length, before.length);
		assert.equal(shown[0], before[0], `width ${width}: the main row is unchanged`);
		for (let index = 1; index < shown.length; index++) {
			const line = shown[index]!;
			assert.equal(visibleWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
			assert.equal(line.slice(0, 14), before[index]!.slice(0, 14), `width ${width}: ${line}`);
			assert.ok(before[index]!.endsWith(rights[index - 1]!));
			assert.ok(line.endsWith(rights[index - 1]!), `width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("a panel whose rows name no model, and shell rows, render exactly as before", () => {
	const shell: AgentPanelRow = {
		id: "ext:shell",
		kind: "shell",
		state: "running",
		name: "shell",
		task: "sleep 300",
		model: "faux/faux-2",
		thinking: "low",
	};
	for (const width of [30, 60, 99, 100, 120, 160]) {
		assert.deepEqual(
			lines([withoutModel(worker), deployer, shell], width, true),
			lines([withoutModel(worker), deployer, withoutModel(shell)], width, true),
			`width ${width}`,
		);
	}
});

test("the model column is dropped when it would leave a row without its task or clip its right column", () => {
	// Its right column would no longer fit whole beside the model column.
	const waiting: AgentPanelRow = {
		...worker,
		state: "waiting",
		waitingOn: "wait_for_ci, wait_for_review, wait_for_deploy, wait_for_release",
		elapsedMs: 6 * 60_000,
	};
	assert.deepEqual(lines([debugger_, waiting], 120), lines([debugger_, waiting].map(withoutModel), 120));
	// Its right column fits, but its task would have fewer than 8 cells left.
	const shortTask: AgentPanelRow = { ...waiting, waitingOn: "wait_for_ci, wait_for_review, bash" };
	assert.equal(lines([shortTask], 110)[0]!.trimStart().length > 0, true);
	assert.deepEqual(lines([debugger_, shortTask], 110), lines([debugger_, shortTask].map(withoutModel), 110));
	assert.match(lines([debugger_, shortTask], 160)[1]!, /^ {2}◌ worker {4}faux\/faux-2 low {24}fix shipping batches/);
	// Messages queued to it widen its right column; with room, the model column stays.
	const queued: AgentPanelRow = { ...worker, queued: 3 };
	assert.match(
		lines([debugger_, queued], 100)[1]!,
		/^ {2}◯ worker {4}faux\/faux-2 low {24}fix shippin\.\.\. {2}41m · ↓ 96\.1k tokens · 3 queued$/,
	);
});

test("a long model label keeps its reasoning level and is cut in its id", () => {
	const long: AgentPanelRow = {
		...worker,
		model: "openrouter/anthropic/claude-3.7-sonnet-20250219-extended",
		thinking: "xhigh",
	};
	const [line] = lines([long], 160);
	assert.equal(
		line,
		row(
			`  ◯ worker  ${cut("openrouter/anthropic/claude-3.7-sonnet-20250219-extended", 34)} xhigh  fix shipping batches`,
			"41m · ↓ 96.1k tokens",
			160,
		),
	);
});

const fixtures: Array<ReturnType<typeof taskFixture>> = [];
afterEach(async () => {
	while (fixtures.length > 0) await fixtures.pop()!.dispose();
});

test("/tasks agent rows show the same model column, aligned, and drop it below 100 columns", async () => {
	const fixture = taskFixture();
	fixtures.push(fixture);
	await fixture.start(TASK);
	await fixture.start("fix shipping batches");
	fixture.runners[0]!.context.reportActivity({
		reportId: "model-0",
		change: { kind: "model", model: "github-copilot/claude-opus-5.5", thinking: "medium" },
	});
	fixture.runners[1]!.context.reportActivity({
		reportId: "model-1",
		change: { kind: "model", model: "faux/faux-2", thinking: "low" },
	});
	fixture.store.drain();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		const board = (width: number) =>
			inspector
				.renderViewport(width, 24)
				.map((line) => stripVTControlCharacters(line))
				.filter((line) => /worker/.test(line));
		const wide = board(160);
		assert.equal(wide.length, 2);
		const at = (line: string) =>
			line.indexOf("faux/faux-2 low") >= 0
				? line.indexOf("faux/faux-2 low")
				: line.indexOf("github-copilot/claude-opus-5.5 medium");
		assert.ok(
			wide.every((line) => at(line) > 0),
			wide.join("\n"),
		);
		assert.equal(at(wide[0]!), at(wide[1]!), "the model column is aligned");
		const tasks = wide.map((line) => line.search(/Read docs|fix shipping/));
		assert.equal(tasks[0], tasks[1], "the task column is aligned after it");
		assert.equal(tasks[0], at(wide[0]!) + "github-copilot/claude-opus-5.5 medium".length + 2);
		const narrow = board(99);
		assert.ok(
			narrow.every((line) => !/faux\/faux-2|github-copilot/.test(line)),
			narrow.join("\n"),
		);
	} finally {
		inspector.dispose();
	}
});

test("a change of model alone repaints the panel's row at once, before its clock ticks", async () => {
	// The row's clock stands still: only its model changes between the two paints.
	vi.useFakeTimers({ toFake: ["Date"] });
	const fixture = taskFixture();
	fixtures.push(fixture);
	const session = {};
	let widget: Component | undefined;
	let renders = 0;
	const unbind = bindAgentPanel(
		session as never,
		{
			setWidget(_key, content) {
				widget = typeof content === "function" ? content({} as TUI, theme) : undefined;
			},
			requestRender() {
				renders++;
			},
		} as Pick<ExtensionUIContext, "setWidget" | "requestRender"> as ExtensionUIContext,
	);
	const row = () => stripVTControlCharacters(widget?.render(160).find((line) => /worker/.test(line)) ?? "");
	try {
		bindOwnerTaskStore(session, fixture.store);
		await fixture.start(TASK);
		fixture.runners[0]!.context.reportActivity({
			reportId: "model-primary",
			change: { kind: "model", model: "faux/primary", thinking: "high" },
		});
		fixture.store.drain();
		await vi.waitFor(() => assert.match(row(), /worker {2}faux\/primary high {2}Read/));
		const painted = renders;
		fixture.runners[0]!.context.reportActivity({
			reportId: "model-backup",
			change: { kind: "model", model: "faux/backup", thinking: "low" },
		});
		fixture.store.drain();
		await vi.waitFor(() => assert.ok(renders > painted, "the model change asks for a repaint"));
		// The panel keeps its model column as wide as it was while it stays open, so the task does not move.
		assert.match(row(), /worker {2}faux\/backup low {4}Read/);
	} finally {
		unbind();
		vi.useRealTimers();
	}
});

test("a subagent on a model without reasoning levels shows no level, as the footer shows none; one that reasons at off shows off", async () => {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	const model = {
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	modelRuntime.registerProvider("local", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "local-key",
		api: "openai-completions",
		models: [
			{ ...model, id: "plain", name: "plain", reasoning: false },
			{ ...model, id: "thinker", name: "thinker", reasoning: true },
		],
	});
	const fixture = taskFixture();
	fixtures.push(fixture);
	// The session that owns the tasks: its model registry says which models have reasoning levels.
	const session = { modelRuntime };
	bindOwnerTaskStore(session, fixture.store);
	await fixture.start("plain work");
	await fixture.start("thinking work");
	await fixture.start("unknown work");
	const report = (index: number, model: string) =>
		fixture.runners[index]!.context.reportActivity({
			reportId: `model-${index}`,
			change: { kind: "model", model, thinking: "off" },
		});
	report(0, "local/plain");
	report(1, "local/thinker");
	report(2, "elsewhere/unlisted");
	fixture.store.drain();
	const shown = lines(agentPanelRows(session), 140);
	assert.match(shown.find((line) => /plain work/.test(line))!, /worker {2}local\/plain {13}plain work/);
	assert.match(shown.find((line) => /thinking work/.test(line))!, /worker {2}local\/thinker off {7}thinking work/);
	// A model the registry does not know shows the level it reports.
	assert.match(shown.find((line) => /unknown work/.test(line))!, /worker {2}elsewhere\/unlisted off {2}unknown work/);
	// /tasks reads the same registry: the same rows, the same levels.
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		const board = inspector.renderViewport(140, 14).map((line) => stripVTControlCharacters(line));
		const row = (task: string) => board.find((line) => line.includes(task)) ?? board.join("\n");
		assert.match(row("plain work"), /worker {8}local\/plain {13}plain work/);
		assert.match(row("thinking work"), /worker {8}local\/thinker off {7}thinking work/);
		assert.match(row("unknown work"), /worker {8}elsewhere\/unlisted off {2}unknown work/);
	} finally {
		inspector.dispose();
	}
});

test("an extension row whose own model or thinking fields are not text keeps its row, with no model column and no error", () => {
	const hub = new AgentPanelSourceHub();
	const row = (id: string, extra: Record<string, unknown>) =>
		({ id, kind: "agent", state: "running", name: id, task: "deploy", ...extra }) as unknown as AgentPanelItem;
	hub.register({
		items: () => [
			row("plain", {}),
			row("thinking-flag", { thinking: true }),
			row("model-object", { model: { provider: "anthropic", id: "claude-sonnet-4-5" } }),
			row("model-null", { model: null }),
			row("named", { model: "local/runner", thinking: "low" }),
		],
		subscribe: () => () => {},
	});
	const errors: string[] = [];
	try {
		const items = agentPanelExtensionItems({ extensionRunner: { getAgentPanelSourceHub: () => hub } }, (error) =>
			errors.push(error.message),
		);
		assert.deepEqual(errors, []);
		assert.deepEqual(
			items.map((item) => [item.id, item.model, item.thinking]),
			[
				["plain", undefined, undefined],
				["thinking-flag", undefined, undefined],
				["model-object", undefined, undefined],
				["model-null", undefined, undefined],
				["named", "local/runner", "low"],
			],
		);
		const shown = lines(items.slice(1), 120);
		assert.match(shown[0]!, /^ {2}◯ thinking-flag {20}deploy/);
		assert.match(shown[3]!, /^ {2}◯ named {10}local\/runner low {2}deploy/);
	} finally {
		hub.dispose();
	}
});

test("an extension row whose own model or thinking throws when read, or whose strict proxy throws on keys it does not define, stays listed", () => {
	const base = () => ({ kind: "agent", state: "running", name: "reviewer", task: "review" });
	class LazyItem {
		id = "lazy-getter";
		kind = "agent";
		state = "running";
		name = "lazy";
		task = "review";
		get model(): string {
			throw new Error("model not loaded yet");
		}
		get thinking(): string {
			throw new Error("thinking not loaded yet");
		}
	}
	// Every field the panel read before the model column is defined, some as undefined; any other key throws.
	const knownKeys = [
		"id",
		"kind",
		"state",
		"name",
		"task",
		"elapsedMs",
		"elapsedSpan",
		"tokens",
		"progress",
		"question",
		"choices",
		"promptId",
		"reason",
		"waitingOn",
		"queued",
		"runGeneration",
		"then",
		"endedAt",
	];
	const strictTarget: Record<string, unknown> = Object.fromEntries(knownKeys.map((key) => [key, undefined]));
	Object.assign(strictTarget, { ...base(), id: "strict-proxy" });
	const strict = new Proxy(strictTarget, {
		get(target, key) {
			if (typeof key === "string" && !(key in target)) throw new Error(`unknown key ${key}`);
			return target[key as string];
		},
	});
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () =>
			[
				{ ...base(), id: "plain" },
				new LazyItem(),
				strict,
				{ ...base(), id: "named", model: "local/runner" },
			] as never,
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const errors: string[] = [];
	try {
		const items = agentPanelExtensionItems(session, (error) => errors.push(error.message));
		assert.deepEqual(errors, []);
		assert.deepEqual(
			items.map((item) => [item.id, item.model, item.thinking]),
			[
				["plain", undefined, undefined],
				["lazy-getter", undefined, undefined],
				["strict-proxy", undefined, undefined],
				["named", "local/runner", undefined],
			],
		);
		assert.deepEqual(
			agentPanelRows(session).map((row) => row.id),
			["named", "strict-proxy", "lazy-getter", "plain"],
		);
	} finally {
		hub.dispose();
	}
});
