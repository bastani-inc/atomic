import { tryAdvisoryLock } from "@bastani/atomic-natives";

const lock = tryAdvisoryLock(process.argv[2]!, 0);
if (lock === null) throw new Error("creation lock is already held");
const deadline = setTimeout(() => {
	lock.release();
	process.stdin.pause();
	process.exitCode = 1;
}, 20_000);
process.stdin.once("data", () => {
	clearTimeout(deadline);
	lock.release();
	process.stdin.pause();
});
console.log("ready");
