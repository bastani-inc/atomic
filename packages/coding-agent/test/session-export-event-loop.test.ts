import assert from "node:assert/strict";
import {
	accessSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, beforeAll, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { getExportTemplateDir } from "../src/config.ts";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.js";

useTemporaryAgentDir();

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: vi.fn(actual.accessSync),
		existsSync: vi.fn(actual.existsSync),
		lstatSync: vi.fn(actual.lstatSync),
		mkdirSync: vi.fn(actual.mkdirSync),
		openSync: vi.fn(actual.openSync),
		readFileSync: vi.fn(actual.readFileSync),
		readlinkSync: vi.fn(actual.readlinkSync),
		realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }),
		renameSync: vi.fn(actual.renameSync),
		rmSync: vi.fn(actual.rmSync),
		statSync: vi.fn(actual.statSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

const BLOCKING = Object.entries({
	accessSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
}).map(([name, call]) => ({ name, mock: vi.mocked(call as (...args: unknown[]) => unknown) }));

const directories: string[] = [];
const harnesses: Harness[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	directories.push(directory);
	return directory;
}

async function blockingCallsUnder(roots: readonly string[], work: () => Promise<unknown>): Promise<string[]> {
	for (const { mock } of BLOCKING) mock.mockClear();
	await work();
	return BLOCKING.flatMap(({ name, mock }) =>
		mock.mock.calls
			.map(([path]) => String(path))
			.filter((path) => roots.some((root) => path.startsWith(root)))
			.map((path) => `${name}(${path})`),
	);
}

async function sessionWithHistory(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("exported reply")]);
	await harness.session.prompt("export this conversation");
	return harness;
}

test("a JSONL export creates, writes and moves its file into place without blocking the event loop", async () => {
	const directory = temporaryDirectory("atomic-export-loop-jsonl-");
	const harness = await sessionWithHistory();
	const target = join(directory, "nested", "export.jsonl");

	const calls = await blockingCallsUnder([directory], () => harness.session.exportToJsonl(target));

	assert.deepEqual(calls, []);
	assert.match(readFileSync(target, "utf8"), /exported reply/);
});

test("an HTML export reads its template and writes its file without blocking the event loop", async () => {
	const directory = temporaryDirectory("atomic-export-loop-html-");
	const harness = await sessionWithHistory();
	const target = join(directory, "export.html");

	const calls = await blockingCallsUnder([directory, getExportTemplateDir()], () =>
		harness.session.exportToHtml(target),
	);

	assert.deepEqual(calls, []);
	assert.match(readFileSync(target, "utf8"), /<html/i);
});

test("a branch summary lists the files its tool calls touched without blocking the event loop", async () => {
	const cwd = temporaryDirectory("atomic-export-loop-branch-");
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "src", "app.ts"), "");
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "read the app" }], timestamp: Date.now() },
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "@src/app.ts" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		},
	];
	let result: Awaited<ReturnType<typeof generateBranchSummary>> | undefined;

	const calls = await blockingCallsUnder([cwd], async () => {
		result = await generateBranchSummary(entries, {
			cwd,
			model: {
				id: "summary-model",
				name: "Summary model",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			apiKey: "test-key",
			signal: new AbortController().signal,
			streamFn: (requestModel) => {
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "the branch read the app" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage,
					stopReason: "stop",
					timestamp: Date.now(),
				});
				return stream;
			},
		});
	});

	assert.deepEqual(calls, []);
	assert.deepEqual(result?.readFiles, [join("src", "app.ts")]);
});
