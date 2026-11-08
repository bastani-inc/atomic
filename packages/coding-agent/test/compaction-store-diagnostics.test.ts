import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Api, AssistantMessage, Model } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { ENV_AGENT_DIR, getCompactionDiagnosticsDir, getDebugLogPath } from "../src/config.js";
import { runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import { planDeletedLineRanges, RangePlanError } from "../src/core/compaction/range-planner.js";
import type { SidecarDirectory } from "../src/core/compaction/range-planner-diagnostics.js";
import {
	buildDiagnosticPayload,
	type CompactionDiagnostic,
	MAX_DIAGNOSTIC_TEXT_CHARS,
	writeDiagnosticSidecar,
	writeMorphDiagnosticSidecar,
	writeRecoveryDiagnosticSidecar,
	writeSuccessDiagnosticSidecar,
} from "../src/core/compaction/range-planner-diagnostics.js";
import { convertToLlm } from "../src/core/messages.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { Settings } from "../src/core/settings-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	conversationRegion,
	fallbackModel,
	plannerModel,
	preparationFor,
	REFUSED_BEFORE_OUTPUT,
} from "./compaction-midstream-fixtures.js";
import { planner } from "./compaction-planner-fixtures.js";
import {
	createFauxStreamFn,
	createHarnessWithExtensions,
	type FauxResponseInput,
	type Harness,
} from "./test-harness.js";

const posixOnly = process.platform === "win32" ? test.skip : test;

const directories: string[] = [];
const harnesses: Harness[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function useAgentDirectory(): string {
	const agentDir = temporaryDirectory("compaction-agent-dir-");
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	return agentDir;
}

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");
const compactionSettings: Partial<Settings> = {
	compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 0, background: false },
};

async function sqliteSessionManager(agentDir: string): Promise<SessionManager> {
	const database = await openNodeSqliteDatabase(join(agentDir, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return SessionManager.create(store, agentDir);
}

async function sessionAnsweringPlanner(
	sessionManager: SessionManager,
	plannerAnswers: FauxResponseInput[],
): Promise<Harness> {
	const harness = await createHarnessWithExtensions({
		contextWindow: 100_000,
		settings: compactionSettings,
		responses: ["first answer", ...plannerAnswers],
		sessionManager,
	});
	harnesses.push(harness);
	harness.agent.convertToLlm = convertToLlm;
	harness.session.setActiveToolsByName([]);
	const model = harness.session.model;
	assert.ok(model);
	harness.session.modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: model.api,
		models: [model],
	});
	await harness.session.prompt(longPrompt);
	return harness;
}

async function compactionFailure(harness: Harness): Promise<Error> {
	const error = await harness.session.compact().catch((caught: unknown) => caught);
	assert.ok(error instanceof Error, "compaction failed");
	return error;
}

function sidecars(directory: string): string[] {
	return existsSync(directory) ? readdirSync(directory).map((name) => join(directory, name)) : [];
}

function readSidecar(path: string): CompactionDiagnostic {
	return JSON.parse(readFileSync(path, "utf-8")) as CompactionDiagnostic;
}

