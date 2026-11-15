// A host that starts a supervised shell with a 2 s execution timeout, waits until the shell and a `timeout`-wrapped
// descendant (in its own process group) have written their PIDs, then dies the way the test asks: `sigkill` waits to
// be SIGKILLed, `throw` crashes with an uncaught exception, `exit` calls process.exit(1).
//   node task-host-death.mjs <directory> <sigkill|throw|exit> <pipe|pty>
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as native from "@bastani/atomic-natives";

const [directory, how, terminal] = process.argv.slice(2);
const supervisor = new native.TaskSupervisor();
const scope = { kind: "session", sessionId: crypto.randomUUID() };
const owner = supervisor.openTaskOwner(supervisor.bindHostSession(scope), scope);
const started = await supervisor.startCommandTask(
	owner.value,
	{
		kind: "command",
		command: `echo $$ > '${directory}/shell'; timeout 300 sh -c 'echo $$ > "$1"; exec sleep 300' sh '${directory}/inner'`,
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
