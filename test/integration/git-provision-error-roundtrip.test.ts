import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	findGitProvisionError,
	GitProvisionTimeoutError,
	GitUnavailableError,
	isGitProvisionTimeoutError,
	isGitUnavailableError,
	isRetryableGitProvisionError,
	rehydrateGitProvisionError,
	type SerializedGitProvisionError,
} from "../../packages/coding-agent/src/utils/git-errors.js";
import type { GitToolStatus } from "../../packages/coding-agent/src/utils/tools-manager.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const CHILD = join(moduleDir(import.meta.url), "fixtures", "git-provision-error-child.ts");
/** Starts a Bun process that loads the coding-agent sources. */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;

test(
	"git errors produced in another process rehydrate as the same classes with fields and causes (#4322)",
	() => {
		const root = makeTempDirectory("atomic-git-error-roundtrip-");
		try {
			const child = spawnSyncCollect([bunExecutable(), CHILD], {
				env: {
					...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")),
					ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
					ATOMIC_OFFLINE: "1",
					PATH: root,
				},
			});
			assert.equal(child.exitCode, 0, child.stderr.toString());
			const wire = JSON.parse(child.stdout.toString()) as {
				offline: SerializedGitProvisionError;
				timeout: SerializedGitProvisionError;
				status: GitToolStatus;
			};

			const offline = rehydrateGitProvisionError(wire.offline);
			assert.ok(offline instanceof GitUnavailableError);
			assert.ok(isGitUnavailableError(wire.offline));
			assert.equal(offline.code, "offline");
			assert.equal(offline.platform, process.platform);
			assert.deepEqual(offline.fields, {
				code: "offline",
				offlineVariable: "ATOMIC_OFFLINE",
				platform: process.platform,
				arch: process.arch,
			});
			assert.equal(offline.message, wire.offline.message);
			assert.equal(
				offline.hint,
				"Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2.30.0 or newer.",
			);

			const timeout = rehydrateGitProvisionError(wire.timeout);
			assert.ok(timeout instanceof GitProvisionTimeoutError);
			assert.ok(isGitProvisionTimeoutError(timeout));
			assert.deepEqual(timeout.fields, { phase: "download", timeoutMs: 600_000, elapsedMs: 600_004 });
			assert.ok(isRetryableGitProvisionError(timeout));
			const download = timeout.cause;
			assert.ok(download instanceof GitUnavailableError);
			assert.equal(download.code, "download-failed");
			assert.equal(findGitProvisionError(new Error("wrapper", { cause: download })), download);
			const network = download.cause as Error & { cause?: Error & { code?: string } };
			assert.equal(network.name, "TypeError");
			assert.equal(network.cause?.code, "ENOTFOUND");

			assert.equal(wire.status.source, "unavailable");
			if (wire.status.source === "unavailable") {
				const reason = rehydrateGitProvisionError(wire.status.error);
				assert.ok(reason instanceof GitUnavailableError);
				assert.equal(reason.code, "offline");
			}
		} finally {
			removeTempDirectory(root);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS,
);
