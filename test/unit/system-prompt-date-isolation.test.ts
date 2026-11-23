import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, test, vi } from "vitest";
import {
	buildSystemPromptSections,
	diffSystemPromptSections,
} from "../../packages/coding-agent/src/core/system-prompt.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { bunExecutable, readStreamText, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import {
	installMiddayTimezoneIsolation,
	middayOffsetHours,
	middayTimezone,
	withTestTimezone,
} from "../helpers/system-prompt-date-isolation.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.useRealTimers();
	while (cleanups.length > 0) cleanups.pop()?.();
});

function localCalendarDate(date: Date): string {
	return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

describe("midday IANA Etc/GMT timezone selection", () => {
	test("places every UTC hour and minute into local [11:30, 12:29] and stays on the same local day for >11h", () => {
		const hadTz = Object.hasOwn(process.env, "TZ");
		const savedTz = process.env.TZ;
		cleanups.push(() => {
			if (hadTz) process.env.TZ = savedTz;
			else delete process.env.TZ;
		});

		for (let utcHour = 0; utcHour < 24; utcHour++) {
			for (const utcMinute of [0, 29, 30, 59]) {
				const start = new Date(Date.UTC(2026, 10, 22, utcHour, utcMinute, 30));
				const offset = middayOffsetHours(start);
				assert.ok(offset >= -12 && offset <= 12, `offset out of Etc/GMT range: ${offset}`);

				const zone = middayTimezone(start);
				assert.match(zone, /^Etc\/GMT(?:[+-](?:1[0-2]|[1-9]))?$/u, `unexpected zone ${zone}`);

				process.env.TZ = zone;
				assert.equal(start.getTimezoneOffset(), offset === 0 ? 0 : -offset * 60, `Node must honor ${zone}`);
				const localMinutes = start.getHours() * 60 + start.getMinutes();
				assert.ok(
					localMinutes >= 11 * 60 + 30 && localMinutes <= 12 * 60 + 29,
					`${zone} at ${start.toISOString()} gave local ${start.getHours()}:${start.getMinutes()}`,
				);

				const elevenHoursLater = new Date(start.getTime() + 11 * 60 * 60 * 1000);
				assert.equal(
					localCalendarDate(elevenHoursLater),
					localCalendarDate(start),
					`${zone} crossed local midnight within 11h from ${start.toISOString()}`,
				);
			}
		}
	});
});

describe("shared test setup timezone isolation", () => {
	test("sets process.env.TZ to a midday Etc/GMT zone without skewing Date.now()", () => {
		const tz = process.env.TZ ?? "";
		assert.match(tz, /^Etc\/GMT(?:[+-](?:1[0-2]|[1-9]))?$/u, `expected midday Etc/GMT TZ, got ${tz}`);
		const now = new Date();
		const minutesToMidnight = 24 * 60 - (now.getHours() * 60 + now.getMinutes());
		assert.ok(
			minutesToMidnight >= 10 * 60,
			`expected >=10h to local midnight under ${tz}, got ${minutesToMidnight}m`,
		);
		const wallDiffMs = Math.abs(Date.now() - (performance.timeOrigin + performance.now()));
		assert.ok(wallDiffMs < 60_000, `Date.now() must remain on the real UTC epoch (skew=${wallDiffMs}ms)`);
	});

	test("prevents <date> prompt updates across 00:00:00 UTC while preserving live rollover under UTC (#6092)", () => {
		const hadTz = Object.hasOwn(process.env, "TZ");
		const savedTz = process.env.TZ;
		cleanups.push(() => {
			if (hadTz) process.env.TZ = savedTz;
			else delete process.env.TZ;
		});

		const beforeUtcMidnight = new Date("2026-11-22T23:59:59Z");
		const afterUtcMidnight = new Date("2026-11-23T00:00:01Z");

		// Under UTC (as on CI runners without midday TZ), crossing 00:00:00 UTC emits a <date> section update.
		process.env.TZ = "UTC";
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(beforeUtcMidnight);
		const utcBefore = buildSystemPromptSections({ cwd: "/project" });
		vi.setSystemTime(afterUtcMidnight);
		const utcAfter = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(utcBefore.date, "<date>\nCurrent date: 2026-11-22\n</date>");
		assert.deepEqual(diffSystemPromptSections(utcBefore, utcAfter), {
			date: "<date>\nCurrent date: 2026-11-23\n</date>",
		});

		// Under midday TZ chosen at 23:59:59Z (Etc/GMT+12), crossing 00:00:00 UTC moves 11:59:59 -> 12:00:01 (same day).
		const handle = installMiddayTimezoneIsolation(undefined, { now: beforeUtcMidnight });
		cleanups.push(() => handle.restore());
		assert.equal(handle.timezone, "Etc/GMT+12");

		vi.setSystemTime(beforeUtcMidnight);
		const middayBefore = buildSystemPromptSections({ cwd: "/project" });
		vi.setSystemTime(afterUtcMidnight);
		const middayAfter = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(middayBefore.date, "<date>\nCurrent date: 2026-11-22\n</date>");
		assert.equal(middayAfter.date, "<date>\nCurrent date: 2026-11-22\n</date>");
		assert.equal(diffSystemPromptSections(middayBefore, middayAfter), undefined);
	});

	test("preserves explicit fake Date multi-day transitions (vi.setSystemTime across local days)", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-20T12:00:00"));
		const dayOne = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(dayOne.date, "<date>\nCurrent date: 2026-11-20\n</date>");

		vi.setSystemTime(new Date("2026-11-21T12:00:00"));
		const dayTwo = buildSystemPromptSections({ cwd: "/project" });
		assert.equal(dayTwo.date, "<date>\nCurrent date: 2026-11-21\n</date>");
		assert.deepEqual(diffSystemPromptSections(dayOne, dayTwo), {
			date: "<date>\nCurrent date: 2026-11-21\n</date>",
		});
	});

	test("restores the worker's midday TZ in beforeEach after a test changes or deletes TZ", () => {
		const env: NodeJS.ProcessEnv = {};
		const beforeEachHooks: Array<() => void> = [];
		const handle = installMiddayTimezoneIsolation(
			{ beforeEach: (fn) => beforeEachHooks.push(fn) },
			{ now: new Date("2026-11-22T23:59:59Z"), env },
		);
		cleanups.push(() => handle.restore());

		assert.equal(handle.timezone, "Etc/GMT+12");
		assert.equal(env.TZ, "Etc/GMT+12");

		env.TZ = "UTC";
		for (const hook of beforeEachHooks) hook();
		assert.equal(env.TZ, "Etc/GMT+12");

		delete env.TZ;
		for (const hook of beforeEachHooks) hook();
		assert.equal(env.TZ, "Etc/GMT+12");
	});
});

