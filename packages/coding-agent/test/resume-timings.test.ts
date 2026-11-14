import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, test, vi } from "vitest";
import {
	formatResumeTimings,
	latestResumeTimings,
	noteRestoreFetch,
	RESUME_TIMINGS_TYPE,
	type ResumeTimings,
	ResumeTimingsRecorder,
	recordBlueprintStep,
	recordResumeTimings,
	timeCheckoutRestore,
	timeRestorePhase,
} from "../src/core/resume/timings.js";
import { SessionManager } from "../src/core/session-manager.js";

const PHASE_SLEEP_MS = 15;

describe("resume timings recorder (#4748)", () => {
	test("records each restored checkout's phases, fetch mode and mode, with the phase sum within its wall time (#4748)", async () => {
		const recorder = new ResumeTimingsRecorder();
		await recorder.run(async () => {
			await timeCheckoutRestore(
				"/repo",
				async () => {
					await timeRestorePhase("fetch", () => sleep(PHASE_SLEEP_MS));
					noteRestoreFetch("bundle");
					await timeRestorePhase("materialize", () => sleep(PHASE_SLEEP_MS));
					// A phase that runs twice, as the fetch of an exact restore and then of its degraded fallback, adds up.
					await timeRestorePhase("fetch", () => sleep(PHASE_SLEEP_MS));
					return "degraded" as const;
				},
				(mode) => mode,
			);
		});
		assert.equal(recorder.recordedWork, true);
		const timings = recorder.finish();
		assert.equal(timings.blueprintReadyMs, null, "no blueprint step ran");
		assert.equal(timings.restores.length, 1);
		const [restore] = timings.restores;
		assert.equal(restore!.root, "/repo");
		assert.equal(restore!.mode, "degraded");
		assert.equal(restore!.fetch, "bundle");
		assert.deepEqual(Object.keys(restore!.phases).sort(), ["fetch", "materialize"]);
		assert.ok(restore!.phases.fetch! >= 2 * PHASE_SLEEP_MS - 2, `fetch ${restore!.phases.fetch}`);
		assert.ok(restore!.phases.materialize! >= PHASE_SLEEP_MS - 1);
		const sum = Object.values(restore!.phases).reduce((total, ms) => total + ms, 0);
		assert.ok(sum <= restore!.ms, `phases ${sum} ms within the restore's ${restore!.ms} ms`);
		assert.ok(timings.firstPromptReadyMs !== null && timings.firstPromptReadyMs >= restore!.ms);
	});

	test("a restore that restores nothing, or fails, is not recorded, and a failing phase still counts (#4748)", async () => {
		const recorder = new ResumeTimingsRecorder();
		await recorder.run(async () => {
			await timeCheckoutRestore(
				"/left-out",
				async () => "unrestored",
				() => undefined,
			);
			await assert.rejects(
				timeCheckoutRestore(
					"/failed",
					() => timeRestorePhase("fetch", () => Promise.reject(new Error("offline"))),
					() => "fresh" as const,
				),
				/offline/,
			);
		});
		assert.deepEqual(recorder.finish().restores, []);
		assert.equal(recorder.recordedWork, false);
	});

	test("a restore whose commit was already here records no fetch and no phase it did not run (#4748)", async () => {
		const recorder = new ResumeTimingsRecorder();
		await recorder.run(() =>
			timeCheckoutRestore(
				"/in-store",
				async () => "here",
				() => "fresh",
			),
		);
		assert.deepEqual(
			recorder.finish().restores.map(({ root, mode, fetch, phases }) => ({ root, mode, fetch, phases })),
			[{ root: "/in-store", mode: "fresh", fetch: "none", phases: {} }],
		);
	});

	test("outside a timed resume the helpers only run what they wrap (#4748)", async () => {
		assert.equal(await timeRestorePhase("verify", async () => 7), 7);
		noteRestoreFetch("full");
		recordBlueprintStep({ section: "maintenance", name: "npm install", ms: 5, exit: "ok" });
		assert.equal(
			await timeCheckoutRestore(
				"/repo",
				async () => "x",
				() => "fresh",
			),
			"x",
		);
	});

	test("records blueprint steps in order and when the last one finished (#4748)", async () => {
		const recorder = new ResumeTimingsRecorder();
		await recorder.run(async () => {
			recordBlueprintStep({ section: "initialize", name: "npm install", ms: 8600, exit: "ok" });
			recordBlueprintStep({ section: "maintenance", name: "Build", ms: 33300, exit: "failed" });
		});
		await sleep(PHASE_SLEEP_MS);
		const timings = recorder.finish();
		assert.equal(recorder.recordedWork, true);
		assert.deepEqual(
			timings.blueprint.map((step) => step.name),
			["npm install", "Build"],
		);
		assert.ok(timings.blueprintReadyMs !== null && timings.blueprintReadyMs < timings.firstPromptReadyMs!);
		assert.equal(timings.version, 1);
		assert.ok(!Number.isNaN(Date.parse(timings.startedAt)));
	});

	test("an origin at process launch counts the time before the recorder was made (#4748)", async () => {
		await sleep(PHASE_SLEEP_MS);
		const fromLaunch = new ResumeTimingsRecorder(0).finish();
		const fromNow = new ResumeTimingsRecorder().finish();
		assert.ok(fromLaunch.firstPromptReadyMs! > fromNow.firstPromptReadyMs!);
		assert.equal(fromLaunch.startedAt, new Date(performance.timeOrigin).toISOString());
		const later = new ResumeTimingsRecorder(60_000).finish();
		assert.equal(later.startedAt, new Date(performance.timeOrigin + 60_000).toISOString());
	});
});

