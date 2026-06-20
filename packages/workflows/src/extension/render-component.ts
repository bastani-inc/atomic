import type { PiRenderComponent } from "./public-types.js";

export function dynamicTextRenderComponent(
  renderText: (width: number) => string,
): PiRenderComponent {
  return {
    render(width: number): string[] {
      return renderText(width).split("\n");
    },
    includes(searchString: string): boolean {
      return renderText(120).includes(searchString);
    },
  };
}
