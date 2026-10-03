import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI, PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";

const PROVISIONING_FAILURE = "initdb: error: cannot be run as root";

afterEach(() => {
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test.sequential("ready database notice identifies provider and host without exposing credentials (#3416)", async () => {
	for (const provider of ["configured", "managed", "docker"]) {
		resetDbosLifecycleForTests();
		setDurableBackend(new InMemoryDurableBackend());
		const owner = getDbosProcessOwner();
		owner.state = "ready";
		owner.databaseDiagnostics = () => ({
			provider,
			url: "postgresql://alice:secret@db.example:5432/private?sslpassword=hidden#token",
		});
		const notifications: string[] = [];
		const state = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
		const ctx = { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } } as PiExecuteContext;
		await state.runtimeForContext(ctx).dispatch({ action: "list" });
		await state.runtimeForContext(ctx).dispatch({ action: "list" });
		assert.deepEqual(notifications, [
			`Workflow database: ${provider === "docker" ? "Docker fallback" : provider} (db.example:5432)`,
		]);
	}
});

test.sequential("headless sessions write only the Docker fallback notice to stderr (#3416)", async () => {
	for (const provider of ["configured", "managed", "docker"]) {
		resetDbosLifecycleForTests();
		setDurableBackend(new InMemoryDurableBackend());
		const owner = getDbosProcessOwner();
		owner.state = "ready";
		owner.databaseDiagnostics = () => ({ provider, url: "postgresql://user:password@localhost/db" });
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const notifications: string[] = [];
		try {
			const state = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
			await state.runtimeForContext({ hasUI: false } as PiExecuteContext).dispatch({ action: "list" });
			await state.runtimeProxy.dispatch({ action: "list" });
			const ui = { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } };
			await state.runtimeForContext(ui as PiExecuteContext).dispatch({ action: "list" });
			if (provider === "docker") {
				assert.deepEqual(stderr.mock.calls, [["Workflow database: Docker fallback (localhost)"]]);
				assert.deepEqual(notifications, []);
			} else {
				assert.deepEqual(stderr.mock.calls, []);
				assert.deepEqual(notifications, [`Workflow database: ${provider} (localhost)`]);
			}
		} finally {
			stderr.mockRestore();
		}
	}
});

test.sequential("database notice retries a failed UI delivery and is not repeated after reload (#3416)", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const owner = getDbosProcessOwner();
	owner.state = "ready";
	owner.databaseDiagnostics = () => ({ provider: "managed", url: "postgresql://user:password@localhost:5439/db" });
	const notifications: string[] = [];
	let notifyFails = true;
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string) => {
				if (notifyFails) throw new Error("UI unavailable");
				notifications.push(message);
			},
		},
	} as PiExecuteContext;
	const beforeReload = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
	await beforeReload.runtimeForContext(ctx).dispatch({ action: "list" });
	assert.deepEqual(notifications, []);
	notifyFails = false;
	await beforeReload.runtimeForContext(ctx).dispatch({ action: "list" });
	const afterReload = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
	await afterReload.runtimeForContext(ctx).dispatch({ action: "list" });
	assert.deepEqual(notifications, ["Workflow database: managed (localhost:5439)"]);
	owner.databaseDiagnostics = () => ({ provider: "docker", url: "postgresql://user:password@localhost:5432/db" });
	await afterReload.runtimeForContext(ctx).dispatch({ action: "list" });
	assert.deepEqual(notifications, [
		"Workflow database: managed (localhost:5439)",
		"Workflow database: Docker fallback (localhost:5432)",
	]);
});