const sample: ResumeTimings = {
	version: 1,
	startedAt: "2026-11-14T10:00:00.000Z",
	restores: [
		{
			root: "/repo",
			mode: "fresh",
			fetch: "full",
			ms: 18_520,
			phases: { verify: 210, fetch: 9_900, lfs: 6_000, materialize: 1_400 },
		},
		{
			root: "/docs",
			mode: "degraded",
			fetch: "none",
			ms: 640,
			phases: { seed: 120, publish: 70, verify: 30, materialize: 400, reconstruct: 100, fetch: 0 },
		},
		{ root: "/empty", mode: "claimed", fetch: "full", ms: 90, phases: {} },
	],
	blueprint: [
		{ section: "initialize", name: "npm install", ms: 8_600, exit: "ok" },
		{ section: "maintenance", name: "Build", ms: 33_300, exit: "failed" },
	],
	firstPromptReadyMs: 62_800,
	blueprintReadyMs: 62_700,
};

const sampleLines = [
	"restored /repo in 18.5 s (fetch 9.9 full, materialize 1.4, LFS 6.0, verify 0.2)",
	"restored /docs (degraded) in 0.6 s (fetch 0.0, reconstruct 0.1, materialize 0.4, verify 0.0, publish 0.1, seed 0.1)",
	"restored /empty (claimed) in 0.1 s",
	"blueprint 41.9 s (npm install 8.6, Build 33.3 failed)",
	"ready after 62.8 s",
];

describe("resume timings formatting (#4748)", () => {
	test("one line per restore with its phases in restore order, the blueprint steps, and when it was ready (#4748)", () => {
		assert.deepEqual(formatResumeTimings(sample), sampleLines);
	});

	test("a resume that restored nothing and built nothing says only when it was ready (#4748)", () => {
		assert.deepEqual(
			formatResumeTimings({
				...sample,
				restores: [],
				blueprint: [],
				firstPromptReadyMs: null,
				blueprintReadyMs: null,
			}),
			[],
		);
		assert.deepEqual(formatResumeTimings({ ...sample, restores: [], blueprint: [] }), ["ready after 62.8 s"]);
	});
});

