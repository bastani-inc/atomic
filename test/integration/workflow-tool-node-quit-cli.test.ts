/**
 * End-to-end proof for issue #2078, driven through the real Atomic CLI.
 *
 * A workflow whose only in-flight work is a `ctx.tool` call used to be
 * uncontrollable: `quitRun` looked at the stage control registry alone, found
 * nothing, and answered `no_active_stages` while the callback kept running. The
 * callback also had no way to observe cancellation, so nothing could stop it.
 *
 * This suite spawns the actual CLI (`packages/coding-agent/src/cli.ts`) in its
 * RPC mode, which is the same `AgentSession` slash-command path the interactive
 * TUI uses, points it at a scratch project holding the fixture workflow, and
 * drives one scenario:
 *
 *   /workflow issue-2078-tool-quit   launch; `hang-tool` parks on its signal
 *   /workflow status <run>           the run is running, tool-only
 *   /workflow quit <run>             abort, settle, then pause as resumable
 *   /workflow status <run>           the node is cancelled, not failed
 *   /workflow resume <run>           re-run only the aborted call
 *
 * Nothing here is mocked: the workflows extension, the durable executor, the
 * control registries and the `/workflow` command are the shipped ones. Against
 * the parent commit the quit leg reports "No controllable stages on run …; the
 * run remains active.", the callback never observes an abort, and the run never
 * becomes resumable, so every assertion below fails there.
 *
 * cross-ref: https://github.com/bastani-inc/atomic/issues/2078
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, test } from "vitest";
import { bunExecutable, decodeStream, moduleDir, type SpawnedProcess, spawnProcess } from "../helpers/runtime.js";

/**
 * Structural: this hook compiles and boots the whole coding-agent CLI in a child
 * process — every builtin extension package included — before a single prompt is
 * sent, and then drives five of them. Named and kept at the call site, per the
 * per-test timeout policy in AGENTS.md; the observed cost is about two seconds
 * with a warm Bun transform cache, and the headroom is for a cold one.
 */
const REAL_CLI_SCENARIO_TIMEOUT_MS = 240_000;

/** The first prompt also pays for starting the CLI, so it gets its own budget. */
const CLI_STARTUP_TIMEOUT_MS = 120_000;

/** Per-step deadline inside the scenario, once the CLI is answering. */
const STEP_TIMEOUT_MS = 60_000;

/**
 * How long the resumed run is given to re-execute the aborted callback. It is
 * generous because it is only ever waited out when the fix is absent; on this
 * branch the re-execution lands in milliseconds.
 */
const RESUME_SETTLE_TIMEOUT_MS = 20_000;

/** Must match `ISSUE_2078_STATE_FILE` in the fixture; asserted below. */
const STATE_FILE = "issue-2078-state.json";
const FIXTURE = "issue-2078-tool-quit-workflow.ts";
const WORKFLOW_NAME = "issue-2078-tool-quit";

const repositoryRoot = join(moduleDir(import.meta.url), "../..");
const fixturePath = join(moduleDir(import.meta.url), "fixtures", FIXTURE);

/** Written by the fixture workflow; read from outside the CLI process. */
interface FixtureState {
	readonly siblingExecutions: number;
	readonly hangExecutions: number;
	readonly hangRunning: boolean;
	readonly hangObservedAbort: boolean;
}

interface ToolNodeView {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly error?: string;
	readonly replayed?: boolean;
	readonly resultSummary?: string;
	readonly attachable?: boolean;
}

interface StageView {
	readonly id: string;
	readonly name: string;
	readonly status: string;
}

/** The `/workflow status <run>` drill-down payload (`RunDetail`). */
interface RunDetailView {
	readonly runId: string;
	readonly name: string;
	readonly status: string;
	readonly stages: readonly StageView[];
	readonly tools?: readonly ToolNodeView[];
	readonly resumable?: boolean;
	readonly exitReason?: string;
	readonly result?: { readonly hang?: string; readonly sibling?: string };
}

interface WorkflowSurfaceDetails {
	readonly kind: string;
	readonly runId?: string;
	readonly detail?: RunDetailView;
}

/** The `workflow.run.end` session entry, which names the terminal status. */
interface RunEnding {
	readonly runId: string;
	readonly status: string;
	readonly error?: string;
}

type RpcLine =
	| { readonly type: "extension_ui_request"; readonly method: string; readonly message?: string }
	| {
			readonly type: "message_end";
			readonly message: { readonly content: string; readonly details?: WorkflowSurfaceDetails };
	  }
	| {
			readonly type: "entry_appended";
			readonly entry: { readonly type: string; readonly customType?: string; readonly data?: RunEnding };
	  }
	| { readonly type: "response"; readonly id?: string; readonly command: string; readonly success: boolean }
	| { readonly type: "other" };

