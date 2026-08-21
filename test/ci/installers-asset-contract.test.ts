import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { jobBlock, readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const archivePattern = /atomic-(?:darwin|linux|windows)-[a-z0-9-]+\.(?:tar\.gz|zip)/gu;

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

function exactArchives(source: string): string[] {
	return sorted(new Set(source.match(archivePattern) ?? []));
}

test("release builders, uploader, and installers agree on the exact archive asset set", async () => {
	const [buildScript, publishWorkflow, shellInstaller, powershellInstaller] = await Promise.all([
		readText(`${root}/scripts/build-binaries.sh`),
		readText(`${root}/.github/workflows/publish.yml`),
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

	const stageRelease = jobBlock(publishWorkflow, "stage-github-release", "publish-npm");
	const uploadDeclaration = /assets=\(([^)]+)\)/u.exec(stageRelease);
	assert.ok(uploadDeclaration, "stage-github-release must declare its upload list explicitly");
	const uploadedAssets = sorted((uploadDeclaration[1] as string).trim().split(/\s+/u));
	const uploadedArchives = uploadedAssets.filter((asset) => asset !== "SHA256SUMS");

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
	assert.deepEqual(uploadedArchives, builtArchives);
	assert.deepEqual(installerArchives, builtArchives);
	assert.deepEqual(uploadedAssets, sorted([...installerArchives, "SHA256SUMS"]));
	assert.equal(uploadedAssets.filter((asset) => asset === "SHA256SUMS").length, 1);
	assert.match(shellInstaller, /CHECKSUM_FILE=SHA256SUMS/u);
	assert.match(powershellInstaller, /"SHA256SUMS"/u);
	assert.ok(shellArchives.every((asset) => asset.endsWith(".tar.gz")));
	assert.ok(powershellArchives.every((asset) => asset.endsWith(".zip")));
});
