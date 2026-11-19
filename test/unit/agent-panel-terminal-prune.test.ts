import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { panelCounts } from "../../packages/coding-agent/src/core/tasks/agent-panel-rules.ts";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { taskClocksFor } from "../../packages/coding-agent/src/core/tasks/live-elapsed.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.ts";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.ts";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.ts";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.ts";
import {
	mainComposerFooterHints,
	mainComposerHintSegments,
} from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { engineAgentPanelCounts } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	type AgentPanelCounts,
	agentPanelCounts,
	agentPanelRows,
	bindAgentPanel,
	showAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { taskFixture, taskValue } from "../helpers/task-projection.ts";
import { taskRecord } from "../helpers/task-record.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
let keybindings: KeybindingsManager;
beforeEach(() => {
	initTheme("dark", false);
	previousKeys = getKeybindings();
	keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.unstubAllEnvs();
});

function panelSession(initial: AgentPanelItem[] = []) {
	const items: AgentPanelItem[] = [...initial];
	let notify = () => {};
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	return {
		session,
		set(next: AgentPanelItem[]) {
			items.length = 0;
			items.push(...next);
			notify();
		},
		ids: () => agentPanelRows(session).map((row) => row.id),
		hint: () => mainComposerHintSegments(keybindings, session),
	};
}

const agent = (id: string, state: AgentPanelItem["state"]): AgentPanelItem => ({
	id: `ext:${id}`,
	kind: "agent",
	state,
	name: "worker",
	task: `task ${id}`,
});

/** The rows the in-process model keeps for the same items. */
function modelRows(items: readonly AgentPanelItem[]): AgentPanelItem[] {
	const keep = (row: AgentPanelItem) => row.kind === "workflow" && row.viewed !== true;
	return new AgentPanelModel(() => 1_000).rows(items, keep);
}
const modelIds = (items: readonly AgentPanelItem[]) => modelRows(items).map((row) => row.id);

