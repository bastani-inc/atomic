import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	isResumeCatalogTimeoutError,
	isResumeCatalogUnavailableError,
	RESUME_CATALOG_TIMEOUT_MS,
} from "../../packages/coding-agent/src/index.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const agentDir = useTemporaryAgentDir();

/** Callbacks a test adapter module reaches through the global object, since it is loaded apart from this file. */
interface JournalProbe {
	opened?: () => void;
	failure?: Error;
}
const probe = globalThis as typeof globalThis & { __runLookupProbe?: JournalProbe };

/**
 * A journal adapter module that reports each open through `__runLookupProbe.opened` and then never answers, or rejects
 * with `__runLookupProbe.failure` when one is set.
 */
function journalAdapter(name: string): string {
	const path = join(directory, name);
	writeFileSync(
		path,
		"export default { atomicStorageAdapter: 1, openRunJournal() { const probe = globalThis.__runLookupProbe; probe.opened?.(); return probe.failure ? Promise.reject(probe.failure) : new Promise(() => {}); } };\n",
	);
	return path;
}

/** Resolves once the adapter was asked to open its journal. */
function nextOpen(): Promise<void> {
	return new Promise<void>((resolveOpen) => {
		probe.__runLookupProbe = { opened: resolveOpen };
	});
}

const empty = workflow({
	name: "lookup-deadline",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("step", {}, async () => "done");
		return {};
	},
});
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "atomic-run-lookup-"));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

test("resuming a run from shared storage that never answers fails at the lookup deadline, typed and retryable (#4329)", async () => {
	const adapter = journalAdapter("silent-journal.mjs");
	const runId = randomUUID();
	const opened = nextOpen();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pending = run(empty, {}, { runId, journal: { adapter } }).then(
		() => undefined,
		(error: unknown) => error,
	);
	await opened;
	await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS - 1);
	assert.equal(vi.getTimerCount(), 1, "the lookup is still waiting just before its deadline");
	await vi.advanceTimersByTimeAsync(1);
	const error = await pending;
	assert.ok(isResumeCatalogTimeoutError(error), String(error));
	assert.deepEqual(
		[error.code, error.subject, error.id, error.storage, error.timeoutMs, error.retryable, error.phase],
		["catalog-timeout", "run", runId, adapter, RESUME_CATALOG_TIMEOUT_MS, true, "catalog-lookup"],
	);
});

test("a run on storage only this machine reads, or a run without an id to resume, opens its journal without a deadline (#4329)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const local = run(empty, {}, { runId: randomUUID(), journal: { path: join(directory, "journal.sqlite") } });
	const unnamed = run(empty, {}, { journal: { path: join(directory, "other.sqlite") } });
	assert.equal(vi.getTimerCount(), 0);
	vi.useRealTimers();
	const results = [await local, await unnamed];
	assert.deepEqual(
		results.map((result) => [result.status, result.error]),
		[
			["completed", undefined],
			["completed", undefined],
		],
	);
});

test("a run without an id to resume waits for its shared journal without a deadline (#4329)", async () => {
	const adapter = journalAdapter("unnamed-journal.mjs");
	const opened = nextOpen();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	void run(empty, {}, { journal: { adapter } }).catch(() => undefined);
	await opened;
	assert.equal(vi.getTimerCount(), 0);
});

test("a resume whose shared journal comes from the global settings is bounded by the same deadline (#4329)", async () => {
	const adapter = journalAdapter("settings-journal.mjs");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ workflows: { journal: { adapter } } }));
	const owner = getDurableBackendProcessOwner();
	const injected = owner.injectedBackend;
	owner.injectedBackend = undefined;
	try {
		const runId = randomUUID();
		const opened = nextOpen();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = run(empty, {}, { runId, cwd: directory, store: createStore() }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await opened;
		await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
		const error = await pending;
		assert.ok(isResumeCatalogTimeoutError(error), String(error));
		assert.deepEqual([error.subject, error.id, error.storage], ["run", runId, adapter]);
	} finally {
		owner.injectedBackend = injected;
		rmSync(join(agentDir, "settings.json"), { force: true });
	}
});

test("a resume whose shared journal comes from the settings of the project it runs in is bounded too (#4329)", async () => {
	const adapter = journalAdapter("project-journal.mjs");
	const project = join(directory, "project");
	mkdirSync(join(project, ".atomic"), { recursive: true });
	writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ workflows: { journal: { adapter } } }));
	const owner = getDurableBackendProcessOwner();
	const injected = owner.injectedBackend;
	owner.injectedBackend = undefined;
	try {
		const runId = randomUUID();
		const opened = nextOpen();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = run(empty, {}, { runId, cwd: project, store: createStore() }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await opened;
		await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
		const error = await pending;
		assert.ok(isResumeCatalogTimeoutError(error), String(error));
		assert.deepEqual([error.subject, error.id, error.storage], ["run", runId, adapter]);
	} finally {
		owner.injectedBackend = injected;
	}
});

