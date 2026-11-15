import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, readStreamText, type SpawnedProcess, spawnProcess } from "../../../test/helpers/runtime.js";
import { type BlueprintRepository, runBlueprintBuild, savedProjectTrust } from "../src/core/resume/index.ts";
import { getProjectTrustPath, ProjectTrustStore } from "../src/core/trust-manager.ts";

// Each multi-process case runs real Bun child processes that import the TypeScript source.
const CHILD_PROCESS_TEST_TIMEOUT_MS = 120_000;
// The writer waits up to five seconds for a held lock before it reports failure.
const HELD_LOCK_TEST_TIMEOUT_MS = 30_000;
const WRITER_PROCESSES = 8;
const DECISIONS_PER_WRITER = 100;
const BACKGROUND_WRITERS = 6;
const BLUEPRINT_BUILDS = 40;
const TRUST_MODULE = fileURLToPath(new URL("../src/core/trust-manager.ts", import.meta.url));

let sandbox: string;
let agentDir: string;
let trustPath: string;
const children: SpawnedProcess[] = [];

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-concurrency-")));
	agentDir = join(sandbox, "agent");
	mkdirSync(agentDir, { recursive: true });
	trustPath = join(agentDir, "trust.json");
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

function spawnBun(script: string): SpawnedProcess {
	const child = spawnProcess([bunExecutable(), "--eval", script], { stdout: "pipe", stderr: "pipe" });
	children.push(child);
	return child;
}

async function finish(child: SpawnedProcess): Promise<string> {
	const [stdout, stderr, exitCode] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	assert.equal(exitCode, 0, `child failed: ${stderr}`);
	return stdout;
}

/** Saves and reads back `count` decisions, one project each, counting every throw and every wrong read. */
function setAndGetScript(writer: number): string {
	return `
		import { ProjectTrustStore } from ${JSON.stringify(TRUST_MODULE)};
		const store = new ProjectTrustStore(${JSON.stringify(agentDir)});
		const errors = [];
		let mismatches = 0;
		for (let i = 0; i < ${DECISIONS_PER_WRITER}; i++) {
			const project = ${JSON.stringify(join(sandbox, "projects", `writer-${writer}`))} + "/project-" + i;
			const decision = i % 2 === 0;
			try {
				store.set(project, decision);
				if (store.get(project) !== decision) mismatches++;
			} catch (error) {
				errors.push(String(error?.code ?? error?.message ?? error));
			}
		}
		console.log(JSON.stringify({ errors, mismatches }));
	`;
}

/** Saves decisions for throwaway projects until `stopPath` exists. */
function backgroundWriterScript(writer: number, stopPath: string): string {
	return `
		import { existsSync } from "node:fs";
		import { ProjectTrustStore } from ${JSON.stringify(TRUST_MODULE)};
		const store = new ProjectTrustStore(${JSON.stringify(agentDir)});
		console.log("started");
		for (let i = 0; !existsSync(${JSON.stringify(stopPath)}); i++) {
			store.set(${JSON.stringify(join(sandbox, "noise", `writer-${writer}`))} + "/project-" + (i % 50), i % 2 === 0);
		}
	`;
}

async function waitForLine(child: SpawnedProcess, expected: string): Promise<void> {
	const reader = child.stdout!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes(expected)) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`child exited before printing ${expected}: ${text}`);
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

function captureWarnings(): { warnings: Error[]; stop: () => void } {
	const warnings: Error[] = [];
	const listener = (warning: Error) => warnings.push(warning);
	process.on("warning", listener);
	return { warnings, stop: () => process.off("warning", listener) };
}

async function waitForWarnings(): Promise<void> {
	// process.emitWarning delivers on the next tick.
	await new Promise((resolve) => setImmediate(resolve));
}

