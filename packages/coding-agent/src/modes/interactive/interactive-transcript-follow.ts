import { InteractiveModeBase } from "./interactive-mode-base.ts";

InteractiveModeBase.prototype.jumpToTranscriptEnd = function (this: InteractiveModeBase): void {
	this.transcriptScrollView?.scrollToEnd();
	this.ui.requestRender();
};
