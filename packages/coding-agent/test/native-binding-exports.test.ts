import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "vitest";

// RFC #2884: the generated S1 supervisor, S2 command supervision and opaque capabilities are shipped exports.
// `__napiBindingTarget` is a napi-rs 3.10.x loader diagnostic (which binding artifact loaded), not a domain export.
const EXPECTED_NATIVE_EXPORTS = [
	"__napiBindingTarget",
	"AdmissionRefusalKind",
	"AgentStatus",
	"AgentTaskKind",
	"CancelCause",
	"CommandOutputSink",
	"CommandTaskKind",
	"FileType",
	"GrepOutputMode",
	"HostSession",
	"NapiSubagentControl",
	"NapiTaskSupervisor",
	"OwnerCloseCause",
	"OwnerLease",
	"RunnerLease",
	"StdinLease",
	"SubscriptionLease",
	"TaskLease",
	"TaskSupervisor",
	"WaitLease",
	"YieldReason",
	"RetainedPostgres",
	"PtySession",
	"SubagentControl",
	"TerminationCause",
	"blockRangeAt",
	"glob",
	"grep",
	"hasMatch",
	"invalidateFsScanCache",
	"postgresProcessStartTime",
	"search",
	"signalVerifiedPostgres",
	"spawnRetainedPostgres",
] as const;

const requireNativeBinding = process.env.ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE === "1";
let binding: object | undefined;
let loadError: Error | undefined;
try {
	binding = createRequire(import.meta.url)("@bastani/atomic-natives") as object;
} catch (error) {
	loadError = error instanceof Error ? error : new Error(String(error));
}

describe("Atomic native binding export contract", () => {
	it.skipIf(!requireNativeBinding && !binding)("loads the host binding with exactly the supported exports", () => {
		if (!binding) throw loadError ?? new Error("Native binding is required but unavailable");
		assert.deepEqual(Object.keys(binding).sort(), [...EXPECTED_NATIVE_EXPORTS].sort());
	});
});
