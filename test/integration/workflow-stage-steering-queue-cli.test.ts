/**
 * End-to-end proof for issue #2074, driven through the real Atomic CLI.
 *
 * Issue #2074 reported that the queued-message UI of a live workflow stage is
 * view-local: the queue lives on the session, but the rows that show it live in
 * the stage-chat pane that detaching destroys. Leaving the node lost them, and
 * a stage nobody was attached to gave no sign that a message was waiting on it.
 *
 * This suite starts the shipped interactive CLI in a child process
 * (`fixtures/issue-2074-interactive-host.ts`, which runs `main()` through the
 * CLI's own `internalInteractiveHarness` hook and spawns the ordinary isolated
 * engine child), points it at a scratch project holding the fixture workflow
 * and at a stand-in model endpoint that opens the stage's turn and never closes
 * it, then drives one scenario with keystrokes:
 *
 *   /workflow issue-2074-stage-steering   launch; the stage turn opens
 *   F2                                    the workflow graph overlay
 *   ↵                                     attach to the streaming stage
 *   "steer-2074-alpha" ↵                  queued as steering
 *   "followup-2074-beta" ctrl+f           queued as a follow-up
 *   ctrl+x                                detach back to the graph
 *   ↵                                     reattach to the same stage
 *
 * Nothing is mocked below the terminal: the workflows extension, the stage
 * control registry, the graph overlay, the node card and the chat host are the
 * shipped ones, and the assertions read the bytes the TUI actually wrote.
 *
 * Against the parent commit the detached node renders its ordinary `root`
 * metadata row with no badge, and reattaching renders a chat with no pending
 * rows at all — both assertions below fail there. Verified, not assumed.
 *
 * cross-ref: https://github.com/bastani-inc/atomic/issues/2074
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	bunExecutable,
	decodeStream,
	moduleDir,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

/**
 * Structural: this hook compiles and boots the whole interactive CLI plus its
 * isolated engine child in child processes — every builtin extension package
 * included — starts a workflow run, waits for a real model turn to open, and
 * then drives seven keystroke steps through the TUI. Named and kept at the call
 * site per the per-test timeout policy in AGENTS.md. The headroom is for a cold
 * Bun transform cache; warm, the scenario settles in well under a minute.
 */
const REAL_CLI_STAGE_CHAT_SCENARIO_TIMEOUT_MS = 300_000;

/** The first step also pays for starting the CLI and its engine child. */
const CLI_STARTUP_TIMEOUT_MS = 180_000;

/** Per-step deadline once the CLI is drawing. */
const STEP_TIMEOUT_MS = 60_000;

/** How often the driver asks the host for its accumulated terminal writes. */
const POLL_INTERVAL_MS = 100;

const HOST_PREFIX = "@@ISSUE_2074@@";
const WORKFLOW_FIXTURE = "issue-2074-stage-steering-workflow.ts";
const WORKFLOW_NAME = "issue-2074-stage-steering";
const STAGE_NAME = "steerable";
const MODEL_SERVER_FIXTURE = "issue-2074-model-server.ts";
const PORT_FILE = "model-port";

/** Must match `ISSUE_2074_STAGE_TEXT` in the model server; asserted below. */
const STAGE_TEXT = "issue-2074 stage is mid-turn";

const STEER_TEXT = "steer-2074-alpha";
const FOLLOW_UP_TEXT = "followup-2074-beta";
const STEER_ROW = `Steering: ${STEER_TEXT}`;
const FOLLOW_UP_ROW = `Follow-up: ${FOLLOW_UP_TEXT}`;
const QUEUED_BADGE = "✉ 2 queued";

/** Footer hints that identify which of the overlay's two views is drawn. */
const GRAPH_FOOTER = "↵ open stage chat";
const CHAT_FOOTER = "ctrl+x return to graph";

const ENTER = "\r";
const CTRL_F = "\x06";
const CTRL_X = "\x18";
/** The terminfo `kf2` sequence, which is what a terminal sends for F2. */
const F2 = "\x1bOQ";

const fixturesDir = join(moduleDir(import.meta.url), "fixtures");

/**
 * OSC hyperlinks, CSI cursor/colour control, and charset selects.
 *
 * The workflow graph theme paints in truecolour whether or not NO_COLOR is set,
 * and the TUI wraps every styled run in its own escapes, so a footer hint or a
 * card row reaches the byte stream in pieces. Assertions read what the terminal
 * would show instead.
 */
const TERMINAL_CONTROL = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

/** The characters a terminal would have shown, with control sequences removed. */
function rendered(output: string): string {
	return output.replace(TERMINAL_CONTROL, "");
}