describe("trust store under concurrent sessions (#4952)", () => {
	it(
		"saves every decision and never throws when 8 processes each set and get 100 decisions (#4952)",
		async () => {
			const writers = Array.from({ length: WRITER_PROCESSES }, (_, writer) => spawnBun(setAndGetScript(writer)));
			const reports = (await Promise.all(writers.map(finish))).map(
				(stdout) => JSON.parse(stdout.trim()) as { errors: string[]; mismatches: number },
			);

			assert.deepEqual(
				reports.flatMap((report) => report.errors),
				[],
			);
			assert.equal(
				reports.reduce((sum, report) => sum + report.mismatches, 0),
				0,
			);
			const saved = JSON.parse(readFileSync(trustPath, "utf8")) as Record<string, boolean>;
			assert.equal(Object.keys(saved).length, WRITER_PROCESSES * DECISIONS_PER_WRITER);
			const store = new ProjectTrustStore(agentDir);
			for (let writer = 0; writer < WRITER_PROCESSES; writer++) {
				for (let i = 0; i < DECISIONS_PER_WRITER; i++) {
					assert.equal(store.get(join(sandbox, "projects", `writer-${writer}`, `project-${i}`)), i % 2 === 0);
				}
			}
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"completes every blueprint build while 6 processes save trust decisions (#4952)",
		async () => {
			const root = join(sandbox, "repos", "trusted");
			mkdirSync(join(root, ".atomic"), { recursive: true });
			writeFileSync(join(root, ".atomic", "blueprint.yaml"), "maintenance: echo built\n");
			new ProjectTrustStore(agentDir).set(root, true);
			const repository: BlueprintRepository = { root, identity: "https://example.test/trusted.git" };
			const stopPath = join(sandbox, "stop");
			const writers = Array.from({ length: BACKGROUND_WRITERS }, (_, writer) =>
				spawnBun(backgroundWriterScript(writer, stopPath)),
			);
			await Promise.all(writers.map((writer) => waitForLine(writer, "started")));

			const statuses: string[] = [];
			try {
				for (let build = 0; build < BLUEPRINT_BUILDS; build++) {
					const outcome = await runBlueprintBuild([repository], {
						agentDir,
						storeDir: join(sandbox, "store"),
						trusted: savedProjectTrust(agentDir, { getDefaultProjectTrust: () => "ask" }),
						homeDir: sandbox,
						environment: { PATH: process.env.PATH ?? "", HOME: sandbox },
					});
					statuses.push(
						outcome.failures.length === 0 ? outcome.status : `${outcome.status}: ${outcome.failures[0]?.error}`,
					);
				}
			} finally {
				writeFileSync(stopPath, "");
			}
			await Promise.all(writers.map(finish));

			assert.deepEqual(statuses, Array<string>(BLUEPRINT_BUILDS).fill("success"));
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	it("reports a truncated trust.json once and reads it as empty (#4952)", async () => {
		const project = join(sandbox, "project");
		writeFileSync(trustPath, `{\n  ${JSON.stringify(getProjectTrustPath(project))}: tr`);
		const store = new ProjectTrustStore(agentDir);
		const capture = captureWarnings();
		try {
			assert.equal(store.get(project), null);
			assert.equal(store.getEntry(project), null);
			await waitForWarnings();
		} finally {
			capture.stop();
		}

		assert.equal(capture.warnings.length, 1);
		assert.match(capture.warnings[0]!.message, /trust\.json/);
		assert.match(capture.warnings[0]!.message, /treated as empty/);
	});

	it("saves a decision over a truncated trust.json (#4952)", async () => {
		const project = join(sandbox, "project");
		writeFileSync(trustPath, "{");
		const store = new ProjectTrustStore(agentDir);
		const capture = captureWarnings();
		try {
			store.set(project, true);
			await waitForWarnings();
		} finally {
			capture.stop();
		}

		assert.equal(store.get(project), true);
		assert.deepEqual(JSON.parse(readFileSync(trustPath, "utf8")), { [getProjectTrustPath(project)]: true });
	});

	it("reads saved decisions while another process holds the trust lock (#4952)", () => {
		const project = join(sandbox, "project");
		const store = new ProjectTrustStore(agentDir);
		store.set(project, true);
		const release = lockfile.lockSync(dirname(trustPath), { realpath: false, lockfilePath: `${trustPath}.lock` });
		try {
			assert.equal(store.get(project), true);
		} finally {
			release();
		}
	});

	it(
		"fails a save with a clear error when a live process keeps the trust lock (#4952)",
		() => {
			const store = new ProjectTrustStore(agentDir);
			const release = lockfile.lockSync(dirname(trustPath), { realpath: false, lockfilePath: `${trustPath}.lock` });
			try {
				assert.throws(() => store.set(join(sandbox, "project"), true), /trust\.json.*locked by another process/);
			} finally {
				release();
			}
		},
		HELD_LOCK_TEST_TIMEOUT_MS,
	);

	it("takes over a lock a crashed process left behind (#4952)", () => {
		const project = join(sandbox, "project");
		const lockPath = `${trustPath}.lock`;
		mkdirSync(lockPath);
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(lockPath, longAgo, longAgo);

		new ProjectTrustStore(agentDir).set(project, false);

		assert.equal(new ProjectTrustStore(agentDir).get(project), false);
	});
});
