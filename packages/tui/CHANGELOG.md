# Changelog

This package is Atomic's fork of `@earendil-works/pi-tui`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/tui/CHANGELOG.md).

## [Unreleased]

### Added

- Exported `decodePrintableKey` for printable Kitty CSI-u and modifyOtherKeys input, and `normalizePastedText` for custom inputs to apply the editor's paste normalization.

### Changed

- Forked `@earendil-works/pi-tui` 1.5.2 as `@bastani/atomic-tui`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-tui` and `@mariozechner/pi-tui` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
- The renderer reads `ATOMIC_TUI_ESC_TIMEOUT`, `ATOMIC_TUI_DEBUG`, `ATOMIC_TUI_DEBUG_REDRAW`, `ATOMIC_TUI_WRITE_LOG`, `ATOMIC_HYPERLINKS`, `ATOMIC_IMAGE_PROTOCOL`, `ATOMIC_TRUE_COLOR` and `ATOMIC_PROGRAM_STATUS`. Their `PI_*` names keep working when the `ATOMIC_*` name is unset ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