describe("the panel below the composer prunes subagents once they are terminal", () => {
	test("a subagent leaves the panel and the agent count as soon as it finishes", () => {
		const panel = panelSession([agent("a", "running"), agent("b", "running")]);
		assert.deepEqual(panel.hint(), ["↓ 2 agents", "? keys"]);

		panel.set([agent("a", "done"), agent("b", "running")]);
		assert.deepEqual(panel.ids(), ["ext:b"]);
		assert.equal(agentPanelCounts(panel.session).total, 1);
		assert.deepEqual(panel.hint(), ["↓ 1 agent", "? keys"]);

		panel.set([agent("a", "done"), agent("b", "failed")]);
		assert.deepEqual(panel.ids(), []);
		assert.equal(agentPanelCounts(panel.session).total, 0);
		assert.deepEqual(panel.hint(), ["? keys"]);
	});

	test("stopped and paused subagents stay while another row is active, then the whole panel goes", () => {
		const panel = panelSession([agent("stopped", "stopped"), agent("paused", "paused"), agent("live", "running")]);
		assert.deepEqual(new Set(panel.ids()), new Set(["ext:stopped", "ext:paused", "ext:live"]));
		assert.deepEqual(panel.hint(), ["↓ 3 agents", "? keys"]);

		panel.set([agent("stopped", "stopped"), agent("paused", "paused"), agent("live", "done")]);
		assert.deepEqual(panel.ids(), []);
		assert.deepEqual(agentPanelCounts(panel.session), {
			total: 0,
			agents: 0,
			needsInput: 0,
			shells: 0,
			searches: 0,
			subagents: 0,
		});
		assert.deepEqual(panel.hint(), ["? keys"]);
	});

	test("a waiting, queued, stopping or needs-input subagent counts as active and keeps a stopped one listed", () => {
		for (const state of ["waiting", "queued", "stopping", "input"] as const) {
			const panel = panelSession([agent("stopped", "stopped"), agent("live", state)]);
			assert.deepEqual(new Set(panel.ids()), new Set(["ext:stopped", "ext:live"]), state);
		}
	});

	test("a running background shell keeps a stopped subagent listed until the shell ends", () => {
		const shell: AgentPanelItem = { id: "ext:sh", kind: "shell", state: "running", name: "shell", task: "sleep 300" };
		const panel = panelSession([agent("stopped", "stopped"), shell]);
		assert.deepEqual(panel.ids(), ["ext:stopped"]);
		assert.deepEqual(panel.hint(), ["↓ 1 agent", "1 shell", "? keys"]);

		panel.set([agent("stopped", "stopped"), { ...shell, state: "done" }]);
		assert.deepEqual(panel.ids(), []);
		assert.deepEqual(panel.hint(), ["? keys"]);
	});

	test("an unviewed finished workflow run stays when nothing is active and leaves once viewed", () => {
		const run: AgentPanelItem = { id: "run:w", kind: "workflow", state: "done", name: "ralph", task: "ship" };
		const panel = panelSession([run, agent("stopped", "stopped")]);
		assert.deepEqual(panel.ids(), ["run:w"]);
		assert.equal(agentPanelCounts(panel.session).total, 1);

		panel.set([{ ...run, viewed: true }, agent("stopped", "stopped")]);
		assert.deepEqual(panel.ids(), []);
	});

	test("the count includes stopped rows folded below the visible rows while something is active", () => {
		const items = [agent("live", "running"), ...Array.from({ length: 6 }, (_, i) => agent(`s${i}`, "stopped"))];
		const panel = panelSession(items);
		assert.equal(agentPanelCounts(panel.session).total, 7);
		assert.deepEqual(panel.hint(), ["↓ 7 agents", "? keys"]);

		panel.set(items.map((item) => (item.id === "ext:live" ? { ...item, state: "done" as const } : item)));
		assert.equal(agentPanelCounts(panel.session).total, 0);
	});

	test("the panel model keeps exactly the rows and counts the engine's ranking lists", () => {
		const run: AgentPanelItem = { id: "run:w", kind: "workflow", state: "done", name: "ralph", task: "ship" };
		const scenarios: AgentPanelItem[][] = [
			[agent("a", "done"), agent("b", "running")],
			[agent("a", "failed"), agent("b", "stopped"), agent("c", "paused")],
			[agent("a", "stopped"), agent("b", "waiting")],
			[run, agent("a", "stopped")],
			[{ ...run, viewed: true }, agent("a", "input"), agent("b", "stopped")],
		];
		for (const items of scenarios) {
			const panel = panelSession(items);
			const label = JSON.stringify(items.map((i) => i.state));
			assert.deepEqual(new Set(modelIds(items)), new Set(panel.ids()), label);
			const { total, agents, needsInput } = agentPanelCounts(panel.session);
			assert.deepEqual(panelCounts(modelRows(items)), { total, agents, needsInput }, label);
		}
	});
});

describe("native subagent tasks", () => {
	test("finished, cancelled and interrupted subagents leave the panel once nothing runs, and the hint points to /tasks", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("finishes");
			await fixture.start("interrupted");
			await fixture.start("keeps running");
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			bindOwnerTaskStore(session, fixture.store);
			const [finishes, interrupted, running] = fixture.store.tasks.map((task) => `task:${task.ref.taskId}`);

			await fixture.settle(0);
			fixture.store.setTurnInterrupted(fixture.store.tasks[1]!.ref.taskId, true);
			assert.equal(
				agentPanelRows(session).some((row) => row.id === finishes),
				false,
			);
			assert.deepEqual(new Set(agentPanelRows(session).map((row) => row.id)), new Set([interrupted, running]));
			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["↓ 2 agents", "? keys"]);

			fixture.runners[2]!.result.resolve({ kind: "cancelled", cause: "user" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			fixture.store.drain();
			assert.deepEqual(agentPanelRows(session), []);
			assert.deepEqual(agentPanelCounts(session), {
				total: 0,
				agents: 0,
				needsInput: 0,
				shells: 0,
				searches: 0,
				subagents: 3,
			});
			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["/tasks to see subagents", "? keys"]);
			assert.equal(running !== undefined, true);
		} finally {
			await fixture.dispose();
		}
	});

	test("an attached chat's footer drops an interrupted subagent once nothing else runs", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("interrupted");
			await fixture.start("running");
			fixture.store.setTurnInterrupted(fixture.store.tasks[0]!.ref.taskId, true);
			const both = renderTaskFooter(fixture.store.backgroundTasks, 120).join("\n");
			assert.match(both, /interrupted/u);
			assert.match(both, /running/u);

			fixture.runners[1]!.result.resolve({ kind: "completed", output: fixture.store.tasks[1]!.output });
			await new Promise<void>((resolve) => setImmediate(resolve));
			fixture.store.drain();
			// The chat's own key hint offers ↓ to its task list, so the footer adds no /tasks pointer.
			assert.deepEqual(renderTaskFooter(fixture.store.backgroundTasks, 120), []);
		} finally {
			await fixture.dispose();
		}
	});
});