/** One rendered `/workflow` surface: the text a user sees plus its payload. */
interface Surface {
	readonly content: string;
	readonly details: WorkflowSurfaceDetails;
}

class RpcCli {
	private readonly child: SpawnedProcess;
	private readonly lines: RpcLine[] = [];
	private buffered = "";
	private stderr = "";

	constructor(projectDir: string, agentDir: string, stateDir: string) {
		const environment: Record<string, string | undefined> = { ...process.env };
		// A suite that itself runs inside an Atomic engine session would otherwise
		// leak its engine-child markers and its own fixture state directory.
		for (const key of Object.keys(environment)) {
			if (key.startsWith("ATOMIC_") || key.startsWith("ISSUE_2078_")) delete environment[key];
		}
		this.child = spawnProcess({
			cmd: [bunExecutable(), join(repositoryRoot, "packages/coding-agent/src/cli.ts"), ...CLI_ARGS],
			cwd: projectDir,
			env: {
				...environment,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ISSUE_2078_STATE_DIR: stateDir,
				// Durability is deliberately in-process: the shared local Postgres
				// cluster under ~/.atomic is shared by every concurrent Atomic
				// session, and vitest runs files in parallel. The unreachable URL
				// selects the shipped in-memory backend, which implements the same
				// interface, so quit's durable transition and resume's checkpoint
				// replay are exercised without an external service.
				DBOS_SYSTEM_DATABASE_URL: "postgresql://issue2078:issue2078@127.0.0.1:1/unreachable",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.read();
	}

	private async read(): Promise<void> {
		const stdout = this.child.stdout;
		const stderr = this.child.stderr;
		if (stdout === null || stderr === null) throw new Error("the CLI child must expose piped stdio");
		const drainErr = async (): Promise<void> => {
			const reader = decodeStream(stderr).getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) return;
				this.stderr += chunk.value;
			}
		};
		void drainErr();
		const reader = decodeStream(stdout).getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			this.buffered += chunk.value;
			const parts = this.buffered.split("\n");
			this.buffered = parts.pop() ?? "";
			for (const part of parts) {
				if (part.trim() === "") continue;
				try {
					this.lines.push(JSON.parse(part) as RpcLine);
				} catch {
					// Non-JSON stdout is startup noise; the protocol lines are what
					// this driver reads.
				}
			}
		}
	}

	/** Every `ctx.ui.notify` the CLI emitted, in order. */
	notifications(): readonly string[] {
		return this.lines.flatMap((line) =>
			line.type === "extension_ui_request" && line.method === "notify" && line.message !== undefined
				? [line.message]
				: [],
		);
	}

	/** Every rendered workflow surface, in order. */
	surfaces(): readonly Surface[] {
		return this.lines.flatMap((line) =>
			line.type === "message_end" && line.message.details !== undefined
				? [{ content: line.message.content, details: line.message.details }]
				: [],
		);
	}

	/** Every terminal `workflow.run.end` the CLI recorded, in order. */
	runEndings(): readonly RunEnding[] {
		return this.lines.flatMap((line) =>
			line.type === "entry_appended" && line.entry.customType === "workflow.run.end" && line.entry.data !== undefined
				? [line.entry.data]
				: [],
		);
	}

	private answered(id: string): boolean {
		return this.lines.some((line) => line.type === "response" && line.id === id);
	}

	/**
	 * Poll until `ready`, reporting whether it happened inside the deadline.
	 *
	 * Used for the behavior under test, which must produce an assertion about
	 * what the CLI did rather than a timeout about what the harness gave up on.
	 */
	async settle(ready: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (ready()) return true;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return false;
	}

