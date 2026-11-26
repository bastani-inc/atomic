#!/usr/bin/env node
// Updates a running process of each recorded release in place, and checks what it meets when it loads code on demand.
//
// For each release recorded in `packages/coding-agent/in-place-update/` (see its README.md), this installs the
// published release from npm, starts a Node process of it that has loaded what such a process has loaded once it is
// running (the SDK entry, which a session's extension loader imports, and the modules the CLI imports as it starts),
// then puts the packed build's packages in place of the release's own, as `npm install -g` does, and has the process
// import every module the release imports on demand by its path. Each must either load or fail with the message the
// application gives for code an update replaced ("<app> was updated to <version> while this session was running;
// restart it to keep using <feature>."; see `packages/coding-agent/scripts/in-place-update-gate.mjs`), and the
// modules a session loads for its own work (`CORE_MODULES`) must load.
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
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Modules a running session loads on demand for its own work, which must load after an update as they did before:
 * the worktree snapshot of a turn that writes files, `read` of a URL, a forked subagent, the private copy of an entry
 * over 1 MiB, and a subagent's completion card and task view. Only a package subpath the release cannot resolve and
 * `allowed.json` lists for it excuses one, which then says to restart.
 */
export const CORE_MODULES = [
	"dist/utils/tools-manager.js",
	"dist/core/tools/read-url.js",
	"dist/core/storage/session/fork-window.js",
	"dist/core/storage/session/jsonl-entry-projection.js",
	"dist/core/storage/session/expanded-child-details.js",
	"dist/core/tasks/task-view-source.js",
	"dist/core/tasks/task-file-history.js",
];

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
			outcomes[path] = {
				loaded: false,
				message: String(error?.message ?? error),
				cause: error?.cause === undefined ? undefined : String(error.cause.message ?? error.cause),
				causeCode: error?.cause?.code,
			};
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

/** The update: each of Atomic's packages under `prefix` is replaced by the build's in `tarballs`, where the install put it. */
function putBuildInPlace(prefix, tarballs, work) {
	for (const { name, dir } of installedPackageDirs(prefix)) {
		const unpacked = mkdtempSync(join(work, "unpacked-"));
		untar(tarballOf(tarballs, name), unpacked);
		const nested = join(dir, "node_modules");
		for (const entry of readdirSync(dir))
			if (join(dir, entry) !== nested) rmSync(join(dir, entry), { recursive: true });
		cpSync(join(unpacked, "package"), dir, { recursive: true });
	}
}

/**
 * Updates a running process of release `record` to the packages in `tarballs` (the build of `version`), in `work`.
 * `allowed` maps the package subpaths the release cannot resolve that the build may import to why (`allowed.json`).
 * Returns what went wrong; nothing when every module loaded or said to restart, and every core module loaded.
 *
 * @returns {Promise<string[]>}
 */
export async function updateRunningRelease(record, tarballs, version, work, allowed = {}) {
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
		putBuildInPlace(prefix, tarballs, work);
		child.stdin.write("updated\n");
		const outcomes = JSON.parse(await line(1));
		const restart = new RegExp(
			`^\\S+ was updated to ${version.replaceAll(".", "\\.")} while this session was running; restart it to keep using [^\\n]+\\.$`,
		);
		const problems = [];
		for (const [path, outcome] of Object.entries(outcomes)) {
			const modulePath = path.endsWith(".code.js")
				? `${path.slice(0, -".code.js".length)}.js`
				: path.endsWith(".impl.js")
					? `${path.slice(0, -".impl.js".length)}.js`
					: path;
			const excused =
				outcome.causeCode === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
				Object.keys(allowed).some((specifier) =>
					outcome.cause?.includes(`'./${specifier.split("/").slice(2).join("/")}'`),
				);
			if (CORE_MODULES.includes(modulePath) && !outcome.loaded && !(excused && restart.test(outcome.message)))
				problems.push(
					`${record.version}: ${path}, which a session loads for its own work, did not load: ${outcome.message}`,
				);
			else if (!outcome.loaded && !restart.test(outcome.message))
				problems.push(`${record.version}: ${path} failed without saying to restart: ${outcome.message}`);
		}
		if (process.env.ATOMIC_IN_PLACE_E2E_REPORT === "1")
			for (const [path, outcome] of Object.entries(outcomes))
				console.log(`${record.version} ${path}: ${outcome.loaded ? "loaded" : outcome.message.split("\n")[0]}`);
		return problems;
	} finally {
		// The process holds the release's native module open until it exits, and Windows refuses to remove a file held
		// open: the release's install goes once it has.
		child.kill();
		if (!exited) await new Promise((resolve) => child.once("exit", resolve));
		await rm(prefix, { recursive: true, force: true, maxRetries: 10 });
	}
}

