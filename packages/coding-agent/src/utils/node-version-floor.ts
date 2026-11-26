/**
 * The oldest Node.js an npm install of Atomic runs on: the floor of package.json's `engines.node`. npm only warns when
 * the running Node.js is older, and Atomic would then fail later with an error that does not name the cause, so the CLI
 * refuses it at startup instead. The release archive runs on the Bun runtime it bundles, which this does not check.
 */
export const MINIMUM_NODE_VERSION = "24.20.0";

/** The installation guide's section on which Node.js version Atomic needs and how to upgrade. */
export const NODE_VERSION_GUIDE_URL = "https://docs.bastani.ai/getting-started/installation#nodejs-version";

function versionParts(version: string): readonly number[] {
	return version
		.replace(/^v/, "")
		.split(/[.+-]/, 3)
		.map((part) => Number.parseInt(part, 10) || 0);
}

/** The message refusing this runtime when it is Node.js older than `MINIMUM_NODE_VERSION`, otherwise `undefined`. */
export function unsupportedNodeVersionMessage(versions: NodeJS.ProcessVersions): string | undefined {
	// Bun reports the Node.js version it is compatible with, not one Atomic's floor is about.
	if (versions.bun !== undefined) return undefined;
	const running = versionParts(versions.node);
	const floor = versionParts(MINIMUM_NODE_VERSION);
	for (let index = 0; index < floor.length; index++) {
		const difference = (running[index] ?? 0) - (floor[index] ?? 0);
		if (difference > 0) return undefined;
		if (difference < 0) {
			return [
				`Atomic needs Node.js ${MINIMUM_NODE_VERSION} or newer, but this is Node.js ${versions.node}.`,
				"Install the current Node.js 24 LTS release, then reinstall Atomic with `npm install -g @bastani/atomic`.",
				`See ${NODE_VERSION_GUIDE_URL}`,
			].join("\n");
		}
	}
	return undefined;
}
