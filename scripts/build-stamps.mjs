// Content-hash stamps that let `npm run build` skip a step whose inputs and outputs are unchanged.
//
// A step's input hash covers the content of every input file plus caller-supplied keys (toolchain
// versions, environment variables, upstream output fingerprints). Its output fingerprint covers the
// path, size and modification time of every output file, so a deleted, added or rewritten output
// forces the step to run again. A stamp is written only after the step succeeds.
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const STAMP_VERSION = 1;

/** Directory names never walked as inputs: dependencies, build output and VCS metadata. */
const SKIPPED_INPUT_DIRECTORIES = new Set([".git", "node_modules", "dist", "target"]);

/**
 * @typedef {object} PathSpec
 * @property {string} path Repository-relative path, using `/` separators.
 * @property {(relativePath: string) => boolean} [exclude] Skips matching repository-relative files.
 * @property {(relativePath: string) => boolean} [match] Keeps only matching repository-relative files.
 */

/** @param {string | PathSpec} spec @returns {PathSpec} */
function normalizeSpec(spec) {
	return typeof spec === "string" ? { path: spec } : spec;
}

/**
 * Lists every file below `spec.path` as sorted repository-relative paths, or `undefined` when the path is missing.
 * @param {string} root
 * @param {PathSpec} spec
 * @param {ReadonlySet<string>} skippedDirectories
 * @returns {string[] | undefined}
 */
function listFiles(root, spec, skippedDirectories) {
	const absolute = join(root, spec.path);
	const stats = statSync(absolute, { throwIfNoEntry: false });
	if (!stats) return undefined;
	/** @type {string[]} */
	const files = [];
	/** @param {string} relative */
	const keep = (relative) => (!spec.match || spec.match(relative)) && !spec.exclude?.(relative);
	if (!stats.isDirectory()) {
		if (keep(spec.path)) files.push(spec.path);
		return files;
	}
	/** @param {string} relativeDir */
	const visit = (relativeDir) => {
		for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
			const relative = `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!skippedDirectories.has(entry.name)) visit(relative);
			} else if (keep(relative)) {
				files.push(relative);
			}
		}
	};
	visit(spec.path);
	return files.sort();
}

/** @param {string} absolute */
function hashFile(absolute) {
	const stats = lstatSync(absolute, { throwIfNoEntry: false });
	if (!stats) return "missing";
	if (stats.isSymbolicLink()) return `link:${readlinkSync(absolute)}`;
	if (!stats.isFile()) return "special";
	return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

/**
 * Hashes the content of every input file together with `keys`.
 * A missing input path contributes a marker, so creating it later changes the hash.
 * @param {string} root
 * @param {ReadonlyArray<string | PathSpec>} specs
 * @param {Record<string, string | undefined>} [keys]
 * @returns {string}
 */
export function hashInputs(root, specs, keys = {}) {
	const hash = createHash("sha256");
	hash.update(
		`stamp-v${STAMP_VERSION}\0${JSON.stringify(Object.entries(keys).sort(([a], [b]) => (a < b ? -1 : 1)))}\n`,
	);
	for (const raw of specs) {
		const spec = normalizeSpec(raw);
		const files = listFiles(root, spec, SKIPPED_INPUT_DIRECTORIES);
		if (!files) {
			hash.update(`${spec.path}\0<missing>\n`);
			continue;
		}
		for (const file of files) hash.update(`${file}\0${hashFile(join(root, file))}\n`);
	}
	return hash.digest("hex");
}

/**
 * Fingerprints output files by path, size and modification time.
 * @param {string} root
 * @param {ReadonlyArray<string | PathSpec>} specs
 * @returns {{ hash: string, missing: string[] }}
 */
export function fingerprintOutputs(root, specs) {
	const hash = createHash("sha256");
	/** @type {string[]} */
	const missing = [];
	for (const raw of specs) {
		const spec = normalizeSpec(raw);
		const files = listFiles(root, spec, new Set());
		if (!files || files.length === 0) {
			missing.push(spec.path);
			continue;
		}
		for (const file of files) {
			const stats = lstatSync(join(root, file), { bigint: true });
			hash.update(`${file}\0${stats.size}\0${stats.mtimeNs}\n`);
		}
	}
	return { hash: hash.digest("hex"), missing };
}

/**
 * @typedef {object} Stamp
 * @property {number} version
 * @property {string} inputHash
 * @property {string} outputHash
 * @property {number} builtAt When the step last ran, in milliseconds since the epoch.
 */

/** @param {string} path @returns {Stamp | undefined} */
export function readStamp(path) {
	if (!existsSync(path)) return undefined;
	try {
		const stamp = JSON.parse(readFileSync(path, "utf8"));
		return stamp?.version === STAMP_VERSION ? stamp : undefined;
	} catch {
		return undefined;
	}
}

/** @param {string} path @param {{ inputHash: string, outputHash: string, builtAt: number }} stamp */
export function writeStamp(path, stamp) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: STAMP_VERSION, ...stamp }, null, "\t")}\n`);
}

/** @param {string} path */
export function removeStamp(path) {
	rmSync(path, { force: true });
}

/**
 * Decides whether a step must run. `reason` is undefined when the step is up to date.
 * `incremental` is true only when the previous outputs are intact, so incremental tool state
 * (such as a tsBuildInfo file) still describes them and may be reused. A step with `maxAgeMs`, whose
 * output also depends on data fetched from outside the repository, reruns once its stamp is older than
 * that or dated after `now`, and `stale` is then true.
 * @param {{ force: boolean, stamp: Stamp | undefined, inputHash: string, outputs: { hash: string, missing: string[] }, maxAgeMs?: number, now?: number }} state
 * @returns {{ reason: string | undefined, incremental: boolean, stale?: true }}
 */
export function decideStep({ force, stamp, inputHash, outputs, maxAgeMs, now = Date.now() }) {
	if (force) return { reason: "forced", incremental: false };
	if (!stamp) return { reason: "no stamp", incremental: false };
	if (outputs.missing.length > 0) return { reason: `missing output ${outputs.missing[0]}`, incremental: false };
	if (stamp.outputHash !== outputs.hash) return { reason: "outputs changed since the last build", incremental: false };
	if (stamp.inputHash !== inputHash) return { reason: "inputs changed", incremental: true };
	// A stamp dated in the future (the clock moved back) is stale too, so it cannot stay fresh indefinitely.
	const age = now - stamp.builtAt;
	if (maxAgeMs !== undefined && !(age >= 0 && age <= maxAgeMs)) {
		return { reason: `older than ${formatAge(maxAgeMs)}`, incremental: true, stale: true };
	}
	return { reason: undefined, incremental: true };
}

/** @param {number} ms */
export function formatAge(ms) {
	const hours = ms / 3_600_000;
	return hours >= 1 ? `${Math.round(hours)} h` : `${Math.round(ms / 60_000)} min`;
}
