import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";

const [path, mode] = process.argv.slice(-2);
const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
try {
	if (mode === "write") {
		await backend.commitWorkflowRegistration({ workflowId: "process-run", name: "process", inputs: { text: "raw\u0000\ud800", values: [2, 1, 2] }, createdAt: 1, status: "running" });
		await backend.commitCheckpoint({ kind: "tool", workflowId: "process-run", checkpointId: "tool", name: "tool", argsHash: "tool", output: { values: [2, 1, 2], text: "raw\u0000\ud800" }, completedAt: 2 });
		await backend.commitCheckpoint({ kind: "ui", workflowId: "process-run", checkpointId: "ui", promptKind: "input", message: "raw question", promptHash: "ui", response: "answer", completedAt: 3 });
		await backend.commitCheckpoint({ kind: "stage", workflowId: "process-run", checkpointId: "stage", name: "stage", replayKey: "stage", output: "done", completedAt: 4 });
		await backend.persistSummary("process-run", "verbatim summary", 3);
		await backend.commitWorkflowStatus("process-run", "completed", 0);
	}
	console.log(JSON.stringify({ catalog: await backend.prepareWorkflowCatalog(), checkpoints: backend.listCheckpoints("process-run"), handle: backend.getWorkflow("process-run") }));
} finally {
	await backend.close();
}