/** The process of this build: it loads what a running one holds, waits for the update, then calls `calls`. */
const BUILD_HOST = `
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [packageDir, calls] = [process.argv[2], JSON.parse(process.argv[3])];
await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
const storage = await import(pathToFileURL(join(packageDir, "dist/core/storage/index.js")).href);
process.stdout.write("ready\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	if (line !== "updated") continue;
	const outcomes = {};
	for (const name of calls) {
		try {
			outcomes[name] = { returned: String(await storage[name]()) };
		} catch (error) {
			outcomes[name] = { message: String(error?.message ?? error), cause: error?.cause === undefined ? undefined : String(error.cause.message ?? error.cause) };
		}
	}
	process.stdout.write(JSON.stringify(outcomes) + "\\n");
	break;
}
process.exit(0);
`;

/**
 * Runs `host` (with `args`, and `env` for its environment) until it prints ready, then calls `update` and sends it
 * "updated"; its outcomes.
 */
async function runHost(host, args, cwd, update, env = process.env) {
	const child = spawn(process.execPath, [host, ...args], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
	let output = "";
	const lines = () => output.split("\n");
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	const line = async (index) => {
		for (;;) {
			if (lines().length > index + 1) return lines()[index];
			const settled = await Promise.race([
				exited.then(() => "exited"),
				new Promise((resolve) => setTimeout(resolve, 50)),
			]);
			if (settled === "exited" && lines().length <= index + 1) throw new Error(`the process exited: ${output}`);
		}
	};
	try {
		if ((await line(0)) !== "ready") throw new Error(`the process did not start: ${output}`);
		await update();
		child.stdin.write("updated\n");
		return JSON.parse(await line(1));
	} finally {
		child.kill();
		await exited;
	}
}

/**
 * Updates a running process of the packed build in `tarballs` (of `version`) to a later release whose code for some
 * modules the process loads on demand cannot load in it, and checks what its own call sites make of it: a module that
 * fails to link, and one whose code fails as it runs, say to restart with the failure as the cause; one that loads
 * gives the later release's code, as before; and in a process of the same release a failing module fails with its own
 * error. Returns what went wrong.
 *
 * @returns {Promise<string[]>}
 */
export async function updateRunningBuild(tarballs, version, repositoryRoot) {
	// Under the repository's node_modules, so that the build's packages find their dependencies as an install does.
	const base = join(repositoryRoot, "node_modules", ".cache", "atomic-in-place-update-e2e");
	mkdirSync(base, { recursive: true });
	const prefix = mkdtempSync(join(base, "build-"));
	try {
		for (const name of UPDATED_PACKAGES) {
			const dir = join(prefix, "node_modules", ...name.split("/"));
			mkdirSync(dir, { recursive: true });
			const unpacked = mkdtempSync(join(prefix, "unpacked-"));
			untar(tarballOf(tarballs, name), unpacked);
			cpSync(join(unpacked, "package"), dir, { recursive: true });
		}
		const packageDir = join(prefix, "node_modules", "@bastani", "atomic");
		const session = (module) => join(packageDir, "dist", "core", "storage", "session", module);
		/** The file holding module `module`'s code: beside its gate when the build gates it (`.impl.js` in 0.10.4). */
		const codeFile = (module) =>
			[".code.js", ".impl.js", ".js"]
				.map((suffix) => session(`${module.slice(0, -".js".length)}${suffix}`))
				.find((file) => existsSync(file));
		const host = join(prefix, "host.mjs");
		writeFileSync(host, BUILD_HOST);
		const manifestFile = join(packageDir, "package.json");
		const manifest = readFileSync(manifestFile, "utf8");
		const later = `${version}-later.1`;
		const calls = ["findInSessionHistory", "readSessionChildCatalog", "readExpandedChildDetails"];
		const failsToLink =
			'import { notAnExportOfAnyRelease } from "../../../config.js";\nexport const findInSessionHistory = () => notAnExportOfAnyRelease;\n';
		const failsAsItRuns =
			'throw new Error("written for another release");\nexport const readSessionChildCatalog = () => "never";\n';
		const loads = 'export const readExpandedChildDetails = () => "the later release";\n';
		const outcomes = await runHost(host, [packageDir, JSON.stringify(calls)], prefix, async () => {
			writeFileSync(manifestFile, manifest.replace(`"version": "${version}"`, `"version": "${later}"`));
			writeFileSync(codeFile("history-pages.js"), failsToLink);
			writeFileSync(codeFile("child-reader.js"), failsAsItRuns);
			writeFileSync(codeFile("expanded-child-details.js"), loads);
		});
		const restart = `atomic was updated to ${later} while this session was running; restart it to keep using session storage.`;
		const problems = [];
		const expect = (name, wanted, outcome) => {
			if (JSON.stringify(outcome) !== JSON.stringify(wanted))
				problems.push(
					`a running ${version} process updated to ${later}: ${name} gave ${JSON.stringify(outcome)}, not ${JSON.stringify(wanted)}`,
				);
		};
		const linkFailure = outcomes.findInSessionHistory?.cause;
		expect("findInSessionHistory", { message: restart, cause: linkFailure }, outcomes.findInSessionHistory);
		if (typeof linkFailure !== "string" || !linkFailure.includes("notAnExportOfAnyRelease"))
			problems.push(
				`a running ${version} process: the restart message's cause is not the link failure: ${linkFailure}`,
			);
		expect(
			"readSessionChildCatalog",
			{ message: restart, cause: "written for another release" },
			outcomes.readSessionChildCatalog,
		);
		expect("readExpandedChildDetails", { returned: "the later release" }, outcomes.readExpandedChildDetails);
		// A process of the release on disk: a module that fails is its own failure, not an update's.
		writeFileSync(manifestFile, manifest);
		const fresh = await runHost(
			host,
			[packageDir, JSON.stringify(["readSessionChildCatalog"])],
			prefix,
			async () => {},
		);
		expect(
			"readSessionChildCatalog in a process of the release on disk",
			{ message: "written for another release" },
			fresh.readSessionChildCatalog,
		);
		return problems;
	} finally {
		await rm(prefix, { recursive: true, force: true, maxRetries: 10 });
	}
}

/**
 * A process of an earlier release that forks a session after an update (`forkAfterUpdate`). With `setup`, it sets up
 * each database marked `earlier` through the release's own session store, writing one session, and exits. Otherwise it
 * loads what a running process holds, without the session store, which it loads on demand, and once updated opens each
 * database through the release's storage provider: it creates a session that starts with a worktree snapshot, forks
 * it, appends to both, the parent another snapshot, reads both, and opens the database again and reads them once more.
 * Then it deletes the parent and collects snapshot blobs through the snapshot store it holds, the release's, which knows
 * nothing of forks, and reads the fork and whether the blob of the snapshot it inherits is still there.
 */
const FORK_HOST = `
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [packageDir, config] = [process.argv[2], JSON.parse(process.argv[3])];
const load = (path) => import(pathToFileURL(join(packageDir, path)).href);
for (const path of config.held) await load(path);
const storage = await load("dist/core/storage/index.js");
const postgres = config.databases.some((each) => each.kind === "postgres")
	? await import("@bastani/atomic-storage-postgres")
	: undefined;
const open = (each) =>
	each.kind === "sqlite"
		? storage.openNodeSqliteDatabase(each.path)
		: postgres.openPostgresDatabase({ url: each.url, password: each.password });
const header = (id) => ({ id, version: 4, createdAt: "2026-11-01T00:00:00.000Z", cwd: "/project" });
const message = (id, parentId) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-11-01T00:00:00.000Z",
	message: { role: "user", content: id, timestamp: 1 },
});
const entries = (tag, count, parentId = null) => {
	const made = [];
	for (let index = 1; index <= count; index++) made.push(message(tag + "-" + index, made.at(-1)?.id ?? parentId));
	return made;
};
/** A snapshot blob whose bytes are \`text\`, and a snapshot entry \`id\` after \`parentId\` whose snapshot holds it. */
const blob = (text) => {
	const data = new TextEncoder().encode(text);
	return { hash: createHash("sha256").update(data).digest("hex"), data };
};
const snapshotEntry = (id, parentId, hash) => ({
	type: "worktree_snapshot",
	id,
	parentId,
	timestamp: "2026-11-01T00:00:00.000Z",
	root: "/project",
	snapshotId: "snapshot-" + id,
	snapshot: {
		version: 1,
		id: "snapshot-" + id,
		root: "/project",
		remotes: [],
		branch: "main",
		head: "a".repeat(40),
		snapshot: "b".repeat(40),
		tree: "c".repeat(40),
		envHash: "env",
		delta: { base: "head", patch: hash, bytes: 1 },
		chain: [{ tree: "d".repeat(40), patch: hash, bytes: 1 }],
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: "2026-11-01T00:00:00.000Z",
	},
});
/** The blob of the snapshot the fork inherits, and of the one its parent takes after the fork. */
const inherited = blob("the snapshot the fork inherits");
const later = blob("the snapshot the parent takes after the fork");
const ids = async (store, id) => (await store.load(id)).entries.map((entry) => entry.id);
async function withStore(each, body) {
	const database = await open(each);
	try {
		const store = await new storage.StorageProvider().openSessionStore(
			{ kind: "database", database },
			{ agentDir: config.agentDir },
		);
		try {
			return await body(store, database);
		} finally {
			await store.close();
		}
	} finally {
		await database.close();
	}
}
async function forkAndRead(each) {
	const outcome = {};
	await withStore(each, async (store, database) => {
		if (each.earlier) outcome.earlier = await ids(store, "earlier");
		// The parent's history starts with a snapshot, which the fork inherits, and takes another after the fork.
		await store.snapshotBlobs.putBlobs([inherited, later]);
		await store.create(header("parent"), [
			snapshotEntry("parent-1", null, inherited.hash),
			message("parent-2", "parent-1"),
			message("parent-3", "parent-2"),
		]);
		const head = await store.readEntrySizes("parent", 1, 0);
		// As the release's session manager forks a session: the stream of its history, from the module it loads on demand.
		const { completeSessionForkStream } = await load("dist/core/storage/session/branch-fork-source.code.js");
		const source = { store, sessionId: "parent", epoch: head.epoch, hashes: [], receipts: new Map() };
		const fork = await store.createFork(
			header("fork"),
			completeSessionForkStream("parent", head.epoch, head.lastSeq),
			source,
		);
		await store.append(
			"parent",
			[snapshotEntry("parent-after-1", "parent-3", later.hash), message("parent-after-2", "parent-after-1")],
			{ expectSeq: 3 },
		);
		await store.append("fork", entries("fork", 2, "parent-3"), { expectSeq: fork.lastSeq });
		outcome.parent = await ids(store, "parent");
		outcome.fork = await ids(store, "fork");
		const segments = await database.get("SELECT count(*) AS segments FROM session_fork_segments WHERE session_id = ?", "fork");
		outcome.segments = Number(segments.segments);
	});
	await withStore(each, async (store) => {
		outcome.reopened = { parent: await ids(store, "parent"), fork: await ids(store, "fork") };
	});
	// The parent goes, and the process collects snapshot blobs as its automatic collection does, with no grace: the
	// snapshot the fork inherits from it must stay, with its blob.
	await withStore(each, async (store) => {
		await store.delete("parent");
		await store.snapshotBlobs.collectGarbage({ graceSeconds: 0 });
		outcome.collected = {
			fork: await ids(store, "fork"),
			inheritedBlob: (await store.snapshotBlobs.getBlob(inherited.hash)) !== undefined,
		};
	});
	return outcome;
}
if (config.setup) {
	for (const each of config.databases.filter((each) => each.earlier))
		await withStore(each, (store) => store.create(header("earlier"), entries("earlier", 2)));
	process.exit(0);
}
process.stdout.write("ready\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	if (line !== "updated") continue;
	const outcomes = {};
	for (const each of config.databases) {
		try {
			outcomes[each.name] = await forkAndRead(each);
		} catch (error) {
			outcomes[each.name] = { error: String(error?.message ?? error), cause: error?.cause === undefined ? undefined : String(error.cause.message ?? error.cause) };
		}
	}
	process.stdout.write(JSON.stringify(outcomes) + "\\n");
	break;
}
process.exit(0);
`;

/** What each database reads after {@link FORK_HOST}'s fork: the parent and its fork, each with its own entries after. */
const FORKED = {
	parent: ["parent-1", "parent-2", "parent-3", "parent-after-1", "parent-after-2"],
	fork: ["parent-1", "parent-2", "parent-3", "fork-1", "fork-2"],
};

/**
 * A database {@link forkAfterUpdate} forks a session in: a SQLite file or a PostgreSQL database, each empty, named
 * `name` in what goes wrong. With `earlier`, the release sets it up first, before the update, and the process then
 * finds it as the release left it, with forks that copy their parent's history.
 *
 * @typedef {{ name: string, earlier: boolean } & ({ kind: "sqlite", path: string } | { kind: "postgres", url: string, password?: string })} ForkDatabase
 */

/**
 * Updates a running process of release `version`, installed from npm with its PostgreSQL adapter, in place to the
 * packages in `tarballs`, in `work`, and has it fork a session in each of `databases` (see {@link ForkDatabase}) through
 * the session store it then loads from the update: each fork must read its parent's history and its own entries, share
 * that history rather than copy it, and read the same once the database is opened again; once its parent is deleted
 * and the release's collection runs, the fork must still read it, and the blob of the snapshot it inherits must still
 * be there. Returns what went wrong.
 *
 * @param {string} version
 * @param {string} tarballs
 * @param {string} work
 * @param {readonly ForkDatabase[]} databases
 * @returns {Promise<string[]>}
 */
export async function forkAfterUpdate(version, tarballs, work, databases) {
	const prefix = mkdtempSync(join(work, `forks-${version}-`));
	try {
		writeFileSync(join(prefix, "package.json"), '{ "private": true }\n');
		run(
			npm,
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				`@bastani/atomic@${version}`,
				`@bastani/atomic-storage-postgres@${version}`,
			],
			prefix,
		);
		const packageDir = join(prefix, "node_modules", "@bastani", "atomic");
		const host = join(prefix, "host.mjs");
		writeFileSync(host, FORK_HOST);
		const agentDir = join(prefix, "agent");
		mkdirSync(agentDir);
		// A profile of its own: the process reads and writes no user's settings.
		const env = {
			...process.env,
			ATOMIC_OFFLINE: "1",
			ATOMIC_CODING_AGENT_DIR: agentDir,
			HOME: prefix,
			USERPROFILE: prefix,
		};
		const config = { held: ["dist/index.js", ...startImports(packageDir)], agentDir, databases };
		const setup = spawnSync(process.execPath, [host, packageDir, JSON.stringify({ ...config, setup: true })], {
			cwd: prefix,
			env,
			encoding: "utf8",
		});
		if (setup.status !== 0) throw new Error(`the ${version} process could not set up its databases: ${setup.stderr}`);
		const outcomes = await runHost(
			host,
			[packageDir, JSON.stringify(config)],
			prefix,
			async () => putBuildInPlace(prefix, tarballs, work),
			env,
		);
		const problems = [];
		for (const { name, earlier } of databases) {
			const outcome = outcomes[name];
			const where = `a running ${version} process updated in place, on ${name}`;
			if (outcome?.error !== undefined) {
				problems.push(`${where}: ${outcome.error}${outcome.cause === undefined ? "" : ` (${outcome.cause})`}`);
				continue;
			}
			const expect = (what, actual, wanted) => {
				if (JSON.stringify(actual) !== JSON.stringify(wanted))
					problems.push(`${where}: ${what} read ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
			};
			if (earlier) expect("the session the release wrote", outcome.earlier, ["earlier-1", "earlier-2"]);
			expect("the parent", outcome.parent, FORKED.parent);
			expect("the fork", outcome.fork, FORKED.fork);
			expect("the parent, opened again,", outcome.reopened?.parent, FORKED.parent);
			expect("the fork, opened again,", outcome.reopened?.fork, FORKED.fork);
			expect(
				"the fork, after its parent was deleted and snapshots collected,",
				outcome.collected?.fork,
				FORKED.fork,
			);
			if (outcome.collected?.inheritedBlob !== true)
				problems.push(
					`${where}: collection deleted the blob of the snapshot the fork inherits from its deleted parent`,
				);
			if (!(outcome.segments > 0))
				problems.push(`${where}: the fork copied its parent's history instead of sharing it`);
		}
		return problems;
	} finally {
		await rm(prefix, { recursive: true, force: true, maxRetries: 10 });
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
	const allowedFile = join(recordsDir, "allowed.json");
	const allowed = existsSync(allowedFile) ? JSON.parse(readFileSync(allowedFile, "utf8")) : {};
	const work = mkdtempSync(join(tmpdir(), "atomic-in-place-update-e2e-"));
	const unpacked = mkdtempSync(join(work, "build-"));
	untar(tarballOf(tarballs, "@bastani/atomic"), unpacked);
	const version = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8")).version;
	let ok = true;
	try {
		const ownProblems = await updateRunningBuild(tarballs, version, fileURLToPath(new URL("..", import.meta.url)));
		for (const problem of ownProblems) console.error(problem);
		if (ownProblems.length > 0) ok = false;
		else
			console.log(
				`A process of ${version} updated in place to a later release says to restart where its code cannot load.`,
			);
		for (const record of records) {
			mkdirSync(work, { recursive: true });
			const problems = await updateRunningRelease(record, tarballs, version, work, allowed[record.version]);
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
