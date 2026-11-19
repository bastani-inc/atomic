import { SelectList } from "@bastani/atomic-tui";

export default (pi) => {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.isPresentationOnly) return;
		pi.sendMessage({
			customType: "scroll-test",
			display: true,
			content: Array.from({ length: 80 }, (_, i) => `Transcript line ${i}`).join("\n"),
		});
		const scenario = process.env.WHEEL_SCENARIO;
		const overlay = scenario === "outside" || scenario === "slow";
		void ctx.ui.custom(
			(tui) => {
				const plain = (s) => s;
				const list = new SelectList(
					["Alpha", "Bravo", "Charlie"].map((label) => ({ label, value: label })),
					3,
					{ selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
				);
				list.setSelectedIndex(1);
				let turns = 0;
				let keys = 0;
				let delays = 0;
				const slowReply = () => {
					if (scenario !== "slow") return;
					// The child is busy answering this turn; the real host and its input timeout keep running.
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
					delays++;
				};
				return {
					render(width) {
						return [
							...(overlay ? list.render(width) : []),
							`${process.stdout.isTTY ? "local" : "engine"} row: ${turns} keys: ${keys} delays: ${delays}`,
						];
					},
					invalidate() {},
					paintedRowKey: (row) => (overlay ? list.paintedRowKey?.(row) : "status"),
					handleMouse(event) {
						if (event.type !== "wheel") return;
						if (overlay) {
							const result = list.handleMouse(event);
							slowReply();
							return result;
						}
						if (event.alt || (scenario !== "alt" && event.wheelDelta < 0)) return;
						turns++;
						return { handled: true };
					},
					handleInput(data) {
						if (data === "k") {
							keys++;
							tui.requestRender();
							return true;
						}
						if (overlay) {
							if (data.startsWith("\x1b[<")) slowReply();
							return list.handleInput(data);
						}
					},
				};
			},
			overlay ? { overlay: true, overlayOptions: { anchor: "top-right", width: 35 } } : { purpose: "navigation" },
		);
	});
};
