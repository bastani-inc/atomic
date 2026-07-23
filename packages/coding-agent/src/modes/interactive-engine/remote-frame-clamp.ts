import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Width clamp for frames rendered out-of-process by the isolated interactive
 * engine.
 *
 * Remote components ({@link RemoteRenderer}, {@link RemoteComponent}) request a
 * re-render from the engine child asynchronously and keep returning the last
 * applied frame until the fresh one arrives. Across a terminal resize this
 * replays lines wrapped at the previous width; pi-tui's differential renderer
 * treats any rendered line wider than the terminal as a fatal invariant
 * violation and crashes the whole TUI (uncaughtException in doRender).
 *
 * Clamping the stale frame to the currently requested width keeps every
 * returned line legal while the engine catches up; the properly re-wrapped
 * frame replaces the clamped one as soon as it is applied.
 *
 * The result is memoized on (frame identity, width) so steady-state renders
 * cost one identity check and re-scans happen only on resize or frame change.
 */
export class RemoteFrameWidthClamp {
	private source: readonly string[] | undefined;
	private width = -1;
	private clamped: string[] | undefined;

	clamp(lines: string[], width: number): string[] {
		if (this.clamped !== undefined && this.source === lines && this.width === width) {
			return this.clamped;
		}
		let result = lines;
		if (width > 0) {
			for (const line of lines) {
				if (visibleWidth(line) > width) {
					result = lines.map((frameLine) =>
						visibleWidth(frameLine) > width ? truncateToWidth(frameLine, width, "") : frameLine,
					);
					break;
				}
			}
		}
		this.source = lines;
		this.width = width;
		this.clamped = result;
		return result;
	}
}
