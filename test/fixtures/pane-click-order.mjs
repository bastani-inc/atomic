export default (pi) => {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.isPresentationOnly) return;
		const nav = { purpose: "navigation" };
		void ctx.ui.custom((_tui, _theme, _keys, done) => ({
			render: () => ["Open transcript"],
			invalidate() {},
			handleInput() { return false; },
			paintedRowKey: () => "transcript",
			handleMouse(event) {
				if (event.type !== "click") return;
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
			ctx.ui.notify("Returned from transcript", "info");
		});
		void ctx.ui.custom(() => ({
			render: () => ["Navigation pane"],
			invalidate() {},
			handleInput(data) {
				if (/^\x1b\[<0;\d+;\d+M$/.test(data)) return new Promise((resolve) => setTimeout(() => resolve(false), 80));
				return false;
			},
		}), { ...nav, overlay: true, overlayOptions: { anchor: "top-right", width: 20 } });
	});
};
