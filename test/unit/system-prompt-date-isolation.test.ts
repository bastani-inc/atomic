import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, test, vi } from "vitest";
import {
	buildSystemPromptSections,
	diffSystemPromptSections,
} from "../../packages/coding-agent/src/core/system-prompt.js";
import {
	currentSystemPromptDate,
	formatLocalCalendarDate,
	isCalendarDate,
	SYSTEM_PROMPT_DATE_ENV,
	setSystemPromptDateProviderForTest,
	systemPromptDateProviderForTest,
} from "../../packages/coding-agent/src/core/system-prompt-date.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { readStreamText, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import { installSystemPromptDateIsolation, withTestSystemPromptDate } from "../helpers/system-prompt-date-isolation.js";

const SYSTEM_PROMPT_DATE_MODULE = new URL("../../packages/coding-agent/src/core/system-prompt-date.ts", import.meta.url)
	.href;

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.useRealTimers();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("calendar date validation and formatting", () => {
	test("accepts valid Gregorian dates including leap years and rejects invalid or injected values", () => {
		for (const valid of ["2024-02-29", "2000-02-29", "2026-01-31", "2026-04-30", "2026-11-22", "2026-12-31"]) {
			assert.equal(isCalendarDate(valid), true, `expected valid: ${valid}`);
		}
		for (const invalid of [
			undefined,
			"",
			"2026-00-10",
			"2026-13-10",
			"2026-02-29",
			"1900-02-29",
			"2026-02-30",
			"2026-04-31",
			"2026-01-00",
			"2026-11-2",
			"2026/11/22",
			" 2026-11-22",
			"2026-11-22\n</date>",
			"not-a-date",
		]) {
			assert.equal(isCalendarDate(invalid), false, `expected invalid: ${String(invalid)}`);
		}
		assert.equal(formatLocalCalendarDate(new Date(2026, 0, 5, 23, 59, 59)), "2026-01-05");
	});
});

