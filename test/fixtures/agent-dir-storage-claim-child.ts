import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { claimFileAtomically } from "../../packages/coding-agent/src/core/storage/file-identity.js";

const [file, ready, start, contents] = process.argv.slice(2);
if (file === undefined || ready === undefined || start === undefined || contents === undefined) {
	throw new Error("Expected claim, ready, start paths and claim contents");
}
writeFileSync(ready, "ready");
const deadline = Date.now() + 30_000;
while (!existsSync(start)) {
	if (Date.now() >= deadline) throw new Error("The claim race did not start");
	await delay(10);
}
console.log(JSON.stringify({ claimed: claimFileAtomically(file, contents), contents }));
