import { Markdown } from "@earendil-works/pi-tui";
import { APP_NAME, PACKAGE_NAME, VERSION } from "./config.ts";
import { getMarkdownTheme } from "./modes/interactive/theme/theme.ts";
import { getLatestPiRelease, isNewerPackageVersion, type LatestPiRelease } from "./utils/version-check.ts";

export interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	shouldRun: boolean;
	note?: string;
}

export function buildSelfUpdatePlan(release: LatestPiRelease, force = false): SelfUpdatePlan {
	const packageName = release.packageName ?? PACKAGE_NAME;
	return {
		packageName,
		installSpec: `${packageName}@${release.version}`,
		version: release.version,
		shouldRun: force || packageName !== PACKAGE_NAME || isNewerPackageVersion(release.version, VERSION),
		...(release.note ? { note: release.note } : {}),
	};
}

export async function resolveSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	let release: LatestPiRelease | undefined;
	try {
		release = await getLatestPiRelease();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not determine latest ${APP_NAME} version: ${message}`);
	}
	if (!release) throw new Error(`Could not determine latest ${APP_NAME} version.`);
	return buildSelfUpdatePlan(release, force);
}

export function renderSelfUpdateNote(note: string, width = process.stdout.columns ?? 80): string | undefined {
	const trimmed = note.trim();
	if (!trimmed) return undefined;
	try {
		return new Markdown(trimmed, 0, 0, getMarkdownTheme())
			.render(Math.max(20, width))
			.map((line) => line.trimEnd())
			.join("\n");
	} catch {
		return trimmed;
	}
}
