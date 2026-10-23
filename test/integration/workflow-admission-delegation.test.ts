import assert from "node:assert/strict";
import { join } from "node:path";
import { type AgentSession, createAgentSession, SessionManager } from "@bastani/atomic";
import { test } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { poolStageOptions } from "../fixtures/pool-stage-options.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const DELEGATED_SESSION_SETUP_TIMEOUT_MS = 120_000;
test.each([1, 2])(
	"actual delegated sessions reject when %s permits are held by parents (#3869)",
	async (cap) => {
		const directory = makeTempDirectory("admission-delegation-");
		const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
		const admission = await SqlResourceAdmission.open(journal, {
			root: "root",
			holder: "parents",
			limits: { session: cap },
		});
		const sessions: AgentSession[] = [];
		try {
			const options = await poolStageOptions(directory, false, 0);
			for (let i = 0; i < cap; i++) {
				const { session } = await createAgentSession({
					...options,
					sessionManager: SessionManager.inMemory(directory),
					resourceAdmission: admission,
				});
				sessions.push(session);
			}
			await assert.rejects(
				createAgentSession({
					...options,
					...sessions[0]!.extensionRunner.createContext().getChildSessionOptions!({ cwd: directory }),
					sessionManager: SessionManager.inMemory(directory),
					resourceAdmissionSignal: AbortSignal.timeout(2000),
				}),
				/Delegated session cannot be admitted.*headroom/,
			);
			const permits = await admission.inspect();
			assert.equal(permits.filter((row) => row.state === "granted").length, cap);
			assert.equal(permits.filter((row) => row.state === "waiting").length, 0);
		} finally {
			await Promise.all(sessions.map((session) => session.dispose()));
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	DELEGATED_SESSION_SETUP_TIMEOUT_MS,
);