describe("resume timings entry (#4748)", () => {
	test("is recorded as a resume_timings custom entry that the latest one is read back from (#4748)", async () => {
		const session = SessionManager.inMemory("/repo");
		await recordResumeTimings(session, { ...sample, firstPromptReadyMs: 1 });
		await recordResumeTimings(session, sample);
		const entries = session.getBranch().filter((entry) => entry.type === "custom");
		assert.equal(entries.length, 2);
		assert.equal(RESUME_TIMINGS_TYPE, "resume_timings");
		assert.equal(entries[0]!.type === "custom" && entries[0]!.customType, "resume_timings");
		assert.deepEqual(latestResumeTimings(session), sample);
		// Later entries of other kinds do not hide it.
		await session.appendCustomEntry("my-extension", { version: 1, restores: [], blueprint: [] });
		await session.appendCustomMessageEntry(RESUME_TIMINGS_TYPE, "not timings", false);
		assert.deepEqual(latestResumeTimings(session), sample);
	});

	test("the only entry of a session is read too (#4748)", async () => {
		const session = SessionManager.inMemory("/repo");
		await recordResumeTimings(session, sample);
		assert.equal(session.getBranch().length, 1);
		assert.deepEqual(latestResumeTimings(session), sample);
	});

	test("a session without one, or whose latest one is of another version or shape, has none (#4748)", async () => {
		const session = SessionManager.inMemory("/repo");
		assert.equal(latestResumeTimings(session), undefined);
		for (const data of [
			{ version: 2, restores: [], blueprint: [] },
			{ version: 1, restores: [] },
			{ version: 1, blueprint: [] },
			{ ...sample, restores: [{}] },
			{ ...sample, restores: [{ ...sample.restores[0], phases: null }] },
			{ ...sample, restores: [{ ...sample.restores[0], phases: { fetch: "slow" } }] },
			{ ...sample, restores: [{ ...sample.restores[0], ms: "1" }] },
			{ ...sample, blueprint: [{ section: "maintenance", ms: 1 }] },
			{ ...sample, blueprint: [{ ...sample.blueprint[0], ms: null }] },
			{ ...sample, firstPromptReadyMs: "1" },
			{ ...sample, firstPromptReadyMs: undefined },
			undefined,
		]) {
			await recordResumeTimings(session, sample);
			await session.appendCustomEntry(RESUME_TIMINGS_TYPE, data);
			assert.equal(latestResumeTimings(session), undefined, JSON.stringify(data));
		}
	});

	test("a failure to write the entry is ignored (#4748)", async () => {
		let attempts = 0;
		const failing = {
			appendCustomEntry: (): Promise<string> => {
				attempts++;
				return Promise.reject(new Error("disk full"));
			},
		};
		await recordResumeTimings(failing, sample);
		assert.equal(attempts, 1);
	});
});

describe("ATOMIC_TIMING output (#4748)", () => {
	test("prints a resume's lines as they are, in their own group after the startup timings (#4748)", async () => {
		vi.stubEnv("ATOMIC_TIMING", "1");
		vi.resetModules();
		const errors: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
			errors.push(line);
		});
		try {
			const timing = await import("../src/core/timings.js");
			timing.resetTimings("main");
			timing.recordTiming("load", 12, "main");
			timing.recordTimingLines([], "extensions");
			timing.recordTimingLines(formatResumeTimings(sample), "resume");
			timing.printTimings();
		} finally {
			spy.mockRestore();
			vi.unstubAllEnvs();
		}
		assert.deepEqual(errors.slice(0, 2), ["\n--- Startup Timings: main ---", "  load: 12ms"]);
		assert.match(errors[2]!, /^ {2}TOTAL initialization time: \d{1,5}ms$/);
		assert.deepEqual(errors.slice(3), [
			`${"-".repeat("Startup Timings: main".length + 8)}\n`,
			"\n--- Startup Timings: resume ---",
			...sampleLines.map((line) => `  ${line}`),
			`${"-".repeat("Startup Timings: resume".length + 8)}\n`,
		]);
	});
});
