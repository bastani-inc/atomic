<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-tui</b><br>
  A terminal UI framework with differential rendering for flicker-free interactive CLIs.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/tui"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-tui"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-tui?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

`@bastani/atomic-tui` is the terminal UI framework behind Atomic's interactive mode. It provides main-screen and alternate-screen renderers, differential rendering with synchronized output, reusable components, overlays, keyboard and mouse input, and inline image support.

[Atomic](https://github.com/bastani-inc/atomic) runs on this package and publishes it with every release at the same version.

## Install

```bash
npm install @bastani/atomic-tui
```

Inside an Atomic extension, you can import it without installing it because the running Atomic process provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

```typescript
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	ProcessTerminal,
	Text,
	type TUI,
	TuiMainScreen,
} from "@bastani/atomic-tui";

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

tui.addChild(new Text("Welcome to my app!"));

const editorTheme: EditorTheme = {
	borderColor: (s) => `\x1b[90m${s}\x1b[0m`,
	selectList: {
		selectedPrefix: (s) => `\x1b[36m${s}\x1b[0m`,
		selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
		description: (s) => `\x1b[90m${s}\x1b[0m`,
		scrollInfo: (s) => `\x1b[90m${s}\x1b[0m`,
		noMatch: (s) => `\x1b[90m${s}\x1b[0m`,
	},
};

const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
	tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C does not send SIGINT, so intercept it here to exit
tui.addInputListener((data) => {
	if (matchesKey(data, Key.ctrl("c"))) {
		tui.stop();
		process.exit(0);
	}
});

tui.start();
```

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-tui](https://docs.bastani.ai/libraries/tui)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