describe("the hint names /tasks when the panel has no rows", () => {
	test("subagents without rows point to /tasks; running shells keep the shell wording", () => {
		assert.deepEqual(mainComposerHintSegments(keybindings, { agentRows: 0, subagents: 2 }), [
			"/tasks to see subagents",
			"? keys",
		]);
		assert.deepEqual(mainComposerHintSegments(keybindings, { agentRows: 0, subagents: 2, shells: 1 }), [
			"1 shell",
			"/tasks to manage",
			"? keys",
		]);
		assert.deepEqual(mainComposerHintSegments(keybindings, { agentRows: 1, subagents: 2 }), ["↓ 1 agent", "? keys"]);
	});

	test("the isolated engine forwards the agent and subagent counts to the host", () => {
		const state = { type: "engine_agent_panel_state", total: 2, agents: 1, needsInput: 0, shells: 0, subagents: 4 };
		assert.deepEqual(parseInteractiveEngineMessage(JSON.stringify(state)), state);
		assert.equal(
			parseInteractiveEngineMessage(JSON.stringify({ ...state, agents: 3 })),
			undefined,
			"more agents than rows is refused",
		);
	});
});

describe("only subagent rows count as agents", () => {
	const run = (state: AgentPanelItem["state"]): AgentPanelItem => ({
		id: "run:w",
		kind: "workflow",
		state,
		name: "ralph",
		task: "ship",
	});

	test("a lone running workflow run is not counted as an agent, and ↓ still focuses its row", () => {
		const panel = panelSession([run("running")]);
		assert.deepEqual(panel.ids(), ["run:w"]);
		assert.equal(agentPanelCounts(panel.session).total, 1);
		assert.equal(agentPanelCounts(panel.session).agents, 0);
		assert.deepEqual(panel.hint(), ["? keys"]);
	});

	test("a workflow run and two subagents count as two agents", () => {
		const panel = panelSession([run("running"), agent("a", "running"), agent("b", "running")]);
		assert.deepEqual(panel.hint(), ["↓ 2 agents", "? keys"]);
	});

	test("a workflow run waiting on an answer with no subagents shows only its question count", () => {
		const panel = panelSession([{ ...run("input"), question: "Ship it?" }]);
		assert.deepEqual(panel.hint(), ["1 needs input", "? keys"]);
	});
});