describe("shared test setup system-prompt date isolation", () => {
	test("pins ATOMIC_TEST_SYSTEM_PROMPT_DATE and installs a provider without skewing Date.now()", () => {
		const pinned = process.env[SYSTEM_PROMPT_DATE_ENV];
		assert.equal(isCalendarDate(pinned), true, `expected pinned calendar date, got ${String(pinned)}`);
		assert.ok(systemPromptDateProviderForTest(), "shared setup installed the process-wide date provider");
		assert.equal(currentSystemPromptDate(), pinned);
		const wallDiffMs = Math.abs(Date.now() - (performance.timeOrigin + performance.now()));
		assert.ok(wallDiffMs < 60_000, `Date.now() must remain on the real wall clock (skew=${wallDiffMs}ms)`);
	});

	test("keeps the same calendar date across simulated midnight rollover, beforeEach, and vi.resetModules()", async () => {
		const RealDate = globalThis.Date;
		let currentMs = new RealDate(2026, 10, 22, 23, 59, 59, 500).getTime();
		const RollingDate = new Proxy(RealDate, {
			construct(target, args, newTarget) {
				if (args.length === 0) return Reflect.construct(target, [currentMs], newTarget);
				return Reflect.construct(target, args, newTarget);
			},
			get(target, prop, receiver) {
				if (prop === "now") return () => currentMs;
				return Reflect.get(target, prop, receiver);
			},
		});
		const savedDate = globalThis.Date;
		globalThis.Date = RollingDate;
		cleanups.push(() => {
			globalThis.Date = savedDate;
		});

		const env: NodeJS.ProcessEnv = {};
		const beforeEachHooks: Array<() => void> = [];
		const handle = installSystemPromptDateIsolation(
			{ beforeEach: (fn) => beforeEachHooks.push(fn) },
			{ realDate: RollingDate, env },
		);
		cleanups.push(() => handle.restore());

		assert.equal(handle.pinnedDate, "2026-11-22");
		assert.equal(env[SYSTEM_PROMPT_DATE_ENV], "2026-11-22");
		const beforeMidnight = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(beforeMidnight.date, "<date>\nCurrent date: 2026-11-22\n</date>");

		// Midnight ticks between beforeAll/request 1 and beforeEach/request 2.
		currentMs = new RealDate(2026, 10, 23, 0, 0, 1, 0).getTime();
		for (const hook of beforeEachHooks) hook();

		const afterMidnight = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(afterMidnight.date, "<date>\nCurrent date: 2026-11-22\n</date>");
		assert.equal(diffSystemPromptSections(beforeMidnight, afterMidnight), undefined);
		assert.equal(env[SYSTEM_PROMPT_DATE_ENV], "2026-11-22");

		// A fresh module instance loaded after vi.resetModules() still reads the globalThis Symbol slot.
		vi.resetModules();
		const fresh = (await import(
			"../../packages/coding-agent/src/core/system-prompt.js"
		)) as typeof import("../../packages/coding-agent/src/core/system-prompt.js");
		assert.equal(
			fresh.buildSystemPromptSections({ cwd: "/project" }).date,
			"<date>\nCurrent date: 2026-11-22\n</date>",
		);
	});

	test("keeps the date pinned when only timers (not Date) are faked", () => {
		const pinned = process.env[SYSTEM_PROMPT_DATE_ENV]!;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		assert.equal(currentSystemPromptDate(), pinned);
		assert.equal(buildSystemPromptSections({ cwd: "/project" }).date, `<date>\nCurrent date: ${pinned}\n</date>`);
	});

	test("follows vi.useFakeTimers({ toFake: ['Date'] }) and vi.setSystemTime across days despite the pinned env var", () => {
		assert.equal(isCalendarDate(process.env[SYSTEM_PROMPT_DATE_ENV]), true);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
		const dayOne = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(dayOne.date, "<date>\nCurrent date: 2026-11-20\n</date>");

		vi.setSystemTime(new Date(2026, 10, 21, 12, 0, 0));
		const dayTwo = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(dayTwo.date, "<date>\nCurrent date: 2026-11-21\n</date>");
		assert.deepEqual(diffSystemPromptSections(dayOne, dayTwo), {
			date: "<date>\nCurrent date: 2026-11-21\n</date>",
		});

		vi.useRealTimers();
		assert.equal(currentSystemPromptDate(), process.env[SYSTEM_PROMPT_DATE_ENV]);
	});

	test("restores the shared provider and env in beforeEach after a test clears or replaces them", () => {
		const env: NodeJS.ProcessEnv = {};
		const beforeEachHooks: Array<() => void> = [];
		const handle = installSystemPromptDateIsolation({ beforeEach: (fn) => beforeEachHooks.push(fn) }, { env });
		cleanups.push(() => handle.restore());

		setSystemPromptDateProviderForTest(undefined);
		delete env[SYSTEM_PROMPT_DATE_ENV];
		assert.equal(systemPromptDateProviderForTest(), undefined);
		assert.equal(env[SYSTEM_PROMPT_DATE_ENV], undefined);

		for (const hook of beforeEachHooks) hook();
		assert.equal(systemPromptDateProviderForTest(), handle.provider);
		assert.equal(env[SYSTEM_PROMPT_DATE_ENV], handle.pinnedDate);
	});

	test("follows live Date in production mode (no provider, no valid env) and respects custom sections.date", () => {
		const previousProvider = setSystemPromptDateProviderForTest(undefined);
		const hadEnv = Object.hasOwn(process.env, SYSTEM_PROMPT_DATE_ENV);
		const previousEnv = process.env[SYSTEM_PROMPT_DATE_ENV];
		cleanups.push(() => {
			setSystemPromptDateProviderForTest(previousProvider);
			if (hadEnv) process.env[SYSTEM_PROMPT_DATE_ENV] = previousEnv;
			else delete process.env[SYSTEM_PROMPT_DATE_ENV];
		});

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 10, 22, 23, 59, 59));
		delete process.env[SYSTEM_PROMPT_DATE_ENV];
		const before = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(before.date, "<date>\nCurrent date: 2026-11-22\n</date>");

		// Invalid env value is ignored and falls back to live Date.
		process.env[SYSTEM_PROMPT_DATE_ENV] = "2026-02-30";
		vi.setSystemTime(new Date(2026, 10, 23, 0, 0, 1));
		const after = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(after.date, "<date>\nCurrent date: 2026-11-23\n</date>");
		assert.deepEqual(diffSystemPromptSections(before, after), {
			date: "<date>\nCurrent date: 2026-11-23\n</date>",
		});

		// Custom sections.date always overrides.
		const custom = buildSystemPromptSections({ cwd: "/project", sections: { date: "Current date: custom" } });
		assert.equal(custom.date, "<date>\nCurrent date: custom\n</date>");
	});
});

