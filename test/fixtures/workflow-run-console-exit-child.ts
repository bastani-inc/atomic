import { routeWorkflowConsoleOutput } from "../../packages/workflows/src/engine/run-console.js";
import { openRunRejectionScope } from "../../packages/workflows/src/engine/run-rejection-boundary.js";

/**
 * Routes a run's console output to the workflow log under the directory named by its argument, logs three lines from
 * the run and exits in the same tick, before the log's writer can run. Usage: workflow-run-console-exit-child.ts <dir>
 */
const [directory] = process.argv.slice(2);
if (directory === undefined) throw new Error("usage: workflow-run-console-exit-child.ts <directory>");
routeWorkflowConsoleOutput(directory);
openRunRejectionScope({ runId: "exiting-run", consoleLog: true, fail: () => {} }).run(() => {
	for (let index = 1; index <= 3; index += 1) console.error(`line ${index}`);
});
process.exit(0);