describe("a session in a SQLite store (#4543)", () => {
	test("keeps the raw planner answer when no usable deleted ranges came back (#4543)", async () => {
		const agentDir = useAgentDirectory();
		const manager = await sqliteSessionManager(agentDir);
		assert.equal(manager.getSessionFile(), undefined);
		assert.equal(manager.isPersisted(), true);
		const harness = await sessionAnsweringPlanner(manager, ["1:900,999"]);

		const error = await compactionFailure(harness);

		assert.ok(error instanceof RangePlanError);
		assert.equal(error.outcome?.kind, "unusable");
		assert.equal(error.outcome?.kind === "unusable" ? error.outcome.category : undefined, "no_usable_ranges");
		const [sidecar] = sidecars(getCompactionDiagnosticsDir());
		assert.ok(sidecar, "a diagnostic sidecar was written");
		assert.equal(error.diagnosticPath, sidecar);
		assert.equal(dirname(sidecar), getCompactionDiagnosticsDir());
		assert.ok(basename(sidecar).startsWith(`${manager.getSessionId()}-compaction-diagnostic-`));
		const diagnostic = readSidecar(sidecar);
		assert.equal(diagnostic.failureCategory, "no_usable_ranges");
		assert.equal(diagnostic.rawResponse, "1:900,999");
		assert.equal(diagnostic.model.id, harness.session.model?.id);
	});

	posixOnly("writes the sidecar owner-only in an owner-only directory (#4543)", async () => {
		const agentDir = useAgentDirectory();
		const harness = await sessionAnsweringPlanner(await sqliteSessionManager(agentDir), ["1:900,999"]);

		await compactionFailure(harness);

		const [sidecar] = sidecars(getCompactionDiagnosticsDir());
		assert.equal(statSync(sidecar).mode & 0o777, 0o600);
		assert.equal(statSync(getCompactionDiagnosticsDir()).mode & 0o777, 0o700);
	});

	test("redacts a credential in the raw answer (#4543)", async () => {
		const agentDir = useAgentDirectory();
		const harness = await sessionAnsweringPlanner(await sqliteSessionManager(agentDir), [
			"Here is the key: Bearer abcdefghijklmnopqrstuvwxyz0123",
		]);

		await compactionFailure(harness);

		const [sidecar] = sidecars(getCompactionDiagnosticsDir());
		const diagnostic = readSidecar(sidecar);
		assert.equal(diagnostic.failureCategory, "malformed_output");
		assert.match(diagnostic.rawResponse, /^Here is the key: \[redacted\]$/);
		assert.doesNotMatch(readFileSync(sidecar, "utf-8"), /abcdefghijklmnopqrstuvwxyz0123/);
	});

	test("keeps a later failure's answer in its own file (#4543)", async () => {
		const agentDir = useAgentDirectory();
		const harness = await sessionAnsweringPlanner(await sqliteSessionManager(agentDir), ["1:900,999", "1:800,899"]);

		await compactionFailure(harness);
		await compactionFailure(harness);

		const answers = sidecars(getCompactionDiagnosticsDir())
			.map((sidecar) => readSidecar(sidecar).rawResponse)
			.sort();
		assert.deepEqual(answers, ["1:800,899", "1:900,999"]);
	});

	test("still reports the planning failure when the diagnostics directory cannot be created (#4543)", async () => {
		const agentDir = useAgentDirectory();
		writeFileSync(getCompactionDiagnosticsDir(), "a file where the directory belongs");
		const harness = await sessionAnsweringPlanner(await sqliteSessionManager(agentDir), ["1:900,999"]);

		const error = await compactionFailure(harness);

		assert.ok(error instanceof RangePlanError);
		assert.equal(error.diagnosticPath, undefined);
		assert.equal(error.outcome?.kind === "unusable" ? error.outcome.category : undefined, "no_usable_ranges");
	});
});

describe("other sessions (#4543)", () => {
	test("an in-memory session writes no diagnostic (#4543)", async () => {
		useAgentDirectory();
		const harness = await sessionAnsweringPlanner(SessionManager.inMemory(), ["1:900,999"]);

		const error = await compactionFailure(harness);

		assert.ok(error instanceof RangePlanError);
		assert.equal(error.diagnosticPath, undefined);
		assert.deepEqual(sidecars(getCompactionDiagnosticsDir()), []);
	});

	test("a JSONL session keeps its diagnostic beside the session file (#4543)", async () => {
		const agentDir = useAgentDirectory();
		const sessionDir = join(agentDir, "jsonl-sessions");
		const manager = await SessionManager.create(agentDir, sessionDir);
		const harness = await sessionAnsweringPlanner(manager, ["1:900,999"]);
		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile);

		const error = await compactionFailure(harness);

		assert.ok(error instanceof RangePlanError);
		assert.ok(error.diagnosticPath);
		assert.equal(dirname(error.diagnosticPath), dirname(sessionFile));
		assert.deepEqual(sidecars(getCompactionDiagnosticsDir()), []);
	});
});

const model = plannerModel as Model<Api>;

function failureContext(overrides: Partial<Parameters<typeof buildDiagnosticPayload>[0]> = {}) {
	return {
		sessionFilePath: undefined,
		model,
		requestMaxTokens: undefined,
		response: undefined,
		rawResponseText: "2:1,3",
		failureCategory: "no_usable_ranges" as const,
		failureMessage: "Compaction range planning produced no usable deleted ranges",
		...overrides,
	};
}

