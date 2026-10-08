import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { test, vi } from "vitest";
import { APP_NAME } from "../src/config.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { claimPaneReporting, releasePaneReporting, reportPaneActivity } from "../src/extensions/herdr/pane-owner.js";
import type { HerdrDiagnostic } from "../src/extensions/herdr/transport.js";
import { arg, FAKE_HERDR_CHILD_TIMEOUT_MS, fakeHerdr } from "./helpers/herdr.js";

type FakeHerdr = Awaited<ReturnType<typeof fakeHerdr>>;

const REJECT_TRAILING_ARGV = 'if (args.includes("--")) finish(2); else finish();';
const ORDINAL = `
const ordinal = fs.readdirSync(args[2]).filter((name) => name.startsWith("call-")).length;
fs.writeFileSync(require("node:path").join(args[2], "call-" + ordinal), "");`;
const REJECT_FIRST_TWO = `${ORDINAL}\nif (ordinal < 2) finish(2); else finish();`;
const HANG_FIRST = `${ORDINAL}\nif (ordinal < 1) setInterval(() => {}, 1000); else finish();`;

function resumeOf(args: string[]): string[] | undefined {
	const separator = args.indexOf("--");
	return separator < 0 ? undefined : args.slice(separator + 1);
}

async function startReporter(
	fake: FakeHerdr,
	session: SessionManager,
	diagnostics?: HerdrDiagnostic[],
	timeoutMs = FAKE_HERDR_CHILD_TIMEOUT_MS,
) {
	const runtime = createExtensionRuntime();
	runtime.workflowActivityHub
		.registerWorkflowActivityPublisher()
		.publishSnapshot({ availability: "ready", roots: [] });
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({
			env: fake.env,
			enabled: () => true,
			timeoutMs,
			diagnostic: (value) => diagnostics?.push(value),
		}),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const runner = new ExtensionRunner([extension], runtime, fake.dir, session, {} as never);
	runner.setUIContext({ ...noOpUIContext }, "tui");
	return runner;
}

async function startedCalls(fake: FakeHerdr) {
	return (await fake.calls()).filter((call) => call.phase === "start");
}

