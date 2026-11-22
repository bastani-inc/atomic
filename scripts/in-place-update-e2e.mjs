#!/usr/bin/env node
// Updates a running process of each recorded release in place, and checks what it meets when it loads code on demand.
//
// For each release recorded in `packages/coding-agent/in-place-update/` (see its README.md), this installs the
// published release from npm, starts a Node process of it that has loaded what such a process has loaded once it is
// running (the SDK entry, which a session's extension loader imports, and the modules the CLI imports as it starts),
// then puts the packed build's packages in place of the release's own, as `npm install -g` does, and has the process
// import every module the release imports on demand by its path. Each must either load or fail with the message the
// application gives for code an update replaced ("<app> was updated to <version> while this session was running;
// restart it to keep using <feature>."), and the modules `/export` loads must fail with it: those are the gated
// modules (`packages/coding-agent/scripts/in-place-update-gate.mjs`), which a process of an earlier release reaches
// only to be told to restart.
//
// Usage:
//   node scripts/in-place-update-e2e.mjs <records-dir> <tarball-dir> [<version>...]
//
// `<tarball-dir>` holds the build's packages as `npm pack` names them (`bastani-atomic-<version>.tgz`, ...). Without
// versions, every recorded release is updated.
import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Atomic's packages an update puts in place: the application first. */
export const UPDATED_PACKAGES = [
	"@bastani/atomic",
	"@bastani/atomic-ai",
	"@bastani/atomic-agent-core",
	"@bastani/atomic-tui",
	"@bastani/atomic-codemode",
	"@bastani/atomic-schema",
	"@bastani/atomic-telemetry",
];

/** The modules `/export` loads on demand. */
export const EXPORT_MODULES = ["dist/core/export-html/index.js", "dist/core/export-html/tool-renderer.js"];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** The process of the earlier release: it loads what a running one holds, waits for the update, then loads `targets`. */
const HOST = `
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { basename, join } from "node:path";
const [packageDir, held, targets] = [process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4])];
const load = (path) => import(pathToFileURL(join(packageDir, path)).href);
for (const path of held) await load(path);
process.stdout.write("ready\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	if (line !== "updated") continue;
	const outcomes = {};
	for (const path of targets) {
		try {
			await load(path);
			outcomes[path] = { loaded: true };
		} catch (error) {
			outcomes[path] = { loaded: false, message: String(error?.message ?? error), code: error?.code };
		}
	}
	process.stdout.write(JSON.stringify(outcomes) + "\\n");
	break;
}
process.exit(0);
`;

/** The directories of Atomic's packages under `root`'s node_modules, wherever the package manager put them. */
function installedPackageDirs(root) {
	const found = [];
	const visit = (nodeModules) => {
		if (!existsSync(nodeModules)) return;
		for (const entry of readdirSync(nodeModules)) {
			if (entry === "@bastani") {
				for (const name of readdirSync(join(nodeModules, entry))) {
					const dir = join(nodeModules, entry, name);
					if (UPDATED_PACKAGES.includes(`@bastani/${name}`)) found.push({ name: `@bastani/${name}`, dir });
					visit(join(dir, "node_modules"));
				}
			} else if (!entry.startsWith(".")) {
				visit(join(nodeModules, entry, "node_modules"));
			}
		}
	};
	visit(join(root, "node_modules"));
	return found;
}

/**
 * Unpacks the tarball `file` into the directory `into`, from a copy there named without a directory: GNU tar, which Git
 * for Windows puts on PATH, takes `C:` in a path for a remote host and does not read `\\` as a separator.
 */
function untar(file, into) {
	copyFileSync(file, join(into, basename(file)));
	const result = spawnSync("tar", ["-xzf", basename(file)], { cwd: into });
	rmSync(join(into, basename(file)));
	if (result.status !== 0) throw new Error(`could not unpack ${file}: ${result.stderr}`);
}

/** The tarball of package `name` in `dir`, as `npm pack` names it. */
function tarballOf(dir, name) {
	const prefix = `${name.slice(1).replace("/", "-")}-`;
	const tarball = readdirSync(dir).find((file) => file.startsWith(prefix) && /^\d/.test(file.slice(prefix.length)));
	if (tarball === undefined) throw new Error(`no tarball of ${name} in ${dir}`);
	return join(dir, tarball);
}

/** What a module of release `record` imports on demand by its path, in `@bastani/atomic`. */
function lazyTargets(record) {
	const prefix = "@bastani/atomic:";
	return Object.keys(record.packages["@bastani/atomic"]?.lazy ?? {})
		.filter((key) => key.startsWith(prefix))
		.map((key) => key.slice(prefix.length));
}

