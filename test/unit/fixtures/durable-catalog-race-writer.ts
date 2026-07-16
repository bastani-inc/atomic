import { writeFileSync } from "node:fs";
import { WorkflowFileDurableBackend } from "../../../packages/workflows/src/durable/file-backend.js";

const [durableDir, workflowId, startedFile, doneFile] = process.argv.slice(2);
if (durableDir === undefined || workflowId === undefined
  || startedFile === undefined || doneFile === undefined) {
  throw new Error("Expected durable directory, workflow id, and signal paths");
}

writeFileSync(startedFile, "started\n");
const backend = new WorkflowFileDurableBackend(durableDir);
backend.setWorkflowStatus(workflowId, "failed", 0, true);
writeFileSync(doneFile, "done\n");
