import { createRequire } from "node:module";

export const CURSOR_H2_NATIVE_PACKAGE = "@bastani/atomic-natives";

export interface CursorH2NativeUnaryResponse {
	readonly statusCode?: number;
	readonly status_code?: number;
	readonly headersJson?: string;
	readonly headers_json?: string;
	readonly body: Uint8Array;
}

export interface CursorH2NativeStream {
	write(data: Uint8Array, timeoutMs?: number | null): Promise<void>;
	finishInput(): Promise<void>;
	nextFrame(): Promise<Uint8Array | null>;
	cancel(): Promise<void>;
}

export interface CursorH2NativeBinding {
	cursorH2RequestUnary(configJson: string, body: Uint8Array): Promise<CursorH2NativeUnaryResponse>;
	cursorH2OpenStream(configJson: string, initialBody?: Uint8Array | null): Promise<CursorH2NativeStream>;
	cursorH2CancelOperation(operationId: string): Promise<void> | void;
}

export type CursorH2NativeLoadResult =
	| { readonly ok: true; readonly binding: CursorH2NativeBinding; readonly packageName: string }
	| { readonly ok: false; readonly error: Error; readonly packageName: string };

let cachedLoadResult: CursorH2NativeLoadResult | undefined;

export function resetCursorH2NativeBindingCache(): void {
	cachedLoadResult = undefined;
}

export function loadCursorH2NativeBinding(): CursorH2NativeLoadResult {
	if (cachedLoadResult) return cachedLoadResult;
	const requireNative = createRequire(import.meta.url);
	try {
		const loaded = requireNative(CURSOR_H2_NATIVE_PACKAGE) as Partial<CursorH2NativeBinding>;
		if (typeof loaded.cursorH2RequestUnary !== "function" || typeof loaded.cursorH2OpenStream !== "function" || typeof loaded.cursorH2CancelOperation !== "function") {
			cachedLoadResult = {
				ok: false,
				packageName: CURSOR_H2_NATIVE_PACKAGE,
				error: new Error(`Cursor HTTP/2 native package ${CURSOR_H2_NATIVE_PACKAGE} is missing required N-API exports.`),
			};
			return cachedLoadResult;
		}
		cachedLoadResult = { ok: true, binding: loaded as CursorH2NativeBinding, packageName: CURSOR_H2_NATIVE_PACKAGE };
		return cachedLoadResult;
	} catch (error) {
		cachedLoadResult = {
			ok: false,
			packageName: CURSOR_H2_NATIVE_PACKAGE,
			error: new Error(`Cursor HTTP/2 native package ${CURSOR_H2_NATIVE_PACKAGE} is unavailable for ${process.platform}-${process.arch}: ${error instanceof Error ? error.message : String(error)}`),
		};
		return cachedLoadResult;
	}
}

export function formatCursorH2NativeLoadFailure(result: Extract<CursorH2NativeLoadResult, { ok: false }>): string {
	return [
		result.error.message,
		`Install or rebuild ${result.packageName} so its NAPI-RS optional dependency for ${process.platform}-${process.arch} is available.`,
		"If you installed Atomic from npm/Bun, reinstall @bastani/atomic. If you are developing locally, run `bun --cwd packages/natives run build`."
	].join("\n");
}

export function cursorH2NativeLoadSummary(result: CursorH2NativeLoadResult): string {
	return result.ok ? `loaded ${result.packageName}` : result.error.message;
}
