// @ts-check
/**
 * Builds the ref under test once, on a Crabbox runner, into a relocatable tarball that every node receives
 * byte-for-byte. The tarball holds the source tree at the resolved SHA with `node_modules` from `npm ci --ignore-scripts`
 * and the outputs of `npm run build`; `.git` and Rust `target` directories are left out.
 */

export const ARTIFACT_REMOTE_DIR = "/tmp/atomic-distributed-test-build";

/**
 * The shell script the Crabbox runner executes. It installs the toolchain the repository's build needs when the runner
 * lacks it, fetches exactly `sha` from `repository`, builds, packs and prints the archive's SHA-256 on its last line.
 * @param {{ sha: string, repository: string, nodeVersion: string, bunVersion: string }} input
 */
export function artifactBuildScript({ sha, repository, nodeVersion, bunVersion }) {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new TypeError("artifactBuildScript needs a full lowercase commit SHA");
	return [
		"set -euo pipefail",
		"if ! command -v cc >/dev/null || ! command -v zstd >/dev/null; then sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq build-essential pkg-config unzip zstd git >/dev/null; fi",
		'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"',
		`if [ "$(node --version 2>/dev/null)" != "${nodeVersion}" ]; then mkdir -p "$HOME/.local/node" && curl -fsSL https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-x64.tar.xz | tar -xJ -C "$HOME/.local/node" --strip-components=1; fi`,
		`if [ "$(bun --version 2>/dev/null)" != "${bunVersion}" ]; then curl -fsSL https://bun.sh/install | bash -s "bun-v${bunVersion}" >/dev/null; fi`,
		"if ! command -v cargo >/dev/null; then curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null; fi",
		`rm -rf ${ARTIFACT_REMOTE_DIR} && mkdir -p ${ARTIFACT_REMOTE_DIR}/atomic && cd ${ARTIFACT_REMOTE_DIR}/atomic`,
		`git init -q . && git remote add origin ${repository}`,
		`git fetch -q --depth 1 origin ${sha} && git checkout -q FETCH_HEAD`,
		`test "$(git rev-parse HEAD)" = "${sha}"`,
		"npm ci --ignore-scripts --no-audit --no-fund >/tmp/adt-npm-ci.log 2>&1 || { tail -40 /tmp/adt-npm-ci.log; exit 1; }",
		"npm run build >/tmp/adt-build.log 2>&1 || { tail -60 /tmp/adt-build.log; exit 1; }",
		`printf '{"sha":"%s","node":"%s","builtAt":"%s"}\\n' ${sha} "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .atomic-distributed-artifact.json`,
		"rm -rf .git",
		"find . -type d -name target -prune -path '*/crates/*' -exec rm -rf {} + 2>/dev/null || true",
		"rm -rf target packages/natives/target",
		`cd ${ARTIFACT_REMOTE_DIR} && tar -I 'zstd -T0 -6' -cf atomic.tar.zst atomic`,
		`sha256sum ${ARTIFACT_REMOTE_DIR}/atomic.tar.zst | cut -d' ' -f1`,
	].join("\n");
}
