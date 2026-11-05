// @ts-check
/**
 * Builds the ref under test once, on a Crabbox runner, into a relocatable tarball that every node receives
 * byte-for-byte. The tarball holds the source tree at the resolved SHA with `node_modules` from `npm ci --ignore-scripts`
 * and the outputs of `npm run build`; `.git` and Rust `target` directories are left out.
 */

import { randomUUID } from "node:crypto";
import { shellQuote } from "./commands.mjs";

/** Every build gets its own directory under this root, so builds sharing one builder never touch each other's files. */
export const ARTIFACT_REMOTE_ROOT = "/tmp/atomic-distributed-test-build";

const REMOTE_DIR =
	/^\/tmp\/atomic-distributed-test-build\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A fresh build directory on the builder.
 * @param {string} [id]
 */
export function artifactRemoteDir(id = randomUUID()) {
	return checkedRemoteDir(`${ARTIFACT_REMOTE_ROOT}/${id}`);
}

/**
 * The archive a build in `remoteDir` produces, which the controller copies back.
 * @param {string} remoteDir
 */
export function artifactArchivePath(remoteDir) {
	return `${checkedRemoteDir(remoteDir)}/atomic.tar.zst`;
}

/**
 * Removes one build's directory and nothing else.
 * @param {string} remoteDir
 */
export function artifactCleanupScript(remoteDir) {
	return `rm -rf -- ${checkedRemoteDir(remoteDir)}`;
}

/** @param {string} remoteDir */
function checkedRemoteDir(remoteDir) {
	if (!REMOTE_DIR.test(remoteDir)) throw new TypeError(`not an artifact build directory: ${remoteDir}`);
	return remoteDir;
}

/**
 * The shell script the Crabbox runner executes. It installs the toolchain the repository's build needs when the runner
 * lacks it, fetches exactly `sha` from `repository` into `remoteDir`, which must not exist yet, builds, packs and
 * prints the archive's SHA-256 on its last line. Logs stay in `remoteDir` too.
 * @param {{ sha: string, repository: string, nodeVersion: string, bunVersion: string, remoteDir: string }} input
 */
export function artifactBuildScript({ sha, repository, nodeVersion, bunVersion, remoteDir }) {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new TypeError("artifactBuildScript needs a full lowercase commit SHA");
	const dir = checkedRemoteDir(remoteDir);
	return [
		"set -euo pipefail",
		"if ! command -v cc >/dev/null || ! command -v zstd >/dev/null; then sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq build-essential pkg-config unzip zstd git >/dev/null; fi",
		'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"',
		`if [ "$(node --version 2>/dev/null)" != "${nodeVersion}" ]; then mkdir -p "$HOME/.local/node" && curl -fsSL https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-x64.tar.xz | tar -xJ -C "$HOME/.local/node" --strip-components=1; fi`,
		`if [ "$(bun --version 2>/dev/null)" != "${bunVersion}" ]; then curl -fsSL https://bun.sh/install | bash -s "bun-v${bunVersion}" >/dev/null; fi`,
		"if ! command -v cargo >/dev/null; then curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null; fi",
		`mkdir -p ${ARTIFACT_REMOTE_ROOT} && mkdir ${dir} ${dir}/atomic && cd ${dir}/atomic`,
		`git init -q . && git remote add origin ${shellQuote(repository)}`,
		`git fetch -q --depth 1 origin ${sha} && git checkout -q FETCH_HEAD`,
		`test "$(git rev-parse HEAD)" = "${sha}"`,
		`npm ci --ignore-scripts --no-audit --no-fund >${dir}/npm-ci.log 2>&1 || { tail -40 ${dir}/npm-ci.log; exit 1; }`,
		`npm run build >${dir}/build.log 2>&1 || { tail -60 ${dir}/build.log; exit 1; }`,
		`printf '{"sha":"%s","node":"%s","builtAt":"%s"}\\n' ${sha} "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .atomic-distributed-artifact.json`,
		"rm -rf .git",
		"find . -type d -name target -prune -path '*/crates/*' -exec rm -rf {} + 2>/dev/null || true",
		"rm -rf target packages/natives/target",
		`cd ${dir} && tar -I 'zstd -T0 -6' -cf atomic.tar.zst atomic`,
		`sha256sum ${artifactArchivePath(dir)} | cut -d' ' -f1`,
	].join("\n");
}
