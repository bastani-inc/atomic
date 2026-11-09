import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { getShellConfig } from "../../../utils/shell.ts";

/** `value` as one single-quoted bash word. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `path` the way bash on `platform` spells it: Git Bash's `/c/...` on Windows, unchanged elsewhere. */
export function bashPathOn(platform: NodeJS.Platform, path: string): string {
	if (platform !== "win32") return path;
	const drive = /^([a-zA-Z]):[\\/]/u.exec(path);
	const normalized = win32.normalize(path).replaceAll("\\", "/");
	return drive === null ? normalized : `/${drive[1]!.toLowerCase()}${normalized.slice(2)}`;
}

/** `path` the way bash on this platform spells it. */
export function bashPath(path: string): string {
	return bashPathOn(process.platform, path);
}

/** Where the `$ENVRC` of the build that set up the worktree at `root` is kept for the sessions working in it. */
export function sessionEnvrcPath(storeDir: string, root: string): string {
	const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
	return join(storeDir, "blueprint-env", `${key}.envrc`);
}

/**
 * The bash prefix that gives a command the variables the builds of the worktrees at `roots` wrote to `$ENVRC`:
 * undefined when none did. The files are sourced with every assignment exported, as a step sees them.
 */
export function sessionEnvironmentPrefix(storeDir: string, roots: Iterable<string>): string | undefined {
	const files = [...new Set([...roots].map((root) => sessionEnvrcPath(storeDir, root)))].filter((file) =>
		existsSync(file),
	);
	if (files.length === 0) return undefined;
	return ["set -a", ...files.map((file) => `. ${shellQuote(bashPath(file))}`), "set +a"].join("; ");
}

/**
 * The environment a process sees after bash sources the `$ENVRC` file at `envrcPath` with every assignment exported,
 * starting from `base`. Used where a step cannot source the file itself: PowerShell and GitHub Actions.
 */
export async function evaluateEnvrc(envrcPath: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
	const { shell, args, commandTransport } = getShellConfig();
	const script = [
		"set -ae",
		'. "$1"',
		"set +a",
		process.platform === "win32"
			? 'env -0; atomic_blueprint_native_path=$(cygpath -wp "$PATH"); printf \'PATH=%s\\0\' "$atomic_blueprint_native_path"'
			: "env -0",
	].join("\n");
	const byStdin = commandTransport === "stdin";
	const child = spawn(
		shell,
		byStdin ? [...args, "--", bashPath(envrcPath)] : [...args, script, "atomic-blueprint-envrc", bashPath(envrcPath)],
		{ env: base, stdio: [byStdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true },
	);
	if (byStdin) child.stdin?.end(script);
	const { stdout, stderr } = child;
	if (stdout === null || stderr === null) throw new Error("ENVRC evaluation started without output pipes");
	const chunks: Buffer[] = [];
	const errors: Buffer[] = [];
	stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
	stderr.on("data", (chunk: Buffer) => errors.push(chunk));
	const status = await new Promise<number | null>((settle, reject) => {
		child.once("error", reject);
		child.once("close", settle);
	});
	if (status !== 0) {
		throw new Error(
			`Sourcing the ENVRC file failed with status ${status}: ${Buffer.concat(errors).toString("utf8").trim()}`,
		);
	}
	const environment: NodeJS.ProcessEnv = {};
	for (const entry of Buffer.concat(chunks).toString("utf8").split("\0")) {
		const separator = entry.indexOf("=");
		if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return environment;
}