test("first Herdr report carries the exact session's resume argv after -- (#3492)", async () => {
	const fake = await fakeHerdr();
	const session = SessionManager.create(fake.dir, fake.dir);
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		await runner.emit({ type: "agent_start" });
		await fake.waitFor(2);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		const calls = await startedCalls(fake);
		assert.deepEqual(resumeOf(calls[0].args), [
			APP_NAME,
			"--session-dir",
			session.getSessionDir(),
			"--session",
			session.getSessionId(),
		]);
		assert.equal(arg(calls[0].args, "--agent-session-id"), session.getSessionId());
		assert.equal(arg(calls[0].args, "--agent-session-path"), session.getSessionFile());
		assert.equal(arg(calls[0].args, "--state"), "idle");
		assert.equal(resumeOf(calls[1].args), undefined, "later state reports keep the registered resume command");
		assert.equal(calls.at(-1)?.args[1], "release-agent");
		assert.equal(resumeOf(calls.at(-1)!.args), undefined);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

test("resume argv omits --session-dir for the default session directory (#3492)", async () => {
	const fake = await fakeHerdr();
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", fake.dir);
	const session = SessionManager.create(fake.dir);
	assert.equal(session.usesDefaultSessionDir(), true);
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		const [first] = await fake.waitFor(1);
		assert.deepEqual(resumeOf(first.args), [APP_NAME, "--session", session.getSessionId()]);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		vi.unstubAllEnvs();
		await fake.dispose();
	}
});

test("a session ID that --session would read as a file path resumes by its session file (#3492)", async () => {
	const fake = await fakeHerdr();
	const session = SessionManager.create(fake.dir, fake.dir, { id: "notes.jsonl" });
	assert.equal(session.getSessionId(), "notes.jsonl");
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		const [first] = await fake.waitFor(1);
		const sessionFile = session.getSessionFile();
		assert.ok(sessionFile !== undefined && isAbsolute(sessionFile));
		assert.deepEqual(resumeOf(first.args), [APP_NAME, "--session", sessionFile]);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

test("a session switch reports the new session's resume argv (#3492)", async () => {
	const fake = await fakeHerdr();
	const sessions = [SessionManager.create(fake.dir, fake.dir), SessionManager.create(fake.dir, fake.dir)];
	const runners = [await startReporter(fake, sessions[0]), await startReporter(fake, sessions[1])];
	try {
		await runners[0].emit({ type: "session_start" });
		await fake.waitFor(1);
		await runners[0].emit({ type: "session_shutdown", reason: "new" });
		await runners[1].emit({ type: "session_start", reason: "new" });
		await fake.waitFor(2);
		const calls = await startedCalls(fake);
		for (const [index, session] of sessions.entries())
			assert.deepEqual(resumeOf(calls[index].args)?.slice(-2), ["--session", session.getSessionId()]);
		assert.notEqual(sessions[0].getSessionId(), sessions[1].getSessionId());
	} finally {
		for (const runner of runners) {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			runner.invalidate();
		}
		await fake.dispose();
	}
});

test("non-persisted sessions still report state and identity without a resume argv (#3492)", async () => {
	const fake = await fakeHerdr();
	const session = SessionManager.inMemory();
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		const [first] = await fake.waitFor(1);
		assert.equal(arg(first.args, "--state"), "idle");
		assert.equal(arg(first.args, "--agent-session-id"), session.getSessionId());
		assert.equal(first.args.includes("--"), false);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

test("a session directory Herdr cannot accept in a resume argv is reported without one (#3492)", async () => {
	const fake = await fakeHerdr();
	const session = SessionManager.create(fake.dir, join(fake.dir, "o'brien sessions"));
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		const [first] = await fake.waitFor(1);
		assert.equal(arg(first.args, "--state"), "idle");
		assert.equal(arg(first.args, "--agent-session-id"), session.getSessionId());
		assert.equal(first.args.includes("--"), false);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

const violations: Record<string, string[]> = {
	"an apostrophe": [APP_NAME, "--session", "it's"],
	"a control character": [APP_NAME, "--session", "line\nbreak"],
	"a path as the command": ["/usr/local/bin/atomic", "--session", "id"],
	"more than 64 arguments": [APP_NAME, ...Array.from({ length: 64 }, (_, index) => `arg-${index}`)],
	"more than 8 KiB": [APP_NAME, "--session", "x".repeat(8 * 1024)],
};
for (const [label, resume] of Object.entries(violations)) {
	test(`a resume argv with ${label} is dropped while state is still reported (#3492)`, async () => {
		const fake = await fakeHerdr();
		const owner = await claimPaneReporting(
			fake.environment,
			{ id: "violating", resume },
			{ timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS },
		);
		try {
			reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
			const [first] = await fake.waitFor(1);
			assert.equal(arg(first.args, "--state"), "idle");
			assert.equal(arg(first.args, "--agent-session-id"), "violating");
			assert.equal(first.args.includes("--"), false);
		} finally {
			await releasePaneReporting(owner);
			await fake.dispose();
		}
	});
}

test("a resume argv at Herdr's limits is still sent (#3492)", async () => {
	const fake = await fakeHerdr();
	const resume = [APP_NAME, ...Array.from({ length: 63 }, (_, index) => `arg-${index}`)];
	const owner = await claimPaneReporting(
		fake.environment,
		{ id: "at-limit", resume },
		{ timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS },
	);
	try {
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		const [first] = await fake.waitFor(1);
		assert.deepEqual(resumeOf(first.args), resume);
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

test("a Herdr that rejects the trailing argv gets the same report without it and keeps omitting it (#3492)", async () => {
	const fake = await fakeHerdr(REJECT_TRAILING_ARGV);
	const diagnostics: HerdrDiagnostic[] = [];
	const session = SessionManager.create(fake.dir, fake.dir);
	const runner = await startReporter(fake, session, diagnostics);
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(2);
		await runner.emit({ type: "agent_start" });
		await fake.waitFor(3);
		await runner.emit({ type: "agent_settled" });
		await fake.waitFor(4);
		const calls = await startedCalls(fake);
		assert.deepEqual(
			calls.map((call) => call.args.includes("--")),
			[true, false, false, false],
			"only the first attempt carries the argv",
		);
		const [rejected, retried] = calls;
		assert.equal(arg(retried.args, "--state"), arg(rejected.args, "--state"));
		assert.equal(arg(retried.args, "--agent-session-id"), session.getSessionId());
		assert.equal(arg(retried.args, "--agent-session-path"), session.getSessionFile());
		assert.ok(Number(arg(retried.args, "--seq")) > Number(arg(rejected.args, "--seq")), "retry takes a fresh seq");
		assert.equal(calls.filter((call) => call.args.includes("--agent-session-id")).length, 2);
		assert.deepEqual(diagnostics, [], "an older Herdr accepting the retried report is not a failure");
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

test("an older Herdr's rejection is remembered for the next session in the pane (#3492)", async () => {
	const fake = await fakeHerdr(REJECT_TRAILING_ARGV);
	const sessions = [SessionManager.create(fake.dir, fake.dir), SessionManager.create(fake.dir, fake.dir)];
	const runners = [await startReporter(fake, sessions[0]), await startReporter(fake, sessions[1])];
	try {
		await runners[0].emit({ type: "session_start" });
		await fake.waitFor(2);
		await runners[0].emit({ type: "session_shutdown", reason: "new" });
		await runners[1].emit({ type: "session_start", reason: "new" });
		await fake.waitFor(3);
		const calls = await startedCalls(fake);
		assert.deepEqual(
			calls.map((call) => call.args.includes("--")),
			[true, false, false],
		);
		assert.equal(arg(calls[2].args, "--agent-session-id"), sessions[1].getSessionId());
	} finally {
		for (const runner of runners) {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			runner.invalidate();
		}
		await fake.dispose();
	}
});

const HANG_TIMEOUT_MS = 1500;
for (const [failure, body, failedCalls, timeoutMs] of [
	["rejected", REJECT_FIRST_TWO, 2, FAKE_HERDR_CHILD_TIMEOUT_MS],
	["timed-out", HANG_FIRST, 1, HANG_TIMEOUT_MS],
] as const) {
	test(`a ${failure} first report retries the resume argv with the identity on the next report (#3492)`, async () => {
		const fake = await fakeHerdr(body);
		const session = SessionManager.create(fake.dir, fake.dir);
		const runner = await startReporter(fake, session, [], timeoutMs);
		try {
			await runner.emit({ type: "session_start" });
			await runner.emit({ type: "agent_start" });
			await fake.waitFor(failedCalls === 2 ? 3 : 1);
			await runner.emit({ type: "agent_settled" });
			await fake.waitFor(failedCalls === 2 ? 4 : 2);
			const calls = await startedCalls(fake);
			const delivered = calls.at(failedCalls === 2 ? 2 : 1)!;
			const after = calls.at(-1)!;
			assert.deepEqual(resumeOf(delivered.args)?.slice(-2), ["--session", session.getSessionId()]);
			assert.equal(arg(delivered.args, "--agent-session-id"), session.getSessionId());
			assert.equal(after.args.includes("--"), false);
			assert.equal(after.args.includes("--agent-session-id"), false);
			assert.equal(arg(after.args, "--state"), "idle");
		} finally {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			runner.invalidate();
			await fake.dispose();
		}
	});
}

test("host-signal shutdown retires the reporter without releasing the pane's resume registration (#3492)", async () => {
	const fake = await fakeHerdr();
	const session = SessionManager.create(fake.dir, fake.dir);
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		await runner.emit({ type: "agent_start" });
		await fake.waitFor(2);
		await runner.emit({ type: "session_shutdown", reason: "quit", fromSignal: true });
		await runner.emit({ type: "agent_start" });
		const calls = await startedCalls(fake);
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "report-agent"],
		);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

test("an explicit quit still releases the pane's registration and resume command (#3492)", async () => {
	const fake = await fakeHerdr();
	const session = SessionManager.create(fake.dir, fake.dir);
	const runner = await startReporter(fake, session);
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		const calls = await startedCalls(fake);
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "release-agent"],
		);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});
