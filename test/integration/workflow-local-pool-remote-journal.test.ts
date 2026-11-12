import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader } from "@bastani/atomic";
import { test } from "vitest";
import {
	fileFlavor,
	libsqlFlavor,
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
	REMOTE_JOURNAL_RESUME_TIMEOUT_MS,
	resumeCrashedRoot,
	runPooledRoot,
} from "../helpers/pooled-remote-root.js";

const delegating = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));

/**
 * An adapter that only implements the public RunJournal members, over a SQLite file every process opens by the same
 * selection: the pool cannot reach its tables in its own SQL transactions, as with a remote database.
 */
const delegatingFlavor = (name: string) => (directory: string) => {
	const path = join(directory, name);
	const log = join(directory, "appends.jsonl");
	return fileFlavor(path, { adapter: delegating, options: { path, log } }, { POOL_RESUME_JOURNAL: "adapter" }, log);
};

/**
 * The same adapter, listed in the manifest of a package the root's host loads through the SDK and selected by the
 * package's name. The pool's worker processes load no package: they get the resolved module from the root.
 */
const hostPackageFlavor = (name: string) => (directory: string) => {
	const root = join(directory, "host-app");
	mkdirSync(root);
	const packageName = "@atomic-test/pooled-host-app";
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: packageName, atomic: { storageAdapters: ["./journal.mjs"] } }),
	);
	writeFileSync(
		join(root, "journal.mjs"),
		`export { default } from ${JSON.stringify(pathToFileURL(delegating).href)};\n`,
	);
	new DefaultResourceLoader({
		cwd: directory,
		agentDir: join(directory, "home", "agent"),
		additionalExtensionPaths: [root],
	});
	const path = join(directory, name);
	const log = join(directory, "appends.jsonl");
	return fileFlavor(path, { adapter: packageName, options: { path, log } }, { POOL_RESUME_JOURNAL: "adapter" }, log);
};

/** The shipped libSQL adapter over a `file:` URL: a SQL journal on a driver that is not node:sqlite. */
const libsqlFileFlavor = (name: string) => (directory: string) => {
	const url = pathToFileURL(join(directory, name)).href;
	return libsqlFlavor(url, libsql, {
		resume: { POOL_RESUME_JOURNAL: "libsql", POOL_RESUME_LIBSQL_URL: url },
		shared: false,
	});
};

test.skipIf(process.platform === "win32").each([{ crash: false }, { crash: true }])(
	"a pooled root runs on a journal in another database, with a dead worker's child replayed from it=$crash",
	({ crash }) => runPooledRoot(delegatingFlavor("remote.sqlite"), { crash, label: "remote-journal-pool" }),
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pooled root runs on a journal adapter named by a package its host loaded, in workers that never load it (#4678)",
	() => runPooledRoot(hostPackageFlavor("remote.sqlite"), { crash: true, label: "host-package-journal-pool" }),
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pooled root runs on a libSQL file shared by its coordinator and workers, with a dead worker's child replayed from it",
	() => runPooledRoot(libsqlFileFlavor("remote.sqlite"), { crash: true, label: "libsql-file-pool" }),
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"resuming a crashed pooled root on a journal in another database replays its children from the journal and the coordination database (#3890)",
	() => resumeCrashedRoot(delegatingFlavor("journal.sqlite"), { label: "pool-remote-root-resume" }),
	REMOTE_JOURNAL_RESUME_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"resuming a crashed pooled root on a libSQL file replays its children",
	() => resumeCrashedRoot(libsqlFileFlavor("journal.sqlite"), { label: "pool-libsql-file-resume" }),
	REMOTE_JOURNAL_RESUME_TIMEOUT_MS,
);
