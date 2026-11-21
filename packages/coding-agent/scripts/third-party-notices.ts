import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";

interface NoticePackageJson {
	readonly name?: string;
	readonly version?: string;
	readonly license?: string;
	readonly dependencies?: Record<string, string>;
	readonly optionalDependencies?: Record<string, string>;
}

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;
// Comments that carry attribution: what bundlers call legal comments, plus plain copyright lines.
const LEGAL_COMMENT_PATTERN =
	/copyright|\(c\)\s*\d|\u00a9|@license|@preserve|licensed under|spdx-license-identifier|under the [\w.-]+ licen[cs]e/i;
const SCRIPT_FILE_PATTERN = /\.[cm]?js$/;

/**
 * Legal comments of a source file. A bundle drops comments, and a package's prebuilt file can carry
 * notices of code it includes that its licence files do not repeat.
 */
export function legalComments(file: string): string[] {
	if (!SCRIPT_FILE_PATTERN.test(file)) return [];
	const program = parse(readFileSync(file, "utf-8"), {
		sourceType: "unambiguous",
		errorRecovery: true,
		allowReturnOutsideFunction: true,
	});
	// Line comments on consecutive lines read as one comment, as a block comment does.
	const groups: { text: string; lastLine: number; line: boolean }[] = [];
	for (const comment of program.comments ?? []) {
		const previous = groups.at(-1);
		const startLine = comment.loc?.start.line ?? 0;
		const endLine = comment.loc?.end.line ?? startLine;
		if (comment.type === "CommentLine" && previous?.line && previous.lastLine + 1 === startLine) {
			previous.text += `\n//${comment.value}`;
			previous.lastLine = endLine;
			continue;
		}
		groups.push({
			text: comment.type === "CommentBlock" ? `/*${comment.value}*/` : `//${comment.value}`,
			lastLine: endLine,
			line: comment.type === "CommentLine",
		});
	}
	return [...new Set(groups.map((group) => group.text).filter((text) => LEGAL_COMMENT_PATTERN.test(text)))];
}

/** The installed package directory that holds `file`, or undefined for a file outside node_modules. */
export function installedPackageDir(file: string): string | undefined {
	const parts = resolve(file).split(sep);
	const index = parts.lastIndexOf("node_modules");
	if (index === -1 || index + 1 >= parts.length - 1) return undefined;
	const nameLength = parts[index + 1]?.startsWith("@") ? 2 : 1;
	return parts.slice(0, index + 1 + nameLength).join(sep);
}

function readPackageJson(packageDir: string): NoticePackageJson | undefined {
	const path = join(packageDir, "package.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as NoticePackageJson) : undefined;
}

/** Node's lookup of `name` from `fromDir`: the nearest node_modules/<name> in it or an ancestor. */
function resolveDependencyDir(fromDir: string, name: string): string | undefined {
	for (let directory = fromDir; ; directory = dirname(directory)) {
		const candidate = join(directory, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(directory) === directory) return undefined;
	}
}

/**
 * Every package whose code a bundle may contain: the packages its inputs come from and, because a
 * package can ship a prebuilt file of its own dependencies, the installed dependencies of each.
 */
export function bundledPackageDirs(inputFiles: readonly string[]): string[] {
	const pending = [...new Set(inputFiles.map(installedPackageDir).filter((dir) => dir !== undefined))];
	const seen = new Set<string>();
	while (pending.length > 0) {
		const packageDir = pending.pop();
		if (packageDir === undefined || seen.has(packageDir)) continue;
		const packageJson = readPackageJson(packageDir);
		if (packageJson === undefined) continue;
		seen.add(packageDir);
		for (const name of Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies })) {
			const dependencyDir = resolveDependencyDir(packageDir, name);
			if (dependencyDir !== undefined) pending.push(dependencyDir);
		}
	}
	return [...seen];
}

/**
 * The text of a THIRD_PARTY_NOTICES file for a bundle built from `inputFiles`: each bundled
 * package's name, version and license, followed by its licence and notice files. Undefined when
 * the bundle includes no installed package.
 */
export function thirdPartyNotices(bundleName: string, inputFiles: readonly string[]): string | undefined {
	const inputsByPackage = new Map<string, string[]>();
	for (const file of inputFiles) {
		const packageDir = installedPackageDir(file);
		if (packageDir !== undefined) inputsByPackage.set(packageDir, [...(inputsByPackage.get(packageDir) ?? []), file]);
	}
	const sections = new Map<string, string>();
	for (const packageDir of bundledPackageDirs(inputFiles)) {
		const packageJson = readPackageJson(packageDir);
		if (!packageJson?.name || !packageJson.version) continue;
		const id = `${packageJson.name}@${packageJson.version}`;
		const files = readdirSync(packageDir)
			.filter((name) => LICENSE_FILE_PATTERN.test(name) && statSync(join(packageDir, name)).isFile())
			.sort();
		const body = files.map((name) => `--- ${name} ---\n\n${readFileSync(join(packageDir, name), "utf-8").trimEnd()}\n`);
		for (const input of (inputsByPackage.get(packageDir) ?? []).sort()) {
			const comments = legalComments(input);
			if (comments.length === 0) continue;
			const name = relative(packageDir, input).split(sep).join("/");
			body.push(`--- Notices in ${name} ---\n\n${comments.join("\n\n")}\n`);
		}
		sections.set(id, [`== ${id} (${packageJson.license ?? "see package"}) ==\n`, ...body].join("\n"));
	}
	if (sections.size === 0) return undefined;
	const ordered = [...sections].sort(([a], [b]) => a.localeCompare(b)).map(([, section]) => section);
	return [
		`${bundleName} includes code from the following packages. Their licence and notice files follow.\n`,
		...ordered,
	].join("\n");
}
