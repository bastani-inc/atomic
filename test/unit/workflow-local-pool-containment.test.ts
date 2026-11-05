import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	isSharedPoolSetupError,
	rehydrateWorkerPlacementError,
	type SharedPoolSetupError,
	serializeWorkerPlacementError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { activatePublicPool } from "../../packages/workflows/src/workers/public-pool.js";

const nativeTarget = vi.hoisted(() => ({ value: "native" as string }));

vi.mock("@bastani/atomic-natives", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bastani/atomic-natives")>();
	return {
		...actual,
		get __napiBindingTarget() {
			return nativeTarget.value;
		},
	};
});

const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
const localWorkers = { count: 1, definitions: [{ path: childPath, exportName: "child" }] };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	nativeTarget.value = "native";
});

async function refusal(): Promise<SharedPoolSetupError> {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		const outcome = await activatePublicPool(backend, { runId: "root", cwd: process.cwd(), localWorkers }).then(
			() => undefined,
			(error: Error) => error,
		);
		assert.ok(isSharedPoolSetupError(outcome), String(outcome));
		return outcome;
	} finally {
		await backend.close();
	}
}

test("local workers on Windows are refused typed, as a host that cannot contain their tool processes (#4310)", async () => {
	Object.defineProperty(process, "platform", { value: "win32" });
	const error = await refusal();
	assert.deepEqual(
		[error.code, error.operation, error.retryable, error.problems.map((problem) => problem.fields)],
		["process-containment-unavailable", "local-pool", false, [{ platform: "win32" }]],
	);
	assert.equal(
		error.message,
		"Local workers cannot start for a root with localWorkers: Local worker containment is unavailable on Windows; pooled tool processes cannot be enabled (process-containment-unavailable). Run roots with localWorkers on Linux or macOS, or run this one without localWorkers.",
	);
	const crossed = rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(serializeWorkerPlacementError(error))));
	assert.ok(isSharedPoolSetupError(crossed));
	assert.deepEqual([crossed.operation, crossed.message], [error.operation, error.message]);
});

test.skipIf(process.platform === "win32")(
	"local workers on a host whose native process identity does not load are refused typed, naming what to reinstall (#4310)",
	async () => {
		nativeTarget.value = "wasm32-wasi";
		const error = await refusal();
		assert.deepEqual(
			[error.code, error.operation, error.problems.map((problem) => problem.fields)],
			["process-containment-unavailable", "local-pool", [{ platform: process.platform }]],
		);
		assert.equal(
			error.message,
			"Local workers cannot start for a root with localWorkers: Local worker containment requires native process identity support (process-containment-unavailable). Reinstall Atomic so its native module for this platform loads, for example `npm install -g @bastani/atomic`.",
		);
		assert.equal(
			error.hint,
			"Reinstall Atomic so its native module for this platform loads, for example `npm install -g @bastani/atomic`.",
		);
	},
);
