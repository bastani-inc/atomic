import { readdirSync, readlinkSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (path) => jiti.import(fileURLToPath(new URL(path, import.meta.url)));
const { openLibsqlDatabase } = await load("./storage-libsql-wrapper.ts");
const { collectReleasedLibsqlStatements, makeLibsqlDirectory, removeLibsqlDirectory } = await load(
	"../helpers/libsql-cleanup.ts",
);

function descriptorsInto(directory) {
	const descriptors = "/proc/self/fd";
	let entries;
	try {
		entries = readdirSync(descriptors);
	} catch {
		return undefined;
	}
	return entries
		.map((entry) => {
			try {
				return readlinkSync(join(descriptors, entry));
			} catch {
				return "";
			}
		})
		.filter((target) => target === directory || target.startsWith(directory + sep));
}

const directory = makeLibsqlDirectory("libsql-wrapper-close-releases-");
const file = join(directory, "released.db");
try {
	const database = await openLibsqlDatabase({ url: pathToFileURL(file).href });
	await database.exec("CREATE TABLE t (x)");
	await database.transaction((transaction) => transaction.run("INSERT INTO t VALUES (?)", 1));
	await database.get("SELECT x FROM t");
	await collectReleasedLibsqlStatements();
	await collectReleasedLibsqlStatements();
	await database.close();
	const held = descriptorsInto(directory);
	if (held === undefined) rmSync(file);
	else if (held.length > 0) throw new Error(`close() resolved while the process still held ${held.join(", ")}`);
} finally {
	await removeLibsqlDirectory(directory);
}
process.stdout.write("closed\n");