describe("a paused or blocked workflow run rests like a paused subagent (#5490)", () => {
	/** A workflow run's row; a live run that is paused, or blocked on a failed stage, reads `paused`. */
	const run = (state: AgentPanelItem["state"], id = "w"): AgentPanelItem => ({
		id: `run:${id}`,
		kind: "workflow",
		state,
		name: "ralph",
		task: "stage review",
	});
	const shell = (state: AgentPanelItem["state"]): AgentPanelItem => ({
		id: "ext:sh",
		kind: "shell",
		state,
		name: "shell",
		task: "sleep 300",
	});

	test("stays listed while a subagent runs, and the whole panel goes once nothing is active (#5490)", () => {
		const items = [run("paused"), agent("stopped", "stopped"), agent("live", "running")];
		const panel = panelSession(items);
		assert.deepEqual(new Set(panel.ids()), new Set(["run:w", "ext:stopped", "ext:live"]));
		assert.deepEqual(new Set(modelIds(items)), new Set(panel.ids()));
		assert.deepEqual(panel.hint(), ["↓ 2 agents", "? keys"]);

		const idle = [run("paused"), agent("stopped", "stopped"), agent("live", "done")];
		panel.set(idle);
		assert.deepEqual(panel.ids(), []);
		assert.deepEqual(modelIds(idle), []);
		assert.equal(agentPanelCounts(panel.session).total, 0);
		assert.deepEqual(panel.hint(), ["/workflows to see runs", "? keys"]);
	});

	test("alone, it does not keep the panel up (#5490)", () => {
		const panel = panelSession([run("paused")]);
		assert.deepEqual(panel.ids(), []);
		assert.deepEqual(modelIds([run("paused")]), []);
		assert.deepEqual(panel.hint(), ["/workflows to see runs", "? keys"]);
	});

	test("both hosts point to /workflows while a paused run is missing from the panel (#5710)", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("keeps running");
			const panel = panelSession([run("paused")]);
			bindOwnerTaskStore(panel.session, fixture.store);
			let hostHint: string[] = [];
			const dispose = bindAgentPanel(panel.session, { setWidget() {}, requestRender() {} } as never, (counts) => {
				const message = parseInteractiveEngineMessage(
					serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }).trim(),
				);
				if (message?.type === "engine_agent_panel_state") {
					hostHint = mainComposerHintSegments(keybindings, () => engineAgentPanelCounts(message));
				}
			});
			const expectHints = async (...expected: string[]) => {
				assert.deepEqual(panel.hint(), expected);
				await vi.waitFor(() => assert.deepEqual(hostHint, expected));
			};
			try {
				await expectHints("↓ 1 agent", "? keys");
				await fixture.settle(0);
				assert.deepEqual(panel.ids(), []);
				await expectHints("/tasks to see subagents", "/workflows to see runs", "? keys");
				panel.set([run("paused"), agent("new", "running")]);
				assert.deepEqual(panel.ids(), ["ext:new"]);
				await expectHints("↓ 1 agent", "/workflows to see runs", "? keys");
				panel.set([agent("new", "running")]);
				await expectHints("↓ 1 agent", "? keys");
			} finally {
				dispose();
			}
		} finally {
			await fixture.dispose();
		}
	});

	describe.each(["in-process", "isolated"] as const)("%s host", (host) => {
		test.each([80, 120, 160])(
			"the workflow hint uses only spare footer cells at %i columns (#5710)",
			async (width) => {
				vi.stubEnv("ATOMIC_EXPERIMENTAL", "1");
				vi.stubEnv("ATOMIC_DEBUG", "1");
				const home = resolve("home");
				vi.stubEnv("HOME", home);
				const fixture = taskFixture();
				try {
					await fixture.start("keeps running");
					const panel = panelSession([run("paused")]);
					bindOwnerTaskStore(panel.session, fixture.store);
					await fixture.settle(0);
					assert.deepEqual(panel.ids(), []);
					const message = parseInteractiveEngineMessage(
						serializeInteractiveEngineMessage({
							type: "engine_agent_panel_state",
							...agentPanelCounts(panel.session),
						}),
					);
					assert.ok(message?.type === "engine_agent_panel_state");
					const source = host === "isolated" ? () => engineAgentPanelCounts(message) : panel.session;
					let directory = "footer" + "x".repeat(width - 80);
					const footer = new FooterComponent(
						{
							state: { model: { provider: "local", id: "cap-1" } },
							sessionManager: { getCwd: () => resolve(home, directory) },
						} as never,
						{
							getGitBranch: () => "main",
							getExtensionStatuses: () => new Map(),
							getAvailableProviderCount: () => 1,
							onBranchChange: () => () => {},
						},
						undefined,
						undefined,
						undefined,
						() => mainComposerFooterHints(keybindings, source),
					);
					const line = () => stripTerminalSequences(footer.render(width)[0]!);
					const prefix = () => `cap-1 • ~${sep}${directory} (main) xp debug · /tasks to see subagents`;
					assert.equal(line(), `${prefix()} · ? keys`);
					directory = "footer";
					assert.equal(line(), `${prefix()}${width === 80 ? "" : " · /workflows to see runs"} · ? keys`);
				} finally {
					await fixture.dispose();
				}
			},
		);
	});

	test("stays listed while another workflow run or a background shell is active (#5490)", () => {
		for (const other of [run("running", "other"), run("waiting", "other"), shell("running")]) {
			const items = [run("paused"), other];
			const panel = panelSession(items);
			const expected = other.kind === "shell" ? ["run:w"] : ["run:w", "run:other"];
			assert.deepEqual(new Set(panel.ids()), new Set(expected), other.state);
			assert.deepEqual(new Set(modelIds(items)), new Set(expected), other.state);
		}
	});

	test("once it left, it stays out when new work starts and comes back only after it runs again (#5490)", () => {
		const panel = panelSession([run("paused"), agent("a", "running")]);
		assert.deepEqual(new Set(panel.ids()), new Set(["run:w", "ext:a"]));
		panel.set([run("paused"), agent("a", "done")]);
		assert.deepEqual(panel.ids(), []);

		panel.set([run("paused"), agent("a", "done"), agent("b", "running")]);
		assert.deepEqual(panel.ids(), ["ext:b"], "a new subagent does not bring the paused run back");

		panel.set([run("running"), agent("a", "done"), agent("b", "running")]);
		assert.deepEqual(new Set(panel.ids()), new Set(["run:w", "ext:b"]), "resumed, it is listed again");
		panel.set([run("paused"), agent("a", "done"), agent("b", "running")]);
		assert.deepEqual(new Set(panel.ids()), new Set(["run:w", "ext:b"]), "paused again while work runs");
	});

	test("a run waiting for input still keeps the panel up and counts as needing input (#5490)", () => {
		const items = [{ ...run("input"), question: "Ship it?" }, run("paused", "other")];
		const panel = panelSession(items);
		assert.deepEqual(new Set(panel.ids()), new Set(["run:w", "run:other"]));
		assert.deepEqual(new Set(modelIds(items)), new Set(panel.ids()));
		assert.deepEqual(panel.hint(), ["1 needs input", "? keys"]);
	});

	test("a stopped run still stays until it is opened, and does not read as resting (#5490)", () => {
		const panel = panelSession([run("stopped")]);
		assert.deepEqual(panel.ids(), ["run:w"]);
		assert.deepEqual(modelIds([run("stopped")]), ["run:w"]);
		panel.set([{ ...run("stopped"), viewed: true }]);
		assert.deepEqual(panel.ids(), []);
	});
});

