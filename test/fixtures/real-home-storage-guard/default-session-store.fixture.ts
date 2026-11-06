import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveSessionStore } from "../../../packages/coding-agent/src/core/session-storage.js";
import { RealHomeStorageOpenError } from "../../helpers/real-home-storage-guard.js";
import { OPT_OUT_ENV, OUTCOME_ENV } from "./run-fixture.js";

export interface DefaultSessionStoreOutcome {
	readonly opened: boolean;
	readonly agentDir?: string;
	readonly failure?: { readonly name: string; readonly guardCode?: string; readonly guardPath?: string };
}

/**
 * Open the session store at its default location, the fallback `/workflow resume <unknown id>` takes (#4445), and
 * record what happened. The test catches every failure, so only the guard's own check can fail it.
 */
test("opens the default session store", async () => {
	if (process.env[OPT_OUT_ENV] === "1") delete process.env.ATOMIC_CODING_AGENT_DIR;
	const agentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	const project = mkdtempSync(join(tmpdir(), "atomic-real-home-guard-project-"));
	const outcome: DefaultSessionStoreOutcome = await resolveSessionStore(project)
		.then(
			async (store) => {
				await store.close();
				return { opened: true, agentDir };
			},
			(error: Error) => ({
				opened: false,
				agentDir,
				failure: {
					name: error.name,
					...(error.cause instanceof RealHomeStorageOpenError
						? { guardCode: error.cause.code, guardPath: error.cause.path }
						: {}),
				},
			}),
		)
		.finally(() => rmSync(project, { recursive: true, force: true }));
	writeFileSync(process.env[OUTCOME_ENV]!, JSON.stringify(outcome));
});
