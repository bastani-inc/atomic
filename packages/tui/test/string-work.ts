export function measureStringWork<T>(run: () => T): { value: T; work: number } {
	let work = 0;
	const proto = String.prototype;
	const original = {
		charCodeAt: proto.charCodeAt,
		codePointAt: proto.codePointAt,
		indexOf: proto.indexOf,
		includes: proto.includes,
		slice: proto.slice,
		substring: proto.substring,
		toLowerCase: proto.toLowerCase,
		trim: proto.trim,
		trimEnd: proto.trimEnd,
		split: proto.split,
		replace: proto.replace,
		replaceAll: proto.replaceAll,
	};
	const segment = Intl.Segmenter.prototype.segment;

	const scanned = (text: string, needle: string, from: number, found: number): number =>
		found === -1 ? Math.max(0, text.length - from) : found - from + needle.length;

	proto.charCodeAt = function (this: string, index: number): number {
		work++;
		return original.charCodeAt.call(this, index);
	};
	proto.codePointAt = function (this: string, index: number): number | undefined {
		work++;
		return original.codePointAt.call(this, index);
	};
	proto.indexOf = function (this: string, needle: string, position?: number): number {
		const from = Math.max(0, Math.trunc(position ?? 0));
		const found = original.indexOf.call(this, needle, position);
		work += scanned(this, needle, from, found);
		return found;
	};
	proto.includes = function (this: string, needle: string, position?: number): boolean {
		const from = Math.max(0, Math.trunc(position ?? 0));
		const found = original.indexOf.call(this, needle, position);
		work += scanned(this, needle, from, found);
		return found !== -1;
	};
	proto.slice = function (this: string, start?: number, end?: number): string {
		const result = original.slice.call(this, start, end);
		work += result.length;
		return result;
	};
	proto.substring = function (this: string, start: number, end?: number): string {
		const result = original.substring.call(this, start, end);
		work += result.length;
		return result;
	};
	for (const name of ["toLowerCase", "trim", "trimEnd"] as const) {
		const method = original[name];
		proto[name] = function (this: string): string {
			work += this.length;
			return method.call(this);
		};
	}
	proto.split = function (this: string, ...args: Parameters<typeof original.split>) {
		work += this.length;
		return original.split.apply(this, args);
	} as typeof original.split;
	proto.replace = function (this: string, ...args: Parameters<typeof original.replace>) {
		work += this.length;
		return original.replace.apply(this, args);
	} as typeof original.replace;
	proto.replaceAll = function (this: string, ...args: Parameters<typeof original.replaceAll>) {
		work += this.length;
		return original.replaceAll.apply(this, args);
	} as typeof original.replaceAll;
	Intl.Segmenter.prototype.segment = function (this: Intl.Segmenter, input: string): Intl.Segments {
		const segments = segment.call(this, input);
		return {
			containing: (codeUnitIndex?: number) => segments.containing(codeUnitIndex),
			*[Symbol.iterator](): Generator<Intl.SegmentData, undefined> {
				for (const data of segments) {
					work += data.segment.length;
					yield data;
				}
				return undefined;
			},
		};
	};

	try {
		return { value: run(), work };
	} finally {
		Object.assign(proto, original);
		Intl.Segmenter.prototype.segment = segment;
	}
}