function refusedResponse(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test",
		model: "primary",
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

describe("diagnostic text (#4543)", () => {
	test("is cut to the bound and records the answer's full length (#4543)", () => {
		const answer = "1:1,2\n".repeat(MAX_DIAGNOSTIC_TEXT_CHARS);
		const payload = buildDiagnosticPayload(failureContext({ rawResponseText: answer }));

		assert.equal(payload.rawResponse.length, MAX_DIAGNOSTIC_TEXT_CHARS);
		assert.equal(payload.rawResponse, answer.slice(0, MAX_DIAGNOSTIC_TEXT_CHARS));
		assert.equal(payload.rawResponseChars, answer.length);
	});

	test("an answer exactly at the bound is kept whole (#4543)", () => {
		const answer = "1".repeat(MAX_DIAGNOSTIC_TEXT_CHARS);
		const payload = buildDiagnosticPayload(failureContext({ rawResponseText: answer }));

		assert.equal(payload.rawResponse, answer);
		assert.equal("rawResponseChars" in payload, false);
	});

	test("is redacted before it is cut, so a secret at the cut leaves no prefix (#4543)", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz";
		const padding = "x".repeat(MAX_DIAGNOSTIC_TEXT_CHARS - 5);
		const payload = buildDiagnosticPayload(failureContext({ rawResponseText: `${padding} ${secret} tail` }));

		assert.equal(payload.rawResponse, `${padding} [redacted] tail`.slice(0, MAX_DIAGNOSTIC_TEXT_CHARS));
		assert.equal(payload.rawResponseChars, `${padding} [redacted] tail`.length);
		assert.doesNotMatch(payload.rawResponse, /sk-/);
	});

	test("redacts credentials in the failure message and the provider error (#4543)", () => {
		const payload = buildDiagnosticPayload(
			failureContext({
				failureMessage: "request failed: api_key=abcdefghijklmnop0123",
				response: refusedResponse("401 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"),
			}),
		);

		assert.doesNotMatch(payload.failureMessage, /abcdefghijklmnop0123/);
		assert.match(payload.failureMessage, /\[redacted\]/);
		assert.doesNotMatch(payload.providerError ?? "", /abcdefghijklmnopqrstuvwxyz0123/);
		assert.match(payload.providerError ?? "", /\[redacted\]/);
	});

	test("bounds a long provider error (#4543)", () => {
		const payload = buildDiagnosticPayload(
			failureContext({ response: refusedResponse("e".repeat(MAX_DIAGNOSTIC_TEXT_CHARS * 2)) }),
		);

		assert.equal(payload.providerError?.length, MAX_DIAGNOSTIC_TEXT_CHARS);
	});

	test("leaves an absent provider error absent (#4543)", () => {
		const payload = buildDiagnosticPayload(failureContext());

		assert.equal(payload.providerError, undefined);
	});
});