describe("the focused panel", () => {
	for (const [name, initial] of [
		["its only subagent finishes", [agent("a", "running")]],
		[
			"the only active subagent finishes and the stopped one leaves with it",
			[agent("a", "running"), agent("b", "stopped")],
		],
		[
			"the only active subagent finishes and a paused workflow run leaves with it (#5490)",
			[
				agent("a", "running"),
				{ id: "run:w", kind: "workflow", state: "paused", name: "ralph", task: "stage review" },
			],
		],
	] as const) {
		test(`returns to the prompt when ${name}`, async () => {
			const panel = panelSession([...initial]);
			let closed = false;
			const shown = showAgentPanel(
				panel.session as never,
				{
					custom: (factory: (...args: never[]) => { render(width: number): string[]; dispose?(): void }) =>
						new Promise<void>((resolve) => {
							const component = factory(
								{ requestRender() {} } as never,
								theme as never,
								keybindings as never,
								(() => {
									closed = true;
									component.dispose?.();
									resolve();
								}) as never,
							);
							component.render(100);
						}),
				} as never,
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(closed, false);
			panel.set(initial.map((item) => (item.id === "ext:a" ? { ...item, state: "done" as const } : item)));
			for (let i = 0; i < 5 && !closed; i++) await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(closed, true, "the focus went back to the prompt");
			await shown;
		});
	}
});

describe("an attached chat's footer and the main panel agree", () => {
	test("interrupted, then nothing active, then a new subagent: the same rows", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("interrupted");
			await fixture.start("running");
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			bindOwnerTaskStore(session, fixture.store);
			const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
			const footer = () =>
				renderTaskFooter(fixture.store.backgroundTasks, 120, clocks).map((line) =>
					line.replace(/\x1b\[[\d;:]*m/g, "").trimEnd(),
				);
			const titles = (lines: string[]) =>
				lines.filter((line) => !line.includes("/tasks")).map((line) => /worker {2}(\S+)/.exec(line)?.[1]);
			const mainTitles = () => agentPanelRows(session).map((row) => row.task);

			fixture.store.setTurnInterrupted(fixture.store.tasks[0]!.ref.taskId, true);
			assert.deepEqual(new Set(titles(footer())), new Set(mainTitles()));
			assert.equal(mainTitles().length, 2);

			fixture.runners[1]!.result.resolve({ kind: "completed", output: fixture.store.tasks[1]!.output });
			await new Promise<void>((resolve) => setImmediate(resolve));
			fixture.store.drain();
			assert.deepEqual(mainTitles(), []);
			assert.deepEqual(footer(), []);
			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["/tasks to see subagents", "? keys"]);

			await fixture.start("new");
			assert.deepEqual(mainTitles(), ["new"], "the interrupted subagent does not come back in the main panel");
			assert.deepEqual(titles(footer()), ["new"], "nor in the chat's footer");
		} finally {
			await fixture.dispose();
		}
	});
});

