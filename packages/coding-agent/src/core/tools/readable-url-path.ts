/** Lightweight URL-path predicates kept out of `fetch-url.ts` so `read.ts` loads `turndown`/`domino` only on URL reads. */

export function repairCollapsedScheme(url: string): string {
	return url.replace(/^(https?):\/([^/])/i, "$1://$2");
}

export function isReadableUrlPath(readPath: string): boolean {
	const repaired = repairCollapsedScheme(readPath);
	return /^https?:\/\//i.test(repaired) || /^www\./i.test(readPath);
}
