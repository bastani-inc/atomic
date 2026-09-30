import { Text } from "@earendil-works/pi-tui";

/** Text whose theme-dependent styling is rebuilt when the UI is invalidated. */
export class ThemedText extends Text {
	private readonly buildText: () => string;
	constructor(buildText: () => string, paddingX = 0, paddingY = 0) {
		super(buildText(), paddingX, paddingY);
		this.buildText = buildText;
	}
	override invalidate(): void {
		this.setText(this.buildText());
		super.invalidate();
	}
}