interface HostReport {
	readonly type?: string;
	readonly output?: string;
	readonly editorText?: string;
}

/** The interactive CLI as a child process, driven by keystrokes. */
class InteractiveCli {
	private readonly child: SpawnedProcess;
	private readonly reports: HostReport[] = [];
	private buffered = "";
	private stderr = "";
	/** The rendered text of the last snapshot, kept for failure reporting. */
	private lastOutput = "";

	constructor(projectDir: string, agentDir: string, sessionDir: string) {
		const environment: Record<string, string | undefined> = { ...process.env };
		// A suite that itself runs inside an Atomic session would otherwise leak
		// its agent directory and its engine-child markers into the child.
		for (const key of Object.keys(environment)) {
			if (key.startsWith("ATOMIC_") || key.startsWith("ISSUE_2074_")) delete environment[key];
		}
		// `packages/workflows/src/extension/wiring.ts` treats NODE_ENV=test and
		// NODE_TEST_CONTEXT as "give stages a stub session". vitest sets the first
		// one, and inheriting it would replace the whole thing under test with a
		// stub that answers `prompt()` instantly and never streams — the run would
		// complete in milliseconds and there would be no queue at all.
		delete environment.NODE_TEST_CONTEXT;
		this.child = spawnProcess({
			cmd: [
				bunExecutable(),
				join(fixturesDir, "issue-2074-interactive-host.ts"),
				"--approve",
				"--offline",
				"--no-session",
			],
			cwd: projectDir,
			env: {
				...environment,
				NODE_ENV: "production",
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				NO_COLOR: "1",
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
		if (stdout === null || stderr === null) throw new Error("the CLI host child must expose piped stdio");
		void (async () => {
			const reader = decodeStream(stderr).getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) return;
				this.stderr += chunk.value;
			}
		})();
		const reader = decodeStream(stdout).getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			this.buffered += chunk.value;
			const parts = this.buffered.split("\n");
			this.buffered = parts.pop() ?? "";
			for (const part of parts) {
				const marker = part.indexOf(HOST_PREFIX);
				if (marker === -1) continue;
				this.reports.push(JSON.parse(part.slice(marker + HOST_PREFIX.length)) as HostReport);
			}
		}
	}

	private write(command: { type: string; data?: string }): void {
		const stdin = this.child.stdin;
		if (stdin === null) throw new Error("the CLI host child must expose piped stdin");
		stdin.write(`${JSON.stringify(command)}\n`);
		void stdin.flush();
	}

	/** Inject one keystroke or one run of typed text. */
	send(data: string): void {
		this.write({ type: "input", data });
	}

	/** Ask for, and wait for, the host's terminal writes so far, as rendered text. */
	private async snapshot(timeoutMs = STEP_TIMEOUT_MS): Promise<{ output: string; editorText: string }> {
		const mark = this.reports.length;
		this.write({ type: "state" });
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.reports.slice(mark).find((entry) => entry.type === "state");
			if (found !== undefined) {
				this.lastOutput = rendered(found.output ?? "");
				return { output: this.lastOutput, editorText: found.editorText ?? "" };
			}
			await sleep(10);
		}
		throw this.failure("the host to answer a state request", timeoutMs);
	}

	/** Everything the terminal has been told to show so far. */
	async output(): Promise<string> {
		return (await this.snapshot()).output;
	}

	/** Poll the rendered output until `ready`. */
	async waitForOutput(ready: (output: string) => boolean, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (ready((await this.snapshot()).output)) return;
			if (Date.now() >= deadline) throw this.failure(label, timeoutMs);
			await sleep(POLL_INTERVAL_MS);
		}
	}

	/** Wait until the CLI has drawn its first input loop. */
	async waitUntilReady(timeoutMs = CLI_STARTUP_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.reports.some((entry) => entry.type === "ready")) return;
			await sleep(POLL_INTERVAL_MS);
		}
		throw this.failure("the CLI to reach its input loop", timeoutMs);
	}

	/**
	 * Type a slash command and submit it.
	 *
	 * The editor offers completions, and the first Enter accepts an open popup
	 * rather than submitting, so submission is confirmed by the editor going
	 * empty; an Enter on an already-empty editor submits nothing.
	 */
	async submitCommand(text: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
		this.send(text);
		this.send(ENTER);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const state = await this.snapshot();
			if (state.editorText === "") return;
			if (Date.now() >= deadline) throw this.failure(`the editor to submit ${text}`, timeoutMs);
			this.send(ENTER);
			await sleep(POLL_INTERVAL_MS);
		}
	}

	private failure(label: string, timeoutMs: number): Error {
		return new Error(
			`timed out after ${timeoutMs}ms waiting for ${label}.` +
				`\nlast rendered screen:\n${this.lastOutput.slice(-4000)}` +
				`\nCLI stderr:\n${this.stderr.slice(-4000)}`,
		);
	}

	async stop(): Promise<void> {
		this.child.kill("SIGKILL");
		await this.child.exited;
	}
}

