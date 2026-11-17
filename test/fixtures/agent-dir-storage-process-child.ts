import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import type { Settings } from "../../packages/coding-agent/src/core/settings-types.js";
import { setCliStorageSelection } from "../../packages/coding-agent/src/core/storage/process-selection.js";
import { type RunJournalSettings, resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";

const [agentDir, settingsJson, mode, runId, cliJson] = process.argv.slice(2);
if (
	agentDir === undefined || settingsJson === undefined || runId === undefined ||
	(mode !== "write" && mode !== "read" && mode !== "select-session")
) {
	throw new Error("Expected agent directory, settings JSON, write/read/select-session mode and run ID");
}
if (cliJson !== undefined) setCliStorageSelection({ flag: "--storage", value: cliJson });
const settings = JSON.parse(settingsJson) as Settings & RunJournalSettings;
if (mode === "select-session") {
	console.log(JSON.stringify(selectSessionStorage(agentDir, { agentDir, settings })));
} else {
	const journal = await resolveRunJournal({ agentDir, settings });
	try {
		if (mode === "write") {
			await journal.createRun({ runId, name: "wf", cwd: agentDir, createdAt: 1, status: "running" });
		}
		console.log(JSON.stringify((await journal.listRuns()).map((run) => run.runId).sort()));
	} finally {
		await journal.close();
	}
}
