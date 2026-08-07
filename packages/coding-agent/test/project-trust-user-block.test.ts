import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ProjectTrustContext, UserBlockChange } from "../src/core/extensions/types.ts";
import { getOpenUserBlocks, subscribeUserBlocks } from "../src/core/extensions/user-blocks.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { captureRejection } from "./error-capture.ts";

const tempDirs: string[] = [];

function createUntrustedProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-trust-block-test-"));
	tempDirs.push(dir);
	// A context file is enough to make the trust prompt required.
	writeFileSync(join(dir, "AGENTS.md"), "# project\n");
	mkdirSync(join(dir, "agent"), { recursive: true });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	assert.deepEqual(getOpenUserBlocks(), []);
});

describe("project trust prompt block", () => {
	it("mints a project_trust block for the duration of the prompt", async () => {
		const cwd = createUntrustedProject();
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		let openDuringPrompt = -1;
		let reasonDuringPrompt: string | undefined;

		const projectTrustContext: ProjectTrustContext = {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: async (_title, options) => {
					openDuringPrompt = getOpenUserBlocks().length;
					reasonDuringPrompt = getOpenUserBlocks()[0]?.reason;
					return options[0];
				},
				confirm: noOpUIContext.confirm,
				input: noOpUIContext.input,
				notify: noOpUIContext.notify,
			},
		};

		try {
			await resolveProjectTrusted({
				cwd,
				trustStore: new ProjectTrustStore(join(cwd, "agent")),
				projectTrustContext,
			});
		} finally {
			unsubscribe();
		}

		assert.equal(openDuringPrompt, 1, "the prompt runs with exactly one open block");
		assert.equal(reasonDuringPrompt, "project_trust");
		assert.deepEqual(
			changes.map((change) => [change.type, change.label, change.reason]),
			[
				["agent_blocked", "Trust project folder?", "project_trust"],
				["agent_unblocked", "Trust project folder?", "project_trust"],
			],
		);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("releases the block when the prompt throws", async () => {
		const cwd = createUntrustedProject();
		const failure = new Error("host closed the prompt");
		const projectTrustContext: ProjectTrustContext = {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: () => Promise.reject(failure),
				confirm: noOpUIContext.confirm,
				input: noOpUIContext.input,
				notify: noOpUIContext.notify,
			},
		};

		const thrown = await captureRejection(async () => {
			await resolveProjectTrusted({
				cwd,
				trustStore: new ProjectTrustStore(join(cwd, "agent")),
				projectTrustContext,
			});
		});
		assert.equal(thrown, failure);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("opens no block when trust is already decided and no prompt is shown", async () => {
		const cwd = createUntrustedProject();
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		const trustStore = new ProjectTrustStore(join(cwd, "agent"));
		trustStore.set(cwd, true);

		try {
			const trusted = await resolveProjectTrusted({
				cwd,
				trustStore,
				projectTrustContext: {
					cwd,
					mode: "tui",
					hasUI: true,
					ui: {
						select: async () => {
							throw new Error("the prompt must not be shown");
						},
						confirm: noOpUIContext.confirm,
						input: noOpUIContext.input,
						notify: noOpUIContext.notify,
					},
				},
			});
			assert.equal(trusted, true);
		} finally {
			unsubscribe();
		}
		assert.deepEqual(changes, []);
	});
});

/**
 * The startup trust prompt mints a block, and no subscriber exists to hear it.
 *
 * This pins the boundary the Herdr docs describe rather than leaving it as
 * prose. `resolveProjectTrusted()` runs during resource loading, before any
 * `ExtensionRunner` is built — and under isolated interactive mode, in a
 * different process from the reporter entirely. Closing it needs pre-session
 * reporting or a host-to-child ownership handoff, neither of which Phase 1
 * defines. If a later phase adds one, this test is the one that should fail.
 */
describe("startup project trust reaches no extension subscriber", () => {
	it("mints the block but delivers no lifecycle event, because no runner exists yet", async () => {
		const cwd = createUntrustedProject();
		const registryChanges: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => registryChanges.push(change));
		let openDuringPrompt = 0;

		try {
			await resolveProjectTrusted({
				cwd,
				trustStore: new ProjectTrustStore(join(cwd, "agent")),
				projectTrustContext: {
					cwd,
					mode: "tui",
					hasUI: true,
					ui: {
						select: async (_title, options) => {
							openDuringPrompt = getOpenUserBlocks().length;
							return options[0];
						},
						confirm: noOpUIContext.confirm,
						input: noOpUIContext.input,
						notify: noOpUIContext.notify,
					},
				},
			});
		} finally {
			unsubscribe();
		}

		// B4 holds: the prompt really does open a project_trust block.
		assert.equal(openDuringPrompt, 1);
		assert.deepEqual(
			registryChanges.map((change) => [change.type, change.reason]),
			[
				["agent_blocked", "project_trust"],
				["agent_unblocked", "project_trust"],
			],
		);

		// And the boundary: the registry is the only observer. Nothing routed the
		// change to a `pi.on("agent_blocked")` handler, because extensions are not
		// bound until a session exists.
		assert.deepEqual(getOpenUserBlocks(), []);
	});
});