describe("sidecar location (#4543)", () => {
	function directoryTarget(): SidecarDirectory {
		return { directory: join(temporaryDirectory("compaction-sidecar-"), "nested", "diagnostics"), stem: "session-7" };
	}

	test("a sidecar directory is created and holds the sidecar named after its stem (#4543)", () => {
		const sidecarDirectory = directoryTarget();

		const path = writeDiagnosticSidecar(failureContext({ sidecarDirectory }));

		assert.ok(path);
		assert.equal(dirname(path), sidecarDirectory.directory);
		assert.match(basename(path), /^session-7-compaction-diagnostic-\d+-[0-9a-f-]{36}\.json$/);
		assert.equal(readSidecar(path).rawResponse, "2:1,3");
	});

	test("the session file wins over a sidecar directory and is never created (#4543)", () => {
		const sidecarDirectory = directoryTarget();
		const sessionDir = temporaryDirectory("compaction-session-");

		const path = writeDiagnosticSidecar(
			failureContext({ sessionFilePath: join(sessionDir, "2026-07-15_abc.jsonl"), sidecarDirectory }),
		);

		assert.ok(path);
		assert.equal(dirname(path), sessionDir);
		assert.match(basename(path), /^2026-07-15_abc-compaction-diagnostic-/);
		assert.equal(existsSync(sidecarDirectory.directory), false);
	});

	test("a session file in a missing directory writes nothing and creates nothing (#4543)", () => {
		const sessionDir = join(temporaryDirectory("compaction-session-"), "missing");

		assert.equal(writeDiagnosticSidecar(failureContext({ sessionFilePath: join(sessionDir, "s.jsonl") })), undefined);
		assert.equal(existsSync(sessionDir), false);
	});

	test("without a session file or a sidecar directory nothing is written (#4543)", () => {
		assert.equal(writeDiagnosticSidecar(failureContext()), undefined);
	});

	test("every kind of sidecar can be written to a sidecar directory (#4543)", () => {
		const sidecarDirectory = directoryTarget();
		const paths = [
			writeRecoveryDiagnosticSidecar({
				sidecarDirectory,
				model,
				requestMaxTokens: undefined,
				response: refusedResponse("cut off"),
				rawResponseText: "1:1,2\n1:3",
				recoveryCategory: "partial_length_recovery",
				recoveredRangeCount: 1,
			}),
			writeSuccessDiagnosticSidecar({ sidecarDirectory, model, successCategory: "borrowed_planner" }),
			writeMorphDiagnosticSidecar({ sidecarDirectory }, {} as Parameters<typeof writeMorphDiagnosticSidecar>[1]),
		];

		for (const [index, kind] of ["recovery", "success", "morph"].entries()) {
			assert.ok(paths[index], kind);
			assert.match(basename(paths[index]), new RegExp(`^session-7-compaction-${kind}-`));
		}
	});

	test("a cut recovery answer records its full length (#4543)", () => {
		const sidecarDirectory = directoryTarget();
		const path = writeRecoveryDiagnosticSidecar({
			sidecarDirectory,
			model,
			requestMaxTokens: undefined,
			response: refusedResponse("cut off"),
			rawResponseText: "x".repeat(MAX_DIAGNOSTIC_TEXT_CHARS + 10),
			recoveryCategory: "partial_length_recovery",
			recoveredRangeCount: 1,
		});

		assert.ok(path);
		const stored = JSON.parse(readFileSync(path, "utf-8")) as { rawResponse: string; rawResponseChars?: number };
		assert.equal(stored.rawResponse.length, MAX_DIAGNOSTIC_TEXT_CHARS);
		assert.equal(stored.rawResponseChars, MAX_DIAGNOSTIC_TEXT_CHARS + 10);
	});

	function debugRecords() {
		return readFileSync(getDebugLogPath(), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { area: string; event: string; data: { path: string; code?: string } });
	}

	test("a failed directory creation is returned as no path and recorded once in the debug log (#4543)", () => {
		const agentDir = useAgentDirectory();
		vi.stubEnv("ATOMIC_DEBUG", "1");
		const blocker = join(agentDir, "blocker");
		writeFileSync(blocker, "not a directory");

		const path = writeDiagnosticSidecar(
			failureContext({ sidecarDirectory: { directory: join(blocker, "d"), stem: "s" } }),
		);

		assert.equal(path, undefined);
		const records = debugRecords();
		assert.equal(records.length, 1);
		assert.equal(records[0].area, "storage");
		assert.equal(records[0].event, "compaction-diagnostic-unwritable");
		assert.equal(records[0].data.path, join(blocker, "d"));
		assert.ok(records[0].data.code);
	});

	test("a failed file write beside a session file is recorded once in the debug log (#4543)", () => {
		const agentDir = useAgentDirectory();
		vi.stubEnv("ATOMIC_DEBUG", "1");
		const missing = join(agentDir, "missing");

		const path = writeDiagnosticSidecar(failureContext({ sessionFilePath: join(missing, "s.jsonl") }));

		assert.equal(path, undefined);
		const records = debugRecords();
		assert.equal(records.length, 1);
		assert.equal(records[0].event, "compaction-diagnostic-unwritable");
		assert.equal(records[0].data.code, "ENOENT");
		assert.equal(dirname(records[0].data.path), missing);
	});

	test("a refused planner request's outcome carries the path of its sidecar (#4543)", async () => {
		const sidecarDirectory = directoryTarget();
		const refusal = refusedResponse("The model refused to complete the request");

		const outcome = await planDeletedLineRanges(
			conversationRegion(8),
			preparationFor(conversationRegion(8)).parameters,
			planner(plannerModel, undefined),
			16,
			{ streamFn: (() => ({ result: async () => refusal })) as never, sidecarDirectory },
		);

		assert.equal(outcome.kind, "policyRefusal");
		const diagnosticPath = outcome.kind === "policyRefusal" ? outcome.diagnosticPath : undefined;
		assert.ok(diagnosticPath);
		assert.equal(dirname(diagnosticPath), sidecarDirectory.directory);
		assert.equal(readSidecar(diagnosticPath).failureCategory, "policy_refusal");
	});

	test("the diagnostics directory is under the agent directory (#4543)", () => {
		const agentDir = useAgentDirectory();

		assert.equal(getCompactionDiagnosticsDir(), join(agentDir, "compaction-diagnostics"));
	});
});

