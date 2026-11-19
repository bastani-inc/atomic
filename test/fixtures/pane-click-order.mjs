export default (pi) => {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.isPresentationOnly) ctx.ui.setWidget("navigation-start", ["Navigation test ready"]);
	});
	pi.registerCommand("pane-order", { description: "Open the navigation panes", handler: async (_args, ctx) => {
		if (ctx.isPresentationOnly) return;
		let pressDeclined = false;
		const nav = { purpose: "navigation" };
		void ctx.ui.custom((_tui, _theme, _keys, done) => ({
			render: () => ["Open transcript"],
			invalidate() {},
			handleInput() { return false; },
			paintedRowKey: () => "transcript",
			handleMouse(event) {
				if (event.type !== "click" || !pressDeclined) return;
				done();
				return { handled: true };
			},
		}), nav).then(async () => {
			await ctx.ui.custom((_tui, _theme, _keys, done) => ({
				render: () => ["Viewing transcript"],
				invalidate() {},
				handleInput(data) {
					if (data !== "\x1b[D") return false;
					done();
					return true;
				},
			}), { ...nav, overlay: true });
			ctx.ui.setWidget("navigation-result", ["Returned from transcript"]);
		});
		let ready = false;
		void ctx.ui.custom((tui) => ({
			render: () => [ready ? "Navigation ready" : "Navigation pane"],
			invalidate() {},
			handleInput(data) {
				if (data === "k") {
					ready = true;
					tui.requestRender();
					return true;
				}
				if (/^\x1b\[<0;\d+;\d+M$/.test(data)) return new Promise((resolve) => setTimeout(() => { pressDeclined = true; resolve(false); }, 80));
				return false;
			},
		}), { ...nav, overlay: true, overlayOptions: { anchor: "top-right", width: 20 } });
	}});
};
