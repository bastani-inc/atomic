import { ClickableRows, type Component, matchesKey, type TuiMouseEvent } from "@bastani/atomic-tui";

export class ColorList implements Component {
	private readonly colors = ["red", "blue"];
	private readonly rows = new ClickableRows<string>();
	private selected = 0;
	readonly chosen: string[] = [];

	render(): string[] {
		this.rows.clear();
		return this.colors.map((color, index) => {
			this.rows.add(index, color, color);
			return `${index === this.selected ? ">" : " "} ${color}`;
		});
	}

	handleMouse(event: TuiMouseEvent) {
		return this.rows.handleMouse(event, { activate: (color) => this.chosen.push(color) });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "down")) this.selected = 1;
		if (matchesKey(data, "enter")) this.chosen.push(this.colors[this.selected]!);
	}

	invalidate(): void {}
}