/** The modules the release's CLI imports on demand as it starts: a running session has loaded them. */
function startImports(packageDir) {
	const cli = readFileSync(join(packageDir, "dist", "cli.js"), "utf8");
	return [...cli.matchAll(/\bimport\(\s*"\.\/([^"]+)"\s*\)/g)].map((match) => `dist/${match[1]}`);
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout;
}

/**
 * Updates a running process of release `record` to the packages in `tarballs` (the build of `version`), in `work`.
 * Returns what went wrong; nothing when every module loaded or said to restart.
 *
 * @returns {Promise<string[]>}
 */
export async function updateRunningRelease(record, tarballs, version, work) {
	const prefix = mkdtempSync(join(work, `release-${record.version}-`));
	writeFileSync(join(prefix, "package.json"), '{ "private": true }\n');
	run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@bastani/atomic@${record.version}`], prefix);
	const packageDir = join(prefix, "node_modules", "@bastani", "atomic");
	const host = join(prefix, "host.mjs");
	writeFileSync(host, HOST);
	const held = ["dist/index.js", ...startImports(packageDir)];
	const targets = lazyTargets(record);
	const child = spawn(process.execPath, [host, packageDir, JSON.stringify(held), JSON.stringify(targets)], {
		cwd: prefix,
		stdio: ["pipe", "pipe", "inherit"],
		// A profile of its own: the process reads and writes no user's settings.
		env: {
			...process.env,
			ATOMIC_OFFLINE: "1",
			ATOMIC_CODING_AGENT_DIR: join(prefix, "agent"),
			HOME: prefix,
			USERPROFILE: prefix,
		},
	});
	let output = "";
	/** @type {(() => void)[]} */
	const waiting = [];
	child.stdout.on("data", (chunk) => {
		output += chunk;
		for (const check of waiting.splice(0)) check();
	});
	let exited = false;
	child.on("exit", () => {
		exited = true;
		for (const check of waiting.splice(0)) check();
	});
	/** Line `index` of what the process printed. */
	const line = (index) =>
		new Promise((resolve, reject) => {
			const check = () => {
				const lines = output.split("\n");
				if (lines.length > index + 1) resolve(lines[index]);
				else if (exited) reject(new Error(`the ${record.version} process exited: ${output}`));
				else waiting.push(check);
			};
			check();
		});
	try {
		if ((await line(0)) !== "ready") throw new Error(`the ${record.version} process did not start: ${output}`);
		// The update: each of Atomic's packages is replaced by the build's, where the release's install put it.
		for (const { name, dir } of installedPackageDirs(prefix)) {
			const unpacked = mkdtempSync(join(work, "unpacked-"));
			untar(tarballOf(tarballs, name), unpacked);
			const nested = join(dir, "node_modules");
			for (const entry of readdirSync(dir))
				if (join(dir, entry) !== nested) rmSync(join(dir, entry), { recursive: true });
			cpSync(join(unpacked, "package"), dir, { recursive: true });
		}
		child.stdin.write("updated\n");
		const outcomes = JSON.parse(await line(1));
		const restart = new RegExp(
			`^\\S+ was updated to ${version.replaceAll(".", "\\.")} while this session was running; restart it to keep using [^\\n]+\\.$`,
		);
		const problems = [];
		for (const [path, outcome] of Object.entries(outcomes)) {
			if (outcome.loaded) {
				if (EXPORT_MODULES.includes(path))
					problems.push(`${record.version}: ${path} loaded in a process of ${record.version} after the update`);
				continue;
			}
			if (!restart.test(outcome.message))
				problems.push(`${record.version}: ${path} failed without saying to restart: ${outcome.message}`);
		}
		for (const path of EXPORT_MODULES)
			if (targets.includes(path) && !/ to keep using session export\.$/.test(outcomes[path]?.message ?? ""))
				problems.push(`${record.version}: /export does not say to restart: ${outcomes[path]?.message}`);
		return problems;
	} finally {
		child.kill();
	}
}

async function main(argv) {
	const [recordsDir, tarballs, ...versions] = argv;
	if (recordsDir === undefined || tarballs === undefined) {
		console.error("Usage: in-place-update-e2e.mjs <records-dir> <tarball-dir> [<version>...]");
		return 2;
	}
	const records = readdirSync(recordsDir)
		.filter((file) => /^\d.*\.json$/.test(file))
		.map((file) => JSON.parse(readFileSync(join(recordsDir, file), "utf8")))
		.filter((record) => versions.length === 0 || versions.includes(record.version));
	const work = mkdtempSync(join(tmpdir(), "atomic-in-place-update-e2e-"));
	const unpacked = mkdtempSync(join(work, "build-"));
	untar(tarballOf(tarballs, "@bastani/atomic"), unpacked);
	const version = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8")).version;
	let ok = true;
	try {
		for (const record of records) {
			mkdirSync(work, { recursive: true });
			const problems = await updateRunningRelease(record, tarballs, version, work);
			for (const problem of problems) console.error(problem);
			if (problems.length > 0) ok = false;
			else console.log(`A process of ${record.version} updated in place to ${version} loads or says to restart.`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