describe("child-process timezone forwarding", () => {
	test("withTestTimezone forwards TZ unless the caller explicitly sets or clears TZ", () => {
		const source: NodeJS.ProcessEnv = { TZ: "Etc/GMT+12" };
		assert.deepEqual(withTestTimezone({ PATH: "/bin" }, source), { PATH: "/bin", TZ: "Etc/GMT+12" });
		assert.deepEqual(withTestTimezone({ PATH: "/bin", TZ: "UTC" }, source), { PATH: "/bin", TZ: "UTC" });
		assert.deepEqual(withTestTimezone({ PATH: "/bin", TZ: "America/New_York" }, source), {
			PATH: "/bin",
			TZ: "America/New_York",
		});
		assert.deepEqual(withTestTimezone({ PATH: "/bin", TZ: undefined }, source), { PATH: "/bin", TZ: undefined });
		assert.deepEqual(withTestTimezone({ PATH: "/bin" }, {}), { PATH: "/bin" });
	});

	test("Node and Bun children spawned via spawnSyncCollect and spawnProcess honor forwarded TZ across 00:00:00 UTC", async () => {
		const hadTz = Object.hasOwn(process.env, "TZ");
		const savedTz = process.env.TZ;
		process.env.TZ = "Etc/GMT+12";
		cleanups.push(() => {
			if (hadTz) process.env.TZ = savedTz;
			else delete process.env.TZ;
		});

		const probe = [
			'const fmt = (iso) => { const d = new Date(iso); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); };',
			'process.stdout.write(JSON.stringify([process.env.TZ ?? "", fmt("2026-11-22T23:59:59Z"), fmt("2026-11-23T00:00:01Z")]));',
		].join(" ");
		const minimalEnv = {
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			PATH: process.env.PATH ?? "",
		};

		for (const executable of [process.execPath, bunExecutable()]) {
			const forwarded = spawnSyncCollect([executable, "-e", probe], { env: minimalEnv });
			assert.equal(forwarded.exitCode, 0, forwarded.stderr.toString());
			assert.deepEqual(JSON.parse(forwarded.stdout.toString()), ["Etc/GMT+12", "2026-11-22", "2026-11-22"]);

			const explicitUtc = spawnSyncCollect([executable, "-e", probe], { env: { ...minimalEnv, TZ: "UTC" } });
			assert.equal(explicitUtc.exitCode, 0, explicitUtc.stderr.toString());
			assert.deepEqual(JSON.parse(explicitUtc.stdout.toString()), ["UTC", "2026-11-22", "2026-11-23"]);
		}

		const asyncChild = spawnProcess([process.execPath, "-e", probe], {
			env: minimalEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			asyncChild.exited,
			readStreamText(asyncChild.stdout),
			readStreamText(asyncChild.stderr),
		]);
		assert.equal(exitCode, 0, stderr);
		assert.deepEqual(JSON.parse(stdout), ["Etc/GMT+12", "2026-11-22", "2026-11-22"]);
	});

	test("startPtyProgram forwards TZ and respects explicit TZ opt-out", async () => {
		const hadTz = Object.hasOwn(process.env, "TZ");
		const savedTz = process.env.TZ;
		process.env.TZ = "Etc/GMT+12";
		cleanups.push(() => {
			if (hadTz) process.env.TZ = savedTz;
			else delete process.env.TZ;
		});

		const baseEnv: Record<string, string> = {
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			PATH: process.env.PATH ?? "",
		};
		const probe = [
			'const fmt = (iso) => { const d = new Date(iso); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); };',
			'process.stdout.write("RES=" + [process.env.TZ, fmt("2026-11-22T23:59:59Z"), fmt("2026-11-23T00:00:01Z")].join("|") + "\\n");',
		].join(" ");

		const forwarded = startPtyProgram({
			executable: process.execPath,
			args: ["-e", probe],
			cwd: process.cwd(),
			env: baseEnv,
			timeoutMs: 15_000,
			cols: 120,
			rows: 24,
		});
		try {
			const exit = await forwarded.exited;
			assert.equal(exit.timedOut, false);
			assert.equal(exit.exitCode, 0);
			assert.ok(
				stripVTControlCharacters(forwarded.output()).includes("RES=Etc/GMT+12|2026-11-22|2026-11-22"),
				forwarded.output(),
			);
		} finally {
			forwarded.kill();
		}

		const explicitUtc = startPtyProgram({
			executable: process.execPath,
			args: ["-e", probe],
			cwd: process.cwd(),
			env: { ...baseEnv, TZ: "UTC" },
			timeoutMs: 15_000,
			cols: 120,
			rows: 24,
		});
		try {
			const exit = await explicitUtc.exited;
			assert.equal(exit.timedOut, false);
			assert.equal(exit.exitCode, 0);
			assert.ok(
				stripVTControlCharacters(explicitUtc.output()).includes("RES=UTC|2026-11-22|2026-11-23"),
				explicitUtc.output(),
			);
		} finally {
			explicitUtc.kill();
		}
	});
});