describe("the runner hands the sidecar directory to every kind of sidecar (#4543)", () => {
	const preparation = preparationFor(conversationRegion(8));
	const entryTimestamp = new Date(0).toISOString();
	const summaryEntries: SessionEntry[] = [
		{
			type: "message",
			id: "old",
			parentId: null,
			timestamp: entryTimestamp,
			message: { role: "user", content: "history", timestamp: 0 },
		},
		{
			type: "message",
			id: "tail",
			parentId: "old",
			timestamp: entryTimestamp,
			message: { role: "user", content: "recent".repeat(20000), timestamp: 1 },
		},
	];

	function request(sidecarDirectory: SidecarDirectory, responses: FauxResponseInput[]) {
		return {
			streamFn: createFauxStreamFn(responses).streamFn,
			sidecarDirectory,
			resolveAuth: async () => ({ apiKey: "key" }),
			thinkingLevel: "off" as const,
			urgency: "recoverable" as const,
		};
	}

	function target(): SidecarDirectory {
		return { directory: join(temporaryDirectory("runner-sidecars-"), "diagnostics"), stem: "session-9" };
	}

	test("a borrowed planner's success is recorded there (#4543)", async () => {
		const sidecarDirectory = target();

		await runVerbatimCompaction(preparation, plannerModel, {
			...request(sidecarDirectory, [{ stopReason: "error", error: "Invalid request" }, "1:1,3"]),
			fallback: {
				fallbackModels: ["test/fallback"],
				preferredProvider: "test",
				sessionThinkingLevel: "off",
				registry: {
					getAvailableSnapshot: () => [plannerModel, fallbackModel],
					getModel: (_provider, id) => (id === fallbackModel.id ? fallbackModel : plannerModel),
					hasConfiguredAuth: () => true,
				},
			},
		});

		const kinds = sidecars(sidecarDirectory.directory).map(
			(path) => basename(path).split("-compaction-")[1].split("-")[0],
		);
		assert.deepEqual(kinds.sort(), ["diagnostic", "success"]);
	});

	test("a failed summary is recorded there (#4543)", async () => {
		const sidecarDirectory = target();

		const error = await runVerbatimCompaction(preparation, plannerModel, {
			...request(sidecarDirectory, [REFUSED_BEFORE_OUTPUT]),
			summaryEntries,
		}).catch((caught: unknown) => caught);

		assert.ok(error instanceof RangePlanError);
		assert.equal(sidecars(sidecarDirectory.directory).length, 2);
		assert.ok(error.message.includes(`(diagnostic: ${sidecarDirectory.directory}`));
	});

	test("a Morph failure is recorded there (#4543)", async () => {
		const sidecarDirectory = target();

		await runVerbatimCompaction(preparation, plannerModel, {
			...request(sidecarDirectory, ["1:1,3"]),
			compactionModel: { kind: "morph", fullId: "morph/morph-compactor" },
			resolveMorphApiKey: async () => "morph-key",
			morphFetchFn: async () => new Response("overloaded", { status: 503 }),
		}).catch(() => undefined);

		const kinds = sidecars(sidecarDirectory.directory).map(
			(path) => basename(path).split("-compaction-")[1].split("-")[0],
		);
		assert.deepEqual(kinds, ["morph"]);
	});
});
