/** Exact JavaScript `\s` membership for a UTF-16 code unit. */
export function isJsWhitespaceCode(code: number): boolean {
	return (
		code === 0x20 ||
		(code >= 0x09 && code <= 0x0d) ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

/** Exact JavaScript LineTerminator membership (characters excluded by `.` without `/s`). */
export function isLineTerminatorCode(code: number): boolean {
	return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

export function isAsciiWordCode(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f
	);
}

/** ASCII case-insensitive match at `offset` (matching JS non-`/u` `/i` without shifting UTF-16 indices). */
export function matchesAsciiCaseInsensitiveAt(text: string, lowerNeedle: string, offset: number): boolean {
	if (offset < 0 || offset + lowerNeedle.length > text.length) return false;
	for (let i = 0; i < lowerNeedle.length; i++) {
		let code = text.charCodeAt(offset + i);
		if (code >= 0x41 && code <= 0x5a) code += 32;
		if (code !== lowerNeedle.charCodeAt(i)) return false;
	}
	return true;
}

/** Leftmost ASCII case-insensitive occurrence of a non-empty lowercase ASCII needle at or after `fromIndex`. */
export function findAsciiCaseInsensitive(text: string, lowerNeedle: string, fromIndex: number): number {
	const limit = text.length - lowerNeedle.length;
	if (fromIndex > limit) return -1;
	const firstLower = lowerNeedle.charCodeAt(0);
	const isAsciiLetter = firstLower >= 0x61 && firstLower <= 0x7a;
	if (!isAsciiLetter) {
		const firstChar = lowerNeedle[0]!;
		let pos = fromIndex;
		while (pos <= limit) {
			const idx = text.indexOf(firstChar, pos);
			if (idx === -1 || idx > limit) return -1;
			if (matchesAsciiCaseInsensitiveAt(text, lowerNeedle, idx)) return idx;
			pos = idx + 1;
		}
		return -1;
	}
	const firstUpper = firstLower - 32;
	for (let pos = fromIndex; pos <= limit; pos++) {
		const code = text.charCodeAt(pos);
		if ((code === firstLower || code === firstUpper) && matchesAsciiCaseInsensitiveAt(text, lowerNeedle, pos)) {
			return pos;
		}
	}
	return -1;
}

/** Linear-time equivalent of `new RegExp(\`\${firstLower}.*\${secondLower}\`, "i").test(text)` for ASCII literals. */
export function matchesOnSameLineCI(text: string, firstLower: string, secondLower: string): boolean {
	let searchFrom = 0;
	let nextSecond = -1;
	let nextSecondLineStart = 0;
	let ltScan = 0;
	while (searchFrom < text.length) {
		const pos = findAsciiCaseInsensitive(text, firstLower, searchFrom);
		if (pos === -1) return false;
		const endFirst = pos + firstLower.length;
		if (nextSecond < endFirst) {
			nextSecond = findAsciiCaseInsensitive(text, secondLower, endFirst);
			if (nextSecond === -1) return false;
			while (ltScan < nextSecond) {
				if (isLineTerminatorCode(text.charCodeAt(ltScan))) {
					nextSecondLineStart = ltScan + 1;
				}
				ltScan++;
			}
		}
		if (endFirst >= nextSecondLineStart) return true;
		searchFrom = nextSecondLineStart;
	}
	return false;
}

/** Linear-time equivalent of `/^Bearer\s+(.+)$/iu.exec(authorization)?.[1]`. */
export function extractBearerToken(authorization: string): string | undefined {
	if (authorization.length < 8 || !matchesAsciiCaseInsensitiveAt(authorization, "bearer", 0)) {
		return undefined;
	}
	if (!isJsWhitespaceCode(authorization.charCodeAt(6))) return undefined;
	let wsEnd = 6;
	while (wsEnd < authorization.length && isJsWhitespaceCode(authorization.charCodeAt(wsEnd))) {
		wsEnd++;
	}
	if (wsEnd === authorization.length) {
		const lastCode = authorization.charCodeAt(authorization.length - 1);
		return isLineTerminatorCode(lastCode) ? undefined : authorization.slice(authorization.length - 1);
	}
	for (let k = wsEnd; k < authorization.length; k++) {
		if (isLineTerminatorCode(authorization.charCodeAt(k))) return undefined;
	}
	return authorization.slice(wsEnd);
}