describe("a resumed subagent", () => {
	test("is listed and counted once, as its latest attempt, in the panel and a chat's footer", async () => {
		const fixture = taskFixture();
		const launch = async (task: string, operation: string) => {
			const lease = taskValue(
				await fixture.supervisor.startAgentTask(
					fixture.owner,
					{ kind: "agent", agent: "worker", task },
					operation as Parameters<typeof fixture.supervisor.startAgentTask>[2],
				),
			);
			taskValue(await fixture.supervisor.initialObservation(lease, { kind: "background" }));
			fixture.store.drain();
		};
		const settle = async (index: number, result: Parameters<(typeof fixture.runners)[0]["result"]["resolve"]>[0]) => {
			fixture.runners[index]!.result.resolve(result);
			await new Promise<void>((resolve) => setImmediate(resolve));
			fixture.store.drain();
		};
		try {
			await launch("x", "child-x");
			await launch("y", "child-y");
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			bindOwnerTaskStore(session, fixture.store);
			const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
			const mainTitles = () => agentPanelRows(session).map((row) => row.task);
			const footerTitles = () =>
				renderTaskFooter(fixture.store.backgroundTasks, 120, clocks)
					.map((line) => line.replace(/\x1b\[[\d;:]*m/g, ""))
					.map((line) => /worker {2}(\S+)/.exec(line)?.[1]);

			await settle(0, { kind: "cancelled", cause: "user" });
			assert.deepEqual(new Set(mainTitles()), new Set(["x", "y"]), "stopped while another runs");

			await launch("x", "child-x:resume:1");
			assert.deepEqual(new Set(mainTitles()), new Set(["x", "y"]), "the resumed attempt replaces the stopped one");
			assert.equal(mainTitles().length, 2);
			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["↓ 2 agents", "? keys"]);
			assert.equal(footerTitles().length, 2);

			await settle(1, { kind: "completed", output: fixture.store.tasks[1]!.output });
			assert.deepEqual(mainTitles(), ["x"]);
			assert.deepEqual(mainComposerHintSegments(keybindings, session), ["↓ 1 agent", "? keys"]);
			assert.deepEqual(footerTitles(), ["x"]);
		} finally {
			await fixture.dispose();
		}
	});
});

