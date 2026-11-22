/**
 * An SDK session that launched subagents and was disposed must leave nothing behind that keeps its history, extensions
 * and tools alive. Each parent is a real `createAgentSession` session with the bundled subagents and Intercom
 * extensions; it launches two children in one `subagent` call and is disposed once both answered. The first parent
 * also starts a process-wide service from one of its extension handlers, as a lazily started shared service does: the
 * service's timer keeps the async context it started in for as long as the process runs.
 */
import assert from "node:assert/strict";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI } from "../../packages/coding-agent/src/index.js";
import { trackCollection } from "../helpers/collect-garbage.js";
import {
	assertEveryOneCollected,
	CHILDREN_PER_PARENT,
	createRetentionFixture,
	DELEGATE,
	ENDED_SESSIONS_TIMEOUT_MS,
	PARENTS,
	quietSettings,
	type RetentionFixture,
} from "../helpers/ended-session-retention.js";

/** A service the first session to need it starts and every later session shares, until the process exits. */
let processWideService: ReturnType<typeof setInterval> | undefined;

function startsProcessWideService(atomic: ExtensionAPI): void {
	atomic.on("session_start", () => {
		processWideService ??= setInterval(() => {}, 3_600_000);
	});
}

/**
 * How long a parent waits for both children to answer: each is a real session with the bundled extensions, and on a
 * loaded Windows runner a parent's two children took about 30 s.
 */
const CHILDREN_ANSWER_TIMEOUT_MS = 120_000;

let fixture: RetentionFixture | undefined;
const parents = trackCollection();

async function runParentAndEnd(current: RetentionFixture): Promise<void> {
	const settingsManager = quietSettings();
	const resourceLoader = new DefaultResourceLoader({
		cwd: current.cwd,
		agentDir: current.agentDir,
		settingsManager,
		extensionFactories: [startsProcessWideService],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: current.cwd,
		agentDir: current.agentDir,
		modelRuntime: current.modelRuntime,
		model: current.parentModel,
		settingsManager,
		resourceLoader,
		builtins: { mcp: false, "web-access": false },
	});
	parents.track(session);
	const answeredBefore = current.childrenAnswered();
	await session.prompt(DELEGATE);
	await vi.waitFor(
		() => {
			assert.equal(current.childrenAnswered() - answeredBefore, CHILDREN_PER_PARENT, "both children answered");
			assert.equal(session.isStreaming, false);
		},
		{ timeout: CHILDREN_ANSWER_TIMEOUT_MS, interval: 20 },
	);
	await session.dispose();
}

beforeAll(async () => {
	const current = await createRetentionFixture();
	fixture = current;
	for (let parent = 0; parent < PARENTS; parent++) await runParentAndEnd(current);
}, ENDED_SESSIONS_TIMEOUT_MS);

afterAll(() => {
	clearInterval(processWideService);
	fixture?.dispose();
});

test(
	"every disposed session can be collected, also the one that started a process-wide service",
	async () => {
		assert.ok(processWideService, "the first parent started the process-wide service");
		await assertEveryOneCollected(parents);
	},
	ENDED_SESSIONS_TIMEOUT_MS,
);
