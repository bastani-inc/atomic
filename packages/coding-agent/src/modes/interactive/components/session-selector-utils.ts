import { canonicalizePath, getPathComparisonKey, shortenHomePath } from "../../../utils/paths.ts";

export function shortenPath(path: string): string {
	return shortenHomePath(path);
}

export function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

/** Comparison key for a session file path; follows symlinks and ignores case on Windows. */
export function getSessionPathKey(path: string): string {
	return getPathComparisonKey(canonicalizePath(path));
}
