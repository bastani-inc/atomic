import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { installWorkflowHilAnswerNotifications } from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { installWorkflowLifecycleNotifications } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import {
	MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
	nextWorkflowHeartbeatBoundary,
} from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { DEBUG_MODE_SOURCES, type DebugLogFixture, withDebugLog } from "../helpers/debug-mode.js";

const discovery = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));

vi.mock("../../packages/workflows/src/extension/discovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/extension/discovery.js")>();
	return {
		...actual,
		discoverWorkflows: async (...args: Parameters<typeof actual.discoverWorkflows>) => {
			await discovery.hold;
			return actual.discoverWorkflows(...args);
		},
	};
});

type Trigger = () => void | Promise<void>;

interface WorkflowSite {
	readonly name: string;
	readonly trigger: Trigger;
	/** The debug log record the site writes in debug mode. */
	readonly record: { readonly event: string; readonly data: Record<string, unknown> };
	/** What `ATOMIC_WORKFLOW_DEBUG=1` prints, as it always has. */
	readonly stderr: readonly unknown[];
}

function failLifecycleNotice(): void {
	const store = createStore();
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["completed"] },
		sendMessage() {
			throw new Error("lifecycle send failed");
		},
	});
	store.recordRunStart({
		id: "run-debug",
		name: "debug",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordRunEnd("run-debug", "completed", {});
	unsubscribe();
}

function failHilAnswerNotice(): void {
	const store = createStore();
	const unsubscribe = installWorkflowHilAnswerNotifications({
		store,
		stageUiBroker: new StageUiBroker(store),
		sendMessage() {
			throw new Error("hil send failed");
		},
	});
	store.recordRunStart({
		id: "run-1",
		name: "release",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart("run-1", { id: "stage-1", name: "review", status: "running", parentIds: [], toolEvents: [] });
	store.recordStagePendingPrompt("run-1", "stage-1", {
		id: "prompt-1",
		kind: "input",
		message: "Name?",
		createdAt: 10,
	});
	store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "answer");
	store.recordNotice({ id: "tick", level: "info", message: "notify", createdAt: 20 });
	store.clearStagePromptAnswer("run-1", "stage-1");
	unsubscribe();
}

function scheduleUnrepresentableHeartbeat(): void {
	assert.equal(nextWorkflowHeartbeatBoundary(1_000, Number.MAX_VALUE, 1_000), undefined);
}

/** Starts background discovery and waits until it has settled and reported. */
async function warmUpDiscovery(pi: Partial<ExtensionAPI>, onSettled?: () => void): Promise<void> {
	const state = createWorkflowExtensionRuntimeState(pi as ExtensionAPI, {} as never);
	state.setNotificationsActive(true);
	await new Promise<void>((settled) => {
		state.startWorkflowDiscoveryWarmup(() => {
			try {
				onSettled?.();
			} finally {
				settled();
			}
		});
	});
}

const SITES: readonly WorkflowSite[] = [
	{
		name: "lifecycle notice send failure",
		trigger: failLifecycleNotice,
		record: { event: "lifecycle-notice-send-failed", data: { message: "lifecycle send failed" } },
		stderr: ["[workflows] workflow lifecycle notice send failed", "lifecycle send failed"],
	},
	{
		name: "HiL answer notice send failure",
		trigger: failHilAnswerNotice,
		record: { event: "hil-answer-notice-send-failed", data: { message: "hil send failed" } },
		stderr: ["[workflows] workflow HiL answer notice send failed", "hil send failed"],
	},
	{
		name: "unschedulable heartbeat interval",
		trigger: scheduleUnrepresentableHeartbeat,
		record: {
			event: "heartbeat-interval-unschedulable",
			data: {
				intervalMinutes: Number.MAX_VALUE,
				maximumMinutes: MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
			},
		},
		stderr: [
			`[workflows] heartbeatIntervalMinutes ${Number.MAX_VALUE} exceeds the largest representable cadence ` +
				`(${MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES} minutes); no boundary can be scheduled for it`,
		],
	},
	{
		name: "background discovery failure",
		trigger: () =>
			warmUpDiscovery({
				refreshWorkflowResources: async () => {
					throw new Error("discovery failed");
				},
			}),
		record: { event: "background-discovery-failed", data: { message: "discovery failed" } },
		stderr: ["Workflow background discovery failed: discovery failed"],
	},
	{
		name: "background discovery callback failure",
		trigger: () =>
			warmUpDiscovery({ refreshWorkflowResources: async () => [] }, () => {
				throw new Error("callback failed");
			}),
		record: { event: "background-discovery-callback-failed", data: { message: "callback failed" } },
		stderr: ["Workflow background discovery callback failed: callback failed"],
	},
];

afterEach(() => {
	vi.restoreAllMocks();
});

test("a discovery that failed after the host moved on reports nothing, even in debug mode (#4360)", async () => {
	let fail!: (error: Error) => void;
	const refreshed = vi.fn(
		() =>
			new Promise<never>((_resolve, reject) => {
				fail = reject;
			}),
	);
	const { log } = await capture("setting", true, async () => {
		const state = createWorkflowExtensionRuntimeState(
			{ refreshWorkflowResources: refreshed } as ExtensionAPI,
			{} as never,
		);
		state.setNotificationsActive(true);
		state.startWorkflowDiscoveryWarmup();
		await vi.waitFor(() => assert.equal(refreshed.mock.calls.length, 1));
		state.setNotificationsActive(true);
		fail(new Error("stale discovery failed"));
		for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
	});
	assert.deepEqual(log, []);
});

test("a discovery still running after its package resources were refreshed reports before its test reads the log (#4360)", async () => {
	const SIMULATED_DISCOVERY_SCAN_DELAY_MS = 200;
	let release!: () => void;
	discovery.hold = new Promise((resolve) => {
		release = resolve;
	});
	try {
		const { log } = await capture("setting", false, () =>
			warmUpDiscovery(
				{
					refreshWorkflowResources: async () => {
						setTimeout(release, SIMULATED_DISCOVERY_SCAN_DELAY_MS);
						return [];
					},
				},
				() => {
					throw new Error("callback failed");
				},
			),
		);
		assert.deepEqual(
			log.filter((record) => record.area === "workflow").map(({ event, data }) => ({ event, data })),
			[{ event: "background-discovery-callback-failed", data: { message: "callback failed" } }],
		);
	} finally {
		discovery.hold = undefined;
	}
});

async function capture(
	source: "setting" | "ATOMIC_DEBUG" | "off",
	ownVariable: boolean,
	trigger: Trigger,
): Promise<{ readonly log: ReturnType<DebugLogFixture["records"]>; readonly stderr: unknown[][] }> {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		return await withDebugLog(source, async (log) => {
			if (ownVariable) vi.stubEnv("ATOMIC_WORKFLOW_DEBUG", "1");
			await trigger();
			return { log: log.records(), stderr: [...warn.mock.calls] };
		});
	} finally {
		warn.mockRestore();
	}
}

describe("workflow debug area (#4360)", () => {
	describe.each(SITES)("$name", (site) => {
		test("is silent with every source off", async () => {
			const { log, stderr } = await capture("off", false, site.trigger);
			assert.deepEqual(log, []);
			assert.deepEqual(stderr, []);
		});

		test.each(DEBUG_MODE_SOURCES)("writes the debug log, and not stderr, in debug mode from %s", async (source) => {
			const { log, stderr } = await capture(source, false, site.trigger);
			assert.deepEqual(
				log.filter((record) => record.area === "workflow").map(({ event, data }) => ({ event, data })),
				[site.record],
			);
			assert.deepEqual(stderr, []);
		});

		test("prints to stderr, as before, from ATOMIC_WORKFLOW_DEBUG=1", async () => {
			const { log, stderr } = await capture("off", true, site.trigger);
			assert.deepEqual(log, []);
			assert.deepEqual(stderr, [site.stderr]);
		});
	});
});
