import { appendFileSync } from "node:fs";
import { Editor } from "@bastani/atomic-tui";

// Observe the host's actual editor, including when a separate engine owns the session.
const handleMouse = Editor.prototype.handleMouse;
Editor.prototype.handleMouse = function (event) {
	const onChange = this.onChange;
	this.onChange = (text) => {
		appendFileSync(process.env.DRAFT_CHANGES, `${JSON.stringify(text)}\n`);
		onChange?.call(this, text);
	};
	try {
		return handleMouse.call(this, event);
	} finally {
		this.onChange = onChange;
	}
};
