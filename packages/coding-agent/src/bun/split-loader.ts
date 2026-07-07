import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const APP_NAME = "atomic";

process.title = APP_NAME;
process.env.ATOMIC_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);

function readVersion(): string {
	try {
		const packageJsonPath = join(dirname(process.execPath), "package.json");
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

if (args[0] === "--version" || args[0] === "-v") {
	console.log(readVersion());
	process.exit(0);
}

const appPath = join(dirname(process.execPath), "app.js");
if (!existsSync(appPath)) {
	console.error(`Atomic startup error: missing app bundle at ${appPath}`);
	process.exit(1);
}

void import(pathToFileURL(appPath).href);