describe("the isolated host's hint", () => {
	test("matches the in-process hint while subagents run and once the panel empties", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("one");
			await fixture.start("two");
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			bindOwnerTaskStore(session, fixture.store);
			let hostCounts: AgentPanelCounts | undefined;
			const idle = Promise.withResolvers<void>();
			// What the engine sends the host, as the host reads it.
			const dispose = bindAgentPanel(session, { setWidget() {}, requestRender() {} } as never, (counts) => {
				const message = parseInteractiveEngineMessage(
					serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }).trim(),
				);
				assert.ok(message?.type === "engine_agent_panel_state");
				hostCounts = engineAgentPanelCounts(message);
				if (hostCounts.total === 0) idle.resolve();
			});
			try {
				const isolated = () => mainComposerHintSegments(keybindings, () => hostCounts!);
				const inProcess = () => mainComposerHintSegments(keybindings, session);
				assert.deepEqual(inProcess(), ["↓ 2 agents", "? keys"]);
				assert.deepEqual(isolated(), inProcess());
				await fixture.settle(0);
				await fixture.settle(1);
				await idle.promise;
				assert.deepEqual(inProcess(), ["/tasks to see subagents", "? keys"]);
				assert.deepEqual(isolated(), inProcess());
			} finally {
				dispose();
			}
		} finally {
			await fixture.dispose();
		}
	});
});

describe("a running shell counts as active work", () => {
	const stoppedAgent = () => {
		const task = { ...taskRecord("stopped-agent"), agentName: "worker", title: "stopped work" };
		task.execution = { kind: "settled", result: { kind: "cancelled", cause: "user" } };
		return task;
	};
	const runningShell = () => ({ ...taskRecord("running-shell", "command"), title: "sleep 300" });
	const bindTasks = (session: object, tasks: readonly ReturnType<typeof taskRecord>[]) =>
		bindOwnerTaskStore(session, {
			tasks,
			backgroundTasks: tasks,
			ownerTasks: tasks,
			ownerBackgroundTasks: tasks,
			settlementOrder: new Map(),
			panelRevision: 1,
			taskRecord: (id: string) => tasks.find((task) => task.ref.taskId === id),
			recentActivity: () => [],
			activityOmitted: () => false,
			subscribe: () => () => {},
		} as never);

	test("in the main panel: a stopped subagent stays listed while a background shell runs", () => {
		const withShell = {};
		bindTasks(withShell, [stoppedAgent(), runningShell()]);
		assert.deepEqual(
			agentPanelRows(withShell).map((row) => row.id),
			["task:stopped-agent"],
		);
		const alone = {};
		bindTasks(alone, [stoppedAgent()]);
		assert.deepEqual(agentPanelRows(alone), []);
	});

	test("in a chat's task footer: a stopped subagent stays listed while a background shell runs", () => {
		const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[\d;:]*m/g, "").trimEnd());
		const withShell = plain(renderTaskFooter([stoppedAgent(), runningShell()], 100));
		assert.match(withShell[0] ?? "", /^ {2}◼ worker {2}stopped work/u);
		assert.deepEqual(withShell.slice(1), ["  1 shell"]);
		assert.deepEqual(renderTaskFooter([stoppedAgent()], 100), []);
	});
});

describe("the /tasks pointer", () => {
	test("does not show while the panel lists rows, even when no key focuses it", () => {
		const unboundFocus = {
			matches: () => false,
			getKeys: (action: string) => (action === "app.keys.help" ? ["?"] : []),
		};
		assert.deepEqual(mainComposerHintSegments(unboundFocus, { agentRows: 1, subagents: 2 }), ["? keys"]);
		assert.deepEqual(mainComposerHintSegments(unboundFocus, { agentRows: 0, subagents: 2 }), [
			"/tasks to see subagents",
			"? keys",
		]);
	});
});