	/** Poll until `ready`; a miss is a broken harness step, so it throws. */
	async waitUntil(ready: () => boolean, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
		if (await this.settle(ready, timeoutMs)) return;
		throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}.\nCLI stderr:\n${this.stderr}`);
	}

	/** Send one prompt (a slash command here) and wait for the CLI to answer it. */
	async prompt(id: string, message: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
		const stdin = this.child.stdin;
		if (stdin === null) throw new Error("the CLI child must expose piped stdin");
		stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		await stdin.flush();
		await this.waitUntil(() => this.answered(id), `the CLI to answer ${message}`, timeoutMs);
	}

	async stop(): Promise<void> {
		this.child.kill("SIGKILL");
		await this.child.exited;
	}
}

const CLI_ARGS = ["--mode", "rpc", "--approve", "--offline", "--no-session"] as const;

/** Everything the scenario observed, captured once and asserted many times. */
interface Evidence {
	readonly runId: string;
	readonly whileRunning: RunDetailView;
	readonly afterQuit: RunDetailView;
	readonly afterResume: RunDetailView;
	readonly renderedAfterQuit: string;
	readonly quitNotifications: readonly string[];
	readonly stateWhenQuitReturned: FixtureState;
	readonly finalState: FixtureState;
}

/**
 * One `/workflow status <run>` drill-down: the box a user sees plus its payload.
 *
 * The RPC transport answers a prompt independently of the message the command
 * rendered, so the surface is awaited rather than assumed to have arrived.
 */
async function statusSurface(cli: RpcCli, id: string, runId: string): Promise<Surface> {
	const mark = cli.surfaces().length;
	await cli.prompt(id, `/workflow status ${runId}`);
	const rendered = (): Surface | undefined =>
		cli
			.surfaces()
			.slice(mark)
			.findLast((candidate) => candidate.details.kind === "detail" && candidate.details.detail?.runId === runId);
	await cli.waitUntil(() => rendered() !== undefined, `the status surface for run ${runId}`);
	const surface = rendered();
	if (surface === undefined) throw new Error(`the CLI rendered no status surface for run ${runId}`);
	return surface;
}

function runDetail(surface: Surface): RunDetailView {
	const detail = surface.details.detail;
	if (detail === undefined) throw new Error("the status surface carried no run detail");
	return detail;
}

function toolNode(run: RunDetailView, name: string): ToolNodeView {
	const node = (run.tools ?? []).find((candidate) => candidate.name === name);
	if (node === undefined) throw new Error(`run ${run.runId} has no ${name} tool node`);
	return node;
}

async function runScenario(): Promise<Evidence> {
	const root = mkdtempSync(join(tmpdir(), "atomic-issue-2078-"));
	const projectDir = join(root, "project");
	const stateDir = join(root, "state");
	const agentDir = join(root, "agent");
	mkdirSync(join(projectDir, ".atomic/workflows"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	copyFileSync(fixturePath, join(projectDir, ".atomic/workflows", FIXTURE));

	const readState = (): FixtureState => {
		const path = join(stateDir, STATE_FILE);
		if (!existsSync(path)) {
			return { siblingExecutions: 0, hangExecutions: 0, hangRunning: false, hangObservedAbort: false };
		}
		return JSON.parse(readFileSync(path, "utf8")) as FixtureState;
	};

	const cli = new RpcCli(projectDir, agentDir, stateDir);
	try {
		// 1. Launch. The launch returns at startup admission, so the callback is
		//    only proven in flight once it says so itself. A run that ends first
		//    never reached the state under test, and says so instead of waiting.
		await cli.prompt("launch", `/workflow ${WORKFLOW_NAME}`, CLI_STARTUP_TIMEOUT_MS);
		await cli.waitUntil(
			() => readState().hangRunning || cli.runEndings().length > 0,
			"hang-tool's callback to start",
		);
		const premature = cli.runEndings().at(0);
		if (premature !== undefined) {
			throw new Error(
				`the run ended (${premature.status}) before hang-tool's callback parked: ${premature.error ?? "no error recorded"}`,
			);
		}
		const dispatched = cli.surfaces().find((surface) => surface.details.kind === "dispatch");
		const runId = dispatched?.details.runId;
		if (runId === undefined) throw new Error("the CLI did not render a dispatched run id");

		// 2. The run as the user sees it: tool-only, nothing pausable in it.
		const whileRunning = runDetail(await statusSurface(cli, "status-running", runId));

		// 3. Quit. The state is read the instant the CLI answers, which is what
		//    makes the durability-boundary ordering observable from outside.
		const notificationsBeforeQuit = cli.notifications().length;
		await cli.prompt("quit", `/workflow quit ${runId}`);
		const stateWhenQuitReturned = readState();
		const quitNotifications = cli.notifications().slice(notificationsBeforeQuit);

		// 4. The cancelled node, rendered.
		const quitSurface = await statusSurface(cli, "status-quit", runId);
		const afterQuit = runDetail(quitSurface);
		const renderedAfterQuit = quitSurface.content;

		// 5. Resume: the aborted call must run again while the settled sibling
		//    replays. Whether that happens is the behavior under test, so the
		//    wait is bounded and its outcome is recorded rather than thrown —
		//    a run that quit did not pause simply never re-executes anything,
		//    and the assertions below say so with the CLI's own words.
		await cli.prompt("resume", `/workflow resume ${runId}`);
		const reexecuted = await cli.settle(() => readState().hangExecutions > 1, RESUME_SETTLE_TIMEOUT_MS);
		if (reexecuted) await cli.waitUntil(() => !readState().hangRunning, "the re-executed callback to settle");
		const afterResume = runDetail(await statusSurface(cli, "status-resumed", runId));

		return {
			runId,
			whileRunning,
			afterQuit,
			afterResume,
			renderedAfterQuit,
			quitNotifications,
			stateWhenQuitReturned,
			finalState: readState(),
		};
	} finally {
		await cli.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

let evidence: Evidence;

describe("issue #2078 — quitting an in-flight ctx.tool through the real CLI", () => {
	beforeAll(async () => {
		evidence = await runScenario();
	}, REAL_CLI_SCENARIO_TIMEOUT_MS);

	test("the run under test really is tool-only, so no stage could have been the control target", () => {
		assert.deepEqual(evidence.whileRunning.stages, []);
		assert.equal(evidence.whileRunning.status, "running");
		assert.equal(toolNode(evidence.whileRunning, "hang-tool").status, "running");
		assert.equal(toolNode(evidence.whileRunning, "sibling-tool").status, "completed");
		// The abort surface never turns a tool node into a chat target.
		assert.equal(toolNode(evidence.whileRunning, "hang-tool").attachable, false);
	});

	test("quit pauses a tool-only run as resumable instead of reporting no controllable stages", () => {
		assert.deepEqual(
			evidence.quitNotifications.filter((message) => message.includes("No controllable stages")),
			[],
		);
		assert.equal(
			evidence.quitNotifications.some((message) =>
				message.includes(`Run ${evidence.runId} quit and can be resumed with /workflow resume.`),
			),
			true,
			`quit notifications were: ${JSON.stringify(evidence.quitNotifications)}`,
		);
		assert.equal(evidence.afterQuit.status, "paused");
		assert.equal(evidence.afterQuit.exitReason, "quit");
		assert.equal(evidence.afterQuit.resumable, true);
	});

	test("the ctx.tool callback receives an AbortSignal and unblocks on quit", () => {
		assert.equal(evidence.stateWhenQuitReturned.hangObservedAbort, true);
		assert.equal(evidence.stateWhenQuitReturned.hangRunning, false);
	});

	test("the durable paused transition is not recorded until the aborted node settled", () => {
		// Both observations come from the moment the quit call answered: the
		// callback had already settled, and the node was already published as
		// cancelled, before the run was declared paused and resumable.
		assert.equal(evidence.stateWhenQuitReturned.hangObservedAbort, true);
		assert.equal(toolNode(evidence.afterQuit, "hang-tool").status, "cancelled");
		assert.equal(
			toolNode(evidence.afterQuit, "hang-tool").error,
			"atomic-workflows: ctx.tool hang-tool aborted by workflow quit",
		);
	});

	test("the cancelled tool node is rendered distinctly from a failed one", () => {
		assert.match(evidence.renderedAfterQuit, /hang-tool\s+cancelled/);
		assert.doesNotMatch(evidence.renderedAfterQuit, /hang-tool\s+failed/);
		// A settled sibling is untouched by the abort.
		assert.equal(toolNode(evidence.afterQuit, "sibling-tool").status, "completed");
	});

	test("resume re-executes exactly the aborted call at the same node identity", () => {
		const beforeResume = toolNode(evidence.afterQuit, "hang-tool");
		const afterResume = toolNode(evidence.afterResume, "hang-tool");
		assert.equal(afterResume.id, beforeResume.id, "the re-run must occupy the same tool:<argsHash> node");
		assert.equal(afterResume.status, "completed");
		assert.equal(afterResume.resultSummary, '"aborted-then-reran-2"');
		assert.equal(evidence.finalState.hangExecutions, 2);
	});

	test("the settled sibling replays from cache instead of running twice", () => {
		const sibling = toolNode(evidence.afterResume, "sibling-tool");
		assert.equal(sibling.status, "cached");
		assert.equal(sibling.replayed, true);
		assert.equal(evidence.finalState.siblingExecutions, 1);
	});

	test("the quit run completes after resume, with no cancellation replayed as data", () => {
		assert.equal(evidence.afterResume.status, "completed");
		assert.deepEqual(evidence.afterResume.result, { hang: "aborted-then-reran-2", sibling: "sibling-ran-1" });
	});
});

test("the driver and the fixture agree on the state file name", () => {
	const source = readFileSync(fixturePath, "utf8");
	assert.match(source, new RegExp(`ISSUE_2078_STATE_FILE = "${STATE_FILE}"`));
	assert.match(source, new RegExp(`name: "${WORKFLOW_NAME}"`));
});