test("a resume whose shared journal cannot be reached fails as a retryable lookup error that keeps the cause (#4329)", async () => {
	const adapter = journalAdapter("unreachable-journal.mjs");
	const runId = randomUUID();
	const unreachable = new StorageUnavailableError(
		{ adapter: "libsql", location: "remote" },
		new Error("ECONNREFUSED"),
	);
	probe.__runLookupProbe = { failure: unreachable };
	const error = await run(empty, {}, { runId, journal: { adapter } }).then(
		() => undefined,
		(failure: unknown) => failure,
	);
	assert.ok(isResumeCatalogUnavailableError(error), String(error));
	assert.deepEqual(
		[error.code, error.subject, error.id, error.storage, error.retryable, error.cause],
		["catalog-unavailable", "run", runId, "libsql", true, unreachable],
	);
});

/** What `test/fixtures/gated-run-journal-adapter.mjs` reads and counts through the global object. */
interface GatedJournal {
	opens: number;
	closes: number;
	closeFailure?: Error;
	listing?: () => void;
	slowList?: Promise<void>;
	opened: () => void;
	firstOpen: Promise<void>;
}

/** A journal on the gated adapter whose first open waits for `releaseFirstOpen`, and a run that resumes from it. */
function gatedJournal() {
	let releaseFirstOpen = () => {};
	let firstOpened = () => {};
	const opened = new Promise<void>((resolveOpened) => {
		firstOpened = resolveOpened;
	});
	const gate: GatedJournal = {
		opens: 0,
		closes: 0,
		opened: () => firstOpened(),
		firstOpen: new Promise<void>((release) => {
			releaseFirstOpen = release;
		}),
	};
	(globalThis as typeof globalThis & { __gatedJournal?: GatedJournal }).__gatedJournal = gate;
	const adapter = fileURLToPath(new URL("../fixtures/gated-run-journal-adapter.mjs", import.meta.url));
	const journal = { adapter, options: { path: join(directory, "journal.sqlite") } };
	const runId = randomUUID();
	/** Resumes `runId` and lets its lookup deadline pass while the first open still waits. */
	const timedOutResume = async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const first = run(empty, {}, { runId, journal, store: createStore() }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await opened;
		await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
		assert.ok(isResumeCatalogTimeoutError(await first));
		vi.useRealTimers();
	};
	return { gate, journal, runId, releaseFirstOpen, timedOutResume };
}

test("a retry after a run lookup timed out opens the journal again, and the opening that answers late is closed (#4329)", async () => {
	const { gate, journal, runId, releaseFirstOpen, timedOutResume } = gatedJournal();
	await timedOutResume();

	const retried = await run(empty, {}, { runId, journal, store: createStore() });

	assert.deepEqual([retried.status, gate.opens, gate.closes], ["completed", 2, 0]);
	releaseFirstOpen();
	await vi.waitFor(() => assert.equal(gate.closes, 1));
});

test("a run still waiting on an opening whose resume timed out keeps it open and runs on it (#4329)", async () => {
	const { gate, journal, releaseFirstOpen, timedOutResume } = gatedJournal();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const waiting = run(empty, {}, { journal, store: createStore() });
	vi.useRealTimers();
	await timedOutResume();

	releaseFirstOpen();
	const result = await waiting;

	assert.deepEqual([result.status, gate.opens, gate.closes], ["completed", 1, 0]);
});

test("a failure to close an opening that answered after its resume timed out is reported, not dropped (#4329)", async () => {
	const { gate, releaseFirstOpen, timedOutResume } = gatedJournal();
	gate.closeFailure = new Error("close failed");
	const reported = vi.spyOn(console, "error").mockImplementation(() => {});
	const exitCode = process.exitCode;
	try {
		await timedOutResume();
		releaseFirstOpen();
		await vi.waitFor(() => assert.equal(gate.closes, 1));
		await vi.waitFor(() =>
			assert.ok(
				reported.mock.calls.some(
					([error]) => error instanceof StorageUnavailableError && error.cause === gate.closeFailure,
				),
			),
		);
		assert.equal(process.exitCode, 1);
	} finally {
		process.exitCode = exitCode;
		reported.mockRestore();
	}
});

test("a resume whose shared journal answers in time is not bounded by how long its runs take to list (#4329)", async () => {
	const { gate, journal, runId, releaseFirstOpen } = gatedJournal();
	releaseFirstOpen();
	let finishListing = () => {};
	gate.slowList = new Promise<void>((finish) => {
		finishListing = finish;
	});
	const listing = new Promise<void>((started) => {
		gate.listing = () => started();
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const resumed = run(empty, {}, { runId, journal, store: createStore() }).then(
		(result) => result,
		(error: unknown) => error,
	);
	await listing;
	await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS * 2);
	vi.useRealTimers();
	finishListing();

	const result = await resumed;

	assert.ok(!(result instanceof Error), String(result));
	assert.equal((result as Awaited<ReturnType<typeof run>>).status, "completed");
});
