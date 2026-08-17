import assert from "node:assert/strict";
import { join } from "node:path";
import { Error as DbosSdkError } from "@dbos-inc/dbos-sdk";
import { afterEach, describe, test, vi } from "vitest";
import {
	DbosDurabilityError,
	getReadyDbosBackend,
	resetDbosLifecycleForTests,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { classifyDbosDurabilityFailure } from "../../packages/workflows/src/durable/dbos-registration-diagnostics.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const ALREADY_REGISTERED = "Operation (Name: Default.atomicWorkflowHandle) is already registered.";
const CONFLICTING_TYPE =
	"Operation (Name: Default.atomicWorkflowCheckpoint) is already registered with a conflicting function type: Workflow vs. Step";
const PROVISIONING_GUIDANCE =
	"Set DBOS_SYSTEM_DATABASE_URL to an existing Postgres when local provisioning is unavailable.";
const PROVISIONING_RESTORE = "Restore durability by fixing Postgres provisioning:";
const CLASSIFIER_SOURCE = join(
	moduleDir(import.meta.url),
	"../../packages/workflows/src/durable/dbos-registration-diagnostics.ts",
);

afterEach(() => {
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

function realConflict(message: string): InstanceType<typeof DbosSdkError.DBOSConflictingRegistrationError> {
	return new DbosSdkError.DBOSConflictingRegistrationError(message);
}

function assertNoProvisioningWording(text: string): void {
	assert.doesNotMatch(text, /DBOS_SYSTEM_DATABASE_URL/);
	assert.doesNotMatch(text, /Postgres provisioning/i);
	assert.doesNotMatch(text, /local provisioning/i);
}

describe("DBOS registration diagnostics", () => {
	test("classifies a real SDK DBOSConflictingRegistrationError for both message variants", () => {
		const alreadyRegistered = realConflict(ALREADY_REGISTERED);
		const conflictingType = realConflict(CONFLICTING_TYPE);

		assert.equal(alreadyRegistered.dbosErrorCode, 25);
		assert.equal(conflictingType.dbosErrorCode, 25);
		assert.equal(alreadyRegistered.constructor.name, "DBOSConflictingRegistrationError");
		assert.equal(conflictingType.constructor.name, "DBOSConflictingRegistrationError");
		assert.equal(classifyDbosDurabilityFailure(alreadyRegistered), "duplicate_registration");
		assert.equal(classifyDbosDurabilityFailure(conflictingType), "duplicate_registration");
	});

	test("classifies a nested cause, a code-only duck type, and a name-only duck type without instanceof", () => {
		const wrapped = new Error("DBOS workflow durability configuration failed", {
			cause: realConflict(ALREADY_REGISTERED),
		});
		const named = new Error("unrelated wording");
		named.name = "DBOSConflictingRegistrationError";
		const cyclic = new Error("cycle");
		cyclic.cause = cyclic;

		assert.equal(classifyDbosDurabilityFailure(wrapped), "duplicate_registration");
		assert.equal(classifyDbosDurabilityFailure({ dbosErrorCode: 25 }), "duplicate_registration");
		assert.equal(classifyDbosDurabilityFailure(named), "duplicate_registration");
		assert.equal(classifyDbosDurabilityFailure(cyclic), "other");
	});

	test("falls back to both SDK already-registered message shapes when code and name are absent", () => {
		assert.equal(classifyDbosDurabilityFailure({ message: ALREADY_REGISTERED }), "duplicate_registration");
		assert.equal(classifyDbosDurabilityFailure({ message: CONFLICTING_TYPE }), "duplicate_registration");
		assert.equal(
			classifyDbosDurabilityFailure({ message: "Data source with name foo is already registered" }),
			"other",
		);
	});

	test("classifies a plain Error and a connection error as other", () => {
		assert.equal(classifyDbosDurabilityFailure(new Error("plain failure")), "other");
		assert.equal(classifyDbosDurabilityFailure(new Error("connect failed with ECONNREFUSED")), "other");
	});

	test("a throwing getter on cause, name, or message classifies as other without escaping", () => {
		const causeTrap = new Error("initdb: error: cannot be run as root");
		Object.defineProperty(causeTrap, "cause", {
			get() {
				throw new Error("cause getter trap");
			},
		});
		const nameTrap = {
			get name(): string {
				throw new Error("name getter trap");
			},
			message: "plain failure",
		};
		const messageTrap = {
			get message(): string {
				throw new Error("message getter trap");
			},
		};

		assert.equal(classifyDbosDurabilityFailure(causeTrap), "other");
		assert.equal(classifyDbosDurabilityFailure(nameTrap), "other");
		assert.equal(classifyDbosDurabilityFailure(messageTrap), "other");
	});

	test("a throwing cause getter does not replace the original durability failure", async () => {
		const trap = new Error("initdb: error: cannot be run as root");
		Object.defineProperty(trap, "cause", {
			get() {
				throw new Error("cause getter trap");
			},
		});
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw trap;
		});

		await assert.rejects(getReadyDbosBackend(), (error: unknown) => {
			assert.ok(error instanceof DbosDurabilityError);
			assert.equal(
				error.message,
				`DBOS workflow durability configuration failed: initdb: error: cannot be run as root. ${PROVISIONING_GUIDANCE}`,
			);
			assert.doesNotMatch(error.message, /cause getter trap/);
			return true;
		});
	});

	test("a throwing message getter does not escape durability wrapping", async () => {
		const trap = {
			get message(): string {
				throw new Error("message getter trap");
			},
		};
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw trap;
		});

		await assert.rejects(getReadyDbosBackend(), (error: unknown) => {
			assert.ok(error instanceof DbosDurabilityError);
			assert.doesNotMatch(error.message, /message getter trap/);
			assert.match(error.message, /DBOS workflow durability configuration failed:/);
			assert.match(error.message, new RegExp(PROVISIONING_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			return true;
		});
	});

	test("does not statically import the SDK or use instanceof", async () => {
		const source = (await readText(CLASSIFIER_SOURCE)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		assert.doesNotMatch(source, /from ["']@dbos-inc\/dbos-sdk["']/);
		assert.doesNotMatch(source, /import\(["']@dbos-inc\/dbos-sdk["']\)/);
		assert.doesNotMatch(source, /\binstanceof\b/);
	});

	test("a registration conflict's durability message names the duplicate and omits provisioning guidance", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw realConflict(ALREADY_REGISTERED);
		});

		await assert.rejects(getReadyDbosBackend(), (error: unknown) => {
			assert.ok(error instanceof DbosDurabilityError);
			assert.match(error.message, /duplicate DBOS operation registration/i);
			assertNoProvisioningWording(error.message);
			return true;
		});
	});

	test("a genuine provisioning failure keeps its existing guidance verbatim", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw new Error("initdb: error: cannot be run as root");
		});

		await assert.rejects(getReadyDbosBackend(), (error: unknown) => {
			assert.ok(error instanceof DbosDurabilityError);
			assert.equal(
				error.message,
				`DBOS workflow durability configuration failed: initdb: error: cannot be run as root. ${PROVISIONING_GUIDANCE}`,
			);
			return true;
		});
	});

	test("the non-durable degradation warning names a registration conflict and omits provisioning guidance", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw realConflict(CONFLICTING_TYPE);
		});
		const warnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			const backend = await initializeDurableBackend();
			assert.equal(backend.persistent, false);
			const degradationWarnings = warnings.filter((message) => message.includes("NON-DURABLY"));
			assert.equal(degradationWarnings.length, 1);
			assert.match(degradationWarnings[0]!, /duplicate DBOS operation registration/i);
			assertNoProvisioningWording(degradationWarnings[0]!);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test("the non-durable degradation warning keeps provisioning guidance verbatim", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw new Error("initdb: error: cannot be run as root");
		});
		const warnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			const backend = await initializeDurableBackend();
			assert.equal(backend.persistent, false);
			const degradationWarnings = warnings.filter((message) => message.includes("NON-DURABLY"));
			assert.equal(degradationWarnings.length, 1);
			assert.match(degradationWarnings[0]!, new RegExp(PROVISIONING_RESTORE));
			assert.match(degradationWarnings[0]!, /initdb: error: cannot be run as root/);
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
