import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { getAgentDir } from "../../../packages/coding-agent/src/config.js";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.js";
import { isRealHomeAccessError } from "../../helpers/real-home-storage-guard.js";
import { OPT_OUT_ENV, OUTCOME_ENV } from "./run-fixture.js";

export interface DefaultSettingsOutcome {
	readonly agentDir: string;
	readonly errors: readonly { readonly name: string; readonly guardCode?: string; readonly guardPath?: string }[];
}

/**
 * Load the agent settings from wherever the agent directory resolves, as every session, workflow journal and CLI
 * entry does (#4473), and record what happened. The settings manager keeps a failed read as a load error instead of
 * throwing, so only the guard's own check can fail this test.
 */
test("loads the default agent settings", () => {
	if (process.env[OPT_OUT_ENV] === "1") delete process.env.ATOMIC_CODING_AGENT_DIR;
	const project = mkdtempSync(join(tmpdir(), "atomic-real-home-guard-project-"));
	try {
		const errors = SettingsManager.create(project)
			.drainErrors()
			.map(({ error }) => ({
				name: error.name,
				...(isRealHomeAccessError(error) ? { guardCode: error.code, guardPath: error.path } : {}),
			}));
		const outcome: DefaultSettingsOutcome = { agentDir: getAgentDir(), errors };
		writeFileSync(process.env[OUTCOME_ENV]!, JSON.stringify(outcome));
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});