/** Start the stand-in model endpoint and return its base URL. */
async function startModelServer(stateDir: string): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
	const child = spawnProcess({
		cmd: [bunExecutable(), join(fixturesDir, MODEL_SERVER_FIXTURE), stateDir],
		stdout: "pipe",
		stderr: "pipe",
	});
	const portFile = join(stateDir, PORT_FILE);
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const port = Number(readFileSync(portFile, "utf8").trim());
			if (Number.isSafeInteger(port) && port > 0) {
				return {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					stop: async () => {
						child.kill("SIGKILL");
						await child.exited;
					},
				};
			}
		} catch {
			// Not listening yet.
		}
		await sleep(50);
	}
	child.kill("SIGKILL");
	throw new Error("the stand-in model server never published a port");
}

function writeAgentConfig(agentDir: string, baseUrl: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				issue2074: {
					baseUrl,
					apiKey: "issue-2074-test-key",
					api: "openai-responses",
					models: [
						{
							id: "issue-2074-model",
							name: "issue-2074-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 16_000,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "issue2074",
			defaultModel: "issue-2074-model",
			lastChangelogVersion: "0.0.0",
			firstRunOnboardingStartedVersion: "0.0.0",
			onboardedVersion: "0.0.0",
		}),
	);
}

/** Everything the scenario drew, sliced by the keystroke that caused it. */
interface Evidence {
	/** The graph as first opened, before any message has been queued. */
	readonly graphBeforeQueue: string;
	/** Everything drawn while attached, up to detaching. */
	readonly whileAttached: string;
	/** Everything drawn from the detach keystroke until the reattach keystroke. */
	readonly whileDetached: string;
	/** Everything drawn strictly after the reattach keystroke. */
	readonly afterReattach: string;
}

