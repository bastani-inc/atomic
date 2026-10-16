import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";

const [path, mode] = process.argv.slice(-2);
const backend = await JournalDurableBackend.open(new SqliteRunJournal(path));
try {
	if (mode === "write") {
		backend.registerWorkflow({ workflowId: "process-run", name: "process", inputs: { text: "raw\u0000\ud800", values: [2, 1, 2] }, createdAt: 1, status: "running" });
		backend.recordCheckpoint({ kind: "tool", workflowId: "process-run", checkpointId: "tool", name: "tool", argsHash: "tool", output: { values: [2, 1, 2], text: "raw\u0000\ud800" }, completedAt: 2 });
		backend.recordCheckpoint({ kind: "ui", workflowId: "process-run", checkpointId: "ui", promptKind: "input", message: "raw question", promptHash: "ui", response: "answer", completedAt: 3 });
		backend.recordCheckpoint({ kind: "stage", workflowId: "process-run", checkpointId: "stage", name: "stage", replayKey: "stage", output: "done", completedAt: 4 });
		await backend.persistSummary("process-run", "verbatim summary", 3);
		backend.setWorkflowStatus("process-run", "completed", 0);
	}
	console.log(JSON.stringify({ catalog: await backend.prepareWorkflowCatalog(), checkpoints: backend.listCheckpoints("process-run"), handle: backend.getWorkflow("process-run") }));
} finally {
	await backend.close();
}
