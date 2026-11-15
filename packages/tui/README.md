<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
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

The terminal UI framework Atomic's interactive mode is built with: main-screen and alternate-screen renderers, differential rendering with synchronized output, components, overlays, key and mouse input, and inline images.

[Atomic](https://github.com/bastani-inc/atomic), the verifiable coding agent runtime, is built on it, and it is published with every Atomic release at Atomic's version.

## Install

```bash
npm install @bastani/atomic-tui
```

Inside an Atomic extension, import it without installing it: the running Atomic provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@bastani/atomic-tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create the default main-screen renderer through the shared TUI interface
const tui: TUI = new TuiMainScreen(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C doesn't send SIGINT — intercept it here to allow exit
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

// Start
tui.start();
```

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-tui](https://docs.bastani.ai/libraries/tui)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