async function runScenario(): Promise<Evidence> {
	const root = mkdtempSync(join(tmpdir(), "atomic-issue-2074-"));
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const stateDir = join(root, "state");
	mkdirSync(join(projectDir, ".atomic/workflows"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	copyFileSync(join(fixturesDir, WORKFLOW_FIXTURE), join(projectDir, ".atomic/workflows", WORKFLOW_FIXTURE));
	// This scenario's stand-in model opens a turn and never closes it, which is
	// the whole point: the stage has to stay mid-turn while messages queue on it.
	// A main-chat lifecycle steer would therefore never settle either, so the run
	// launch pins `notifyOn` to the terminal kinds. What is under test here is
	// stage steering and queued-message state, not lifecycle notices, which have
	// their own unit coverage.
	mkdirSync(join(projectDir, ".atomic/extensions/workflow"), { recursive: true });
	writeFileSync(
		join(projectDir, ".atomic/extensions/workflow/config.json"),
		`${JSON.stringify({ workflowNotifications: { notifyOn: ["completed", "failed", "blocked"] } }, null, 2)}\n`,
	);

	const model = await startModelServer(stateDir);
	writeAgentConfig(agentDir, model.baseUrl);
	const cli = new InteractiveCli(projectDir, agentDir, sessionDir);
	try {
		await cli.waitUntilReady();

		// 1. Launch the run. It dispatches to the background, as a named
		//    workflow launch does in interactive chat.
		const beforeLaunch = (await cli.output()).length;
		await cli.submitCommand(`/workflow ${WORKFLOW_NAME}`, CLI_STARTUP_TIMEOUT_MS);
		await cli.waitForOutput(
			(output) => output.slice(beforeLaunch).includes("started in background"),
			"the run to be dispatched",
		);

		// 2. Open the graph overlay on the active run and read the node before
		//    anything is queued on it — the control for the badge assertion.
		const beforeGraph = (await cli.output()).length;
		cli.send(F2);
		await cli.waitForOutput(
			(output) => output.slice(beforeGraph).includes(GRAPH_FOOTER),
			"the workflow graph overlay",
		);
		const graphBeforeQueue = (await cli.output()).slice(beforeGraph);

		// 3. Attach, and wait for the stage to really be mid-turn. Everything
		//    after this depends on the session streaming: an idle session would
		//    deliver the messages instead of queueing them, and there would be
		//    no queue to lose. The wait is scoped to what this keystroke drew,
		//    because the main chat has a session on the same stand-in endpoint
		//    and says the same words.
		const beforeAttach = (await cli.output()).length;
		cli.send(ENTER);
		await cli.waitForOutput(
			(output) =>
				output.slice(beforeAttach).includes(STAGE_TEXT) && output.slice(beforeAttach).includes(CHAT_FOOTER),
			"the stage chat to open on a streaming turn",
		);

		// 4. Queue one message into each queue: Enter steers, ctrl+f follows up.
		cli.send(STEER_TEXT);
		cli.send(ENTER);
		await cli.waitForOutput(
			(output) => output.slice(beforeAttach).includes(STEER_ROW),
			"the typed message to be queued as steering",
		);
		cli.send(FOLLOW_UP_TEXT);
		cli.send(CTRL_F);
		await cli.waitForOutput(
			(output) => output.slice(beforeAttach).includes(FOLLOW_UP_ROW),
			"the ctrl+f message to be queued as follow-up",
		);
		const whileAttached = (await cli.output()).slice(beforeAttach);

		// 5. Leave the node. The queue is still live on the session, so the node
		//    the user is now looking at has to say so.
		const beforeDetach = (await cli.output()).length;
		cli.send(CTRL_X);
		await cli.waitForOutput(
			(output) => output.slice(beforeDetach).includes(QUEUED_BADGE),
			"the detached stage node to badge its queued messages",
		);

		// 6. Reattach. Everything drawn from here is the remounted chat, so a
		//    pending row in it was rehydrated rather than remembered.
		const beforeReattach = (await cli.output()).length;
		cli.send(ENTER);
		await cli.waitForOutput(
			(output) =>
				output.slice(beforeReattach).includes(STEER_ROW) && output.slice(beforeReattach).includes(FOLLOW_UP_ROW),
			"the reattached stage chat to rehydrate its queued rows",
		);
		const final = await cli.output();
		return {
			graphBeforeQueue,
			whileAttached,
			whileDetached: final.slice(beforeDetach, beforeReattach),
			afterReattach: final.slice(beforeReattach),
		};
	} finally {
		await cli.stop();
		await model.stop();
		removeTempRootReleasingBroker(root);
	}
}

let evidence: Evidence;

describe("issue #2074 — stage steering and queued-message state through the real CLI", () => {
	beforeAll(async () => {
		evidence = await runScenario();
	}, REAL_CLI_STAGE_CHAT_SCENARIO_TIMEOUT_MS);

	test("the stage really is mid-turn, so the typed messages are queued rather than delivered", () => {
		assert.equal(evidence.whileAttached.includes(STAGE_TEXT), true);
		// The chat only shows the interrupt hint while the stage session streams.
		assert.equal(evidence.whileAttached.includes("esc to interrupt"), true);
	});

	test("Enter queues into the steering queue and ctrl+f into the follow-up queue", () => {
		assert.equal(evidence.whileAttached.includes(STEER_ROW), true);
		assert.equal(evidence.whileAttached.includes(FOLLOW_UP_ROW), true);
	});

	test("a node with nothing queued on it carries no badge", () => {
		assert.equal(evidence.graphBeforeQueue.includes(STAGE_NAME), true);
		assert.equal(evidence.graphBeforeQueue.includes("queued"), false);
	});

	test("the detached stage node badges the messages still queued on its session", () => {
		assert.equal(
			evidence.whileDetached.includes(QUEUED_BADGE),
			true,
			"the graph drawn after detaching never rendered a queued-count badge",
		);
	});

	test("reattaching rehydrates both pending queues from the live session", () => {
		assert.equal(
			evidence.afterReattach.includes(STEER_ROW),
			true,
			"the remounted stage chat never redrew the pending steering row",
		);
		assert.equal(
			evidence.afterReattach.includes(FOLLOW_UP_ROW),
			true,
			"the remounted stage chat never redrew the pending follow-up row",
		);
		assert.equal(evidence.afterReattach.includes("to edit all queued messages"), true);
	});
});

test("the drivers and the fixtures agree on the scenario's identifiers", () => {
	const workflowSource = readFileSync(join(fixturesDir, WORKFLOW_FIXTURE), "utf8");
	assert.match(workflowSource, new RegExp(`name: "${WORKFLOW_NAME}"`));
	assert.match(workflowSource, new RegExp(`ctx\\.stage\\("${STAGE_NAME}"\\)`));
	const serverSource = readFileSync(join(fixturesDir, MODEL_SERVER_FIXTURE), "utf8");
	assert.match(serverSource, new RegExp(`ISSUE_2074_STAGE_TEXT = "${STAGE_TEXT}"`));
	assert.match(serverSource, new RegExp(`ISSUE_2074_PORT_FILE = "${PORT_FILE}"`));
});
