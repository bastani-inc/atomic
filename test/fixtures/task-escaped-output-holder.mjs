import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

// A descendant that leaves the command's process group (`detached` calls setsid) but keeps its output pipe open,
// so stopping the command can kill the group yet never confirm that the output pipe closed.
if (process.argv.includes("--holder")) {
	// Stopping the command and closing its owner cannot reach the holder, and a test that fails before it reads the
	// holder's PID cannot kill it either. Exit on our own after twice the per-test budget, so no run leaks it.
	setTimeout(() => process.exit(0), 60_000);
} else {
	const holder = spawn(process.execPath, [import.meta.filename, "--holder"], { detached: true, stdio: "inherit" });
	holder.unref();
	holder.once("spawn", () => {
		const staging = `${process.argv[2]}.${process.pid}.tmp`;
		writeFileSync(staging, JSON.stringify({ parent: process.pid, holder: holder.pid }));
		renameSync(staging, process.argv[2]);
	});
	setInterval(() => {}, 1000);
}
