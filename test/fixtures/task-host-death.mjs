// A host that starts a supervised shell with a 2 s execution timeout, waits until the shell and a `timeout`-wrapped
// descendant (in its own process group) have written their PIDs, then dies the way the test asks: `sigkill` waits to
// be SIGKILLed, `throw` crashes with an uncaught exception, `exit` calls process.exit(1).
// `guardian-first` SIGKILLs the guardian that ends shells when the host dies, then waits to be SIGKILLed itself.
// With the `hopper` shape the descendant keeps forking a replacement and exiting, and `inner` holds its process group.
//   node task-host-death.mjs <directory> <sigkill|throw|exit|guardian-first> <pipe|pty> [timeout|job-control|hopper]
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as native from "@bastani/atomic-natives";

const [directory, how, terminal, shape] = process.argv.slice(2);
const hopper = fileURLToPath(new URL("./task-hopper.py", import.meta.url));
const descendants = {
	hopper: `python3 '${hopper}' '${directory}/hop' 0.01 >/dev/null 2>&1 & while [ ! -s '${directory}/hop.pgid' ]; do sleep 0.01; done; cp '${directory}/hop.pgid' '${directory}/inner'; sleep 300`,
	"job-control": `exec /bin/bash -c 'set -m; sleep 300 >/dev/null 2>&1 & echo $! > "$1"; wait' bash '${directory}/inner'`,
	timeout: `timeout 300 sh -c 'echo $$ > "$1"; exec sleep 300' sh '${directory}/inner'`,
};
const descendant = descendants[shape ?? "timeout"];
const supervisor = new native.TaskSupervisor();
const scope = { kind: "session", sessionId: crypto.randomUUID() };
const owner = supervisor.openTaskOwner(supervisor.bindHostSession(scope), scope);
const started = await supervisor.startCommandTask(
	owner.value,
	{
		kind: "command",
		command: `echo $$ > '${directory}/shell'; ${descendant}`,
		terminal: terminal === "pty" ? { kind: "pty", columns: 80, rows: 24 } : { kind: "pipe" },
		executionTimeoutMs: 2000,
	},
	"host-death",
);
if (!started.ok) throw new Error(started.error.message);
setInterval(() => {}, 1000);
while (!existsSync(join(directory, "shell")) || !existsSync(join(directory, "inner")))
	await new Promise((resolve) => setTimeout(resolve, 10));
await new Promise((resolve) => setTimeout(resolve, 50));
writeFileSync(join(directory, "ready"), String(Date.now()));
if (how === "throw")
	setTimeout(() => {
		throw new Error("simulated crash");
	});
if (how === "exit") process.exit(1);
