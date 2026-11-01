import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

// A descendant that leaves the command's process group (`detached` calls setsid) but keeps its output pipe open,
// so stopping the command can kill the group yet never confirm that the output pipe closed.
if (process.argv.includes("--holder")) {
	setInterval(() => {}, 1000);
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