describe("workflow durability degradation warning surface", () => {
	test.sequential("interactive and RPC actions notify the host without exposing the warning to model context", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw new Error(PROVISIONING_FAILURE);
		});
		const notifications: Array<{ message: string; severity: string | undefined }> = [];
		const modelMessages: unknown[] = [];
		const transcriptEntries: unknown[] = [];
		const consoleWarnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleWarnings.push(args.map(String).join(" "));
		});
		const pi = {
			sendMessage: (...args: unknown[]) => {
				modelMessages.push(args);
			},
			appendEntry: (...args: unknown[]) => {
				transcriptEntries.push(args);
				return undefined;
			},
			appendCustomMessageEntry: (...args: unknown[]) => {
				transcriptEntries.push(args);
				return undefined;
			},
		} as ExtensionAPI;
		const ctx = {
			hasUI: true,
			ui: {
				notify(message: string, severity?: "info" | "warning" | "error") {
					notifications.push({ message, severity });
				},
			},
		} as PiExecuteContext;
		try {
			const state = createWorkflowExtensionRuntimeState(pi, {} as never);
			const result = await state.runtimeForContext(ctx).dispatch({ action: "list" });

			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.severity, "warning");
			assert.match(notifications[0]?.message ?? "", /continuing NON-DURABLY/);
			assert.match(notifications[0]?.message ?? "", /cannot be run as root/);
			assert.equal(consoleWarnings.filter((message) => message.includes("NON-DURABLY")).length, 0);
			assert.deepEqual(modelMessages, []);
			assert.deepEqual(transcriptEntries, []);
			assert.doesNotMatch(JSON.stringify(result), /NON-DURABLY/);
			assert.doesNotMatch(renderWorkflowToolContent(result, { action: "list" }), /NON-DURABLY/);

			state.resetWorkflowDiscoveryForSession();
			const reconstructed = await state.runtimeForContext(ctx).dispatch({ action: "list" });
			assert.equal(notifications.length, 1);
			assert.doesNotMatch(JSON.stringify(reconstructed), /NON-DURABLY/);
			assert.doesNotMatch(renderWorkflowToolContent(reconstructed, { action: "list" }), /NON-DURABLY/);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("uses a newly available UI when in-flight initialization degrades", async () => {
		setDurableBackend(undefined);
		const started = deferred<void>();
		const initialization = deferred<never>();
		resetDbosLifecycleForTests(async () => {
			started.resolve();
			return await initialization.promise;
		});
		const notifications: Array<{ message: string; severity: string | undefined }> = [];
		const consoleWarnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleWarnings.push(args.map(String).join(" "));
		});
		const state = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
		try {
			const headlessDispatch = state.runtimeForContext({ hasUI: false } as PiExecuteContext).dispatch({
				action: "list",
			});
			await started.promise;
			const interactiveDispatch = state
				.runtimeForContext({
					hasUI: true,
					ui: {
						notify(message: string, severity?: "info" | "warning" | "error") {
							notifications.push({ message, severity });
						},
					},
				} as PiExecuteContext)
				.dispatch({ action: "list" });

			initialization.reject(new Error(PROVISIONING_FAILURE));
			await Promise.all([headlessDispatch, interactiveDispatch]);

			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.severity, "warning");
			assert.match(notifications[0]?.message ?? "", /continuing NON-DURABLY/);
			assert.equal(consoleWarnings.filter((message) => message.includes("NON-DURABLY")).length, 0);
		} finally {
			consoleSpy.mockRestore();
		}
	});
	test.sequential("uses the current UI and ignores a concurrent headless sink during degradation", async () => {
		setDurableBackend(undefined);
		const started = deferred<void>();
		const initialization = deferred<never>();
		resetDbosLifecycleForTests(async () => {
			started.resolve();
			return await initialization.promise;
		});
		const oldNotifications: string[] = [];
		const currentNotifications: string[] = [];
		const consoleWarnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleWarnings.push(args.map(String).join(" "));
		});
		const state = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
		try {
			const oldUiDispatch = state
				.runtimeForContext({
					hasUI: true,
					ui: { notify: (message: string) => oldNotifications.push(message) },
				} as PiExecuteContext)
				.dispatch({ action: "list" });
			await started.promise;
			const headlessDispatch = state.runtimeForContext({ hasUI: false } as PiExecuteContext).dispatch({
				action: "list",
			});
			const currentUiDispatch = state
				.runtimeForContext({
					hasUI: true,
					ui: { notify: (message: string) => currentNotifications.push(message) },
				} as PiExecuteContext)
				.dispatch({ action: "list" });

			initialization.reject(new Error(PROVISIONING_FAILURE));
			await Promise.all([oldUiDispatch, headlessDispatch, currentUiDispatch]);

			assert.deepEqual(oldNotifications, []);
			assert.equal(currentNotifications.length, 1);
			assert.match(currentNotifications[0] ?? "", /continuing NON-DURABLY/);
			assert.equal(consoleWarnings.filter((message) => message.includes("NON-DURABLY")).length, 0);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("print and headless actions retain one console diagnostic", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw new Error(PROVISIONING_FAILURE);
		});
		const notifications: string[] = [];
		const consoleWarnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleWarnings.push(args.map(String).join(" "));
		});
		const ctx = {
			hasUI: false,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		} as PiExecuteContext;
		try {
			const state = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
			const result = await state.runtimeForContext(ctx).dispatch({ action: "list" });

			assert.deepEqual(notifications, []);
			const degradationWarnings = consoleWarnings.filter((message) => message.includes("NON-DURABLY"));
			assert.equal(degradationWarnings.length, 1);
			assert.match(degradationWarnings[0] ?? "", /DBOS_SYSTEM_DATABASE_URL/);
			assert.doesNotMatch(JSON.stringify(result), /NON-DURABLY/);
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
