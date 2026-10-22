import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const archivePattern = /atomic-(?:darwin|linux|windows)-[a-z0-9-]+\.(?:tar\.gz|zip)/gu;

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

function exactArchives(source: string): string[] {
	return sorted(new Set(source.match(archivePattern) ?? []));
}

test("release builders and installers agree on the exact archive asset set", async () => {
	const [buildScript, shellInstaller, powershellInstaller] = await Promise.all([
		readText(`${root}/scripts/build-binaries.sh`),
		readText(`${root}/install.sh`),
		readText(`${root}/install.ps1`),
	]);

	const platformDeclaration = /^\s*PLATFORMS=\(([a-z0-9-]+(?:\s+[a-z0-9-]+)*)\)\s*$/mu.exec(buildScript);
	assert.ok(platformDeclaration, "build-binaries.sh must declare its default platform list explicitly");
	const platforms = (platformDeclaration[1] as string).trim().split(/\s+/u);
	assert.deepEqual(platforms, [
		"darwin-arm64",
		"darwin-x64",
		"linux-x64",
		"linux-arm64",
		"linux-x64-musl",
		"linux-arm64-musl",
		"windows-x64",
		"windows-arm64",
	]);
	const builtArchives = sorted(
		platforms.map((platform) => `atomic-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`),
	);

	const shellArchives = exactArchives(shellInstaller);
	const powershellArchives = exactArchives(powershellInstaller);
	const installerArchives = sorted(new Set([...shellArchives, ...powershellArchives]));

	assert.deepEqual(
		shellArchives,
		builtArchives.filter((asset) => asset.endsWith(".tar.gz")),
	);
	assert.deepEqual(
		powershellArchives,
		builtArchives.filter((asset) => asset.endsWith(".zip")),
	);
	assert.deepEqual(installerArchives, builtArchives);
	assert.match(shellInstaller, /CHECKSUM_FILE=SHA256SUMS/u);
	assert.match(powershellInstaller, /"SHA256SUMS"/u);
	assert.ok(shellArchives.every((asset) => asset.endsWith(".tar.gz")));
	assert.ok(powershellArchives.every((asset) => asset.endsWith(".zip")));
});

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function shellRequiredPayload(source: string): string[] {
	const files = /for required_file in ([^;]+); do/u.exec(source);
	const directories = /for required_directory in ([^;]+); do/u.exec(source);
	assert.ok(
		files && directories,
		"install.sh must name the payload files and directories it requires before skipping",
	);
	return sorted([...(files[1] as string).trim().split(/\s+/u), ...(directories[1] as string).trim().split(/\s+/u)]);
}

function powershellRequiredPayload(source: string): string[] {
	const quotedNames = (pattern: RegExp): string[] => {
		const match = pattern.exec(source);
		assert.ok(match, "install.ps1 must name the payload files and directories it requires before skipping");
		return [...(match[1] as string).matchAll(/"([^"]+)"/gu)].map((name) => name[1] as string);
	};
	return sorted([
		...quotedNames(/foreach \(\$requiredFile in @\(([^)]*)\)\)/u),
		...quotedNames(/foreach \(\$requiredDirectory in @\(([^)]*)\)\)/u),
	]);
}

function archiveStagesPayloadEntry(buildScript: string, entry: string): boolean {
	const entryToken = new RegExp(`(?:^|[\\s/"])${escapeRegExp(entry)}(?=["\\s]|$)`, "u");
	return buildScript
		.split("\n")
		.some((line) => /^\s*cp\b/u.test(line) && line.includes("binaries/$platform") && entryToken.test(line));
}

test("installers skip a download only when the installed payload has every companion the release archive stages", async () => {
	const [buildScript, loaderSource, shellInstaller, powershellInstaller] = await Promise.all([
		readText(`${root}/scripts/build-binaries.sh`),
		readText(`${root}/packages/coding-agent/src/bun/split-loader.ts`),
		readText(`${root}/install.sh`),
		readText(`${root}/install.ps1`),
	]);

	const shellRequired = shellRequiredPayload(shellInstaller);
	const powershellRequired = powershellRequiredPayload(powershellInstaller);
	assert.deepEqual(powershellRequired, shellRequired, "both installers must require the same payload entries");
	for (const entry of shellRequired) {
		assert.ok(archiveStagesPayloadEntry(buildScript, entry), `release archives do not stage ${entry}`);
	}
	for (const loaderEntry of ["package.json", "app.js"]) {
		assert.ok(shellRequired.includes(loaderEntry), `${loaderEntry} is read by the split loader at startup`);
		assert.ok(loaderSource.includes(`"${loaderEntry}"`), `the split loader no longer reads ${loaderEntry}`);
	}
});