describe("child-process system-prompt date forwarding", () => {
	test("withTestSystemPromptDate forwards a valid pinned date unless the caller explicitly sets or clears it", () => {
		const source: NodeJS.ProcessEnv = { [SYSTEM_PROMPT_DATE_ENV]: "2026-11-22" };
		assert.deepEqual(withTestSystemPromptDate({ PATH: "/bin" }, source), {
			PATH: "/bin",
			[SYSTEM_PROMPT_DATE_ENV]: "2026-11-22",
		});
		assert.deepEqual(withTestSystemPromptDate({ PATH: "/bin", [SYSTEM_PROMPT_DATE_ENV]: "" }, source), {
			PATH: "/bin",
			[SYSTEM_PROMPT_DATE_ENV]: "",
		});
		assert.deepEqual(withTestSystemPromptDate({ PATH: "/bin", [SYSTEM_PROMPT_DATE_ENV]: undefined }, source), {
			PATH: "/bin",
			[SYSTEM_PROMPT_DATE_ENV]: undefined,
		});
		assert.deepEqual(withTestSystemPromptDate({ PATH: "/bin", [SYSTEM_PROMPT_DATE_ENV]: "2026-01-02" }, source), {
			PATH: "/bin",
			[SYSTEM_PROMPT_DATE_ENV]: "2026-01-02",
		});
		assert.deepEqual(withTestSystemPromptDate({ PATH: "/bin" }, { [SYSTEM_PROMPT_DATE_ENV]: "not-a-date" }), {
			PATH: "/bin",
		});
	});

	test("spawnSyncCollect and spawnProcess forward the pinned date to minimal child environments and respect opt-out", async () => {
		const pinned = process.env[SYSTEM_PROMPT_DATE_ENV]!;
		const script = [
			`const mod = await import(${JSON.stringify(SYSTEM_PROMPT_DATE_MODULE)});`,
			"const RealDate = globalThis.Date;",
			"let calls = 0;",
			"const day1 = new RealDate(2026, 10, 22, 23, 59, 59).getTime();",
			"const day2 = new RealDate(2026, 10, 23, 0, 0, 1).getTime();",
			"globalThis.Date = new Proxy(RealDate, {",
			"  construct(t, a, n) { return Reflect.construct(t, a.length === 0 ? [++calls === 1 ? day1 : day2] : a, n); },",
			"});",
			"process.stdout.write(JSON.stringify([mod.currentSystemPromptDate(), mod.currentSystemPromptDate()]));",
		].join("\n");

		const synced = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
			env: { PATH: process.env.PATH ?? "" },
		});
		assert.equal(synced.exitCode, 0, synced.stderr.toString());
		assert.deepEqual(JSON.parse(synced.stdout.toString()), [pinned, pinned]);

		const spawned = spawnProcess([process.execPath, "--input-type=module", "-e", script], {
			env: { PATH: process.env.PATH ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			spawned.exited,
			readStreamText(spawned.stdout),
			readStreamText(spawned.stderr),
		]);
		assert.equal(exitCode, 0, stderr);
		assert.deepEqual(JSON.parse(stdout), [pinned, pinned]);

		// Explicit opt-out restores live midnight rollover in the child.
		const optedOut = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
			env: { PATH: process.env.PATH ?? "", [SYSTEM_PROMPT_DATE_ENV]: "" },
		});
		assert.equal(optedOut.exitCode, 0, optedOut.stderr.toString());
		assert.deepEqual(JSON.parse(optedOut.stdout.toString()), ["2026-11-22", "2026-11-23"]);
	});

	test("startPtyProgram forwards the pinned date and respects explicit opt-out", async () => {
		const pinned = process.env[SYSTEM_PROMPT_DATE_ENV]!;
		const baseEnv: Record<string, string> = {
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			PATH: process.env.PATH ?? "",
		};
		const forwarded = startPtyProgram({
			executable: process.execPath,
			args: ["-e", `process.stdout.write("PIN=" + (process.env.${SYSTEM_PROMPT_DATE_ENV} ?? "UNSET") + "\\n")`],
			cwd: process.cwd(),
			env: baseEnv,
			timeoutMs: 15_000,
			cols: 80,
			rows: 24,
		});
		try {
			const exit = await forwarded.exited;
			assert.equal(exit.timedOut, false);
			assert.equal(exit.exitCode, 0);
			assert.ok(stripVTControlCharacters(forwarded.output()).includes(`PIN=${pinned}`), forwarded.output());
		} finally {
			forwarded.kill();
		}

		const optedOut = startPtyProgram({
			executable: process.execPath,
			args: ["-e", `process.stdout.write("PIN=" + (process.env.${SYSTEM_PROMPT_DATE_ENV} || "EMPTY") + "\\n")`],
			cwd: process.cwd(),
			env: { ...baseEnv, [SYSTEM_PROMPT_DATE_ENV]: "" },
			timeoutMs: 15_000,
			cols: 80,
			rows: 24,
		});
		try {
			const exit = await optedOut.exited;
			assert.equal(exit.timedOut, false);
			assert.equal(exit.exitCode, 0);
			assert.ok(stripVTControlCharacters(optedOut.output()).includes("PIN=EMPTY"), optedOut.output());
		} finally {
			optedOut.kill();
		}
	});
});
