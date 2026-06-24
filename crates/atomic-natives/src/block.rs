//! Resolve the syntactic block that begins on a given 1-indexed source line.
//!
//! Backs the hashline `replace block N:` / `delete block N` / `insert after
//! block N:` operators. Given a line, parse the source with tree-sitter and
//! return the line span of the outermost named node that *begins* on that line
//! (excluding the whole-file root). Pointing at a continuation line or a lone
//! closing delimiter resolves to nothing.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use napi_derive::napi;
use tree_sitter::{Language, Parser, Point};

#[napi(object)]
pub struct BlockRange {
	/// 1-indexed inclusive first line of the resolved block.
	#[napi(js_name = "startLine")]
	pub start_line: u32,
	/// 1-indexed inclusive last line of the resolved block.
	#[napi(js_name = "endLine")]
	pub end_line: u32,
}

#[napi(object)]
pub struct BlockRangeOptions {
	/// Source code to inspect.
	pub code: String,
	/// File path used to infer the language by extension.
	pub path: String,
	/// 1-indexed source line the block must begin on.
	pub line: u32,
}

/// Map a file path's extension to a tree-sitter language. Returns `None` for
/// unrecognized extensions (the caller then reports "no block here").
fn language_for_path(path: &str) -> Option<Language> {
	let ext = Path::new(path).extension().and_then(|value| value.to_str())?.to_ascii_lowercase();
	let language = match ext.as_str() {
		"ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
		"tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
		"js" | "mjs" | "cjs" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
		"py" | "pyi" => tree_sitter_python::LANGUAGE.into(),
		"rs" => tree_sitter_rust::LANGUAGE.into(),
		"go" => tree_sitter_go::LANGUAGE.into(),
		"rb" => tree_sitter_ruby::LANGUAGE.into(),
		"css" | "scss" => tree_sitter_css::LANGUAGE.into(),
		"json" | "jsonc" => tree_sitter_json::LANGUAGE.into(),
		"sh" | "bash" | "zsh" => tree_sitter_bash::LANGUAGE.into(),
		"c" | "h" => tree_sitter_c::LANGUAGE.into(),
		"cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => tree_sitter_cpp::LANGUAGE.into(),
		"java" => tree_sitter_java::LANGUAGE.into(),
		_ => return None,
	};
	Some(language)
}

/// Byte column of the first non-whitespace character on `row` (0-indexed), or
/// `None` when the row is out of range or blank / whitespace-only.
fn first_content_column(code: &str, row: usize) -> Option<usize> {
	let line = code.split('\n').nth(row)?;
	line.bytes().position(|byte| byte != b' ' && byte != b'\t')
}

/// tree-sitter end positions point just past the last byte. When a node ends at
/// column 0 of a later row, its last *content* row is the row above.
fn content_end_line(end: Point, start_row: usize) -> u32 {
	let mut row = end.row;
	if end.column == 0 && row > start_row {
		row -= 1;
	}
	(row + 1) as u32
}

/// Resolve the block beginning on `options.line`. Returns `None` when the
/// language is unrecognized, the line is out of range / blank, no node begins
/// there, or the resolved subtree contains a syntax error.
#[napi(js_name = "blockRangeAt")]
pub fn block_range_at(options: BlockRangeOptions) -> Option<BlockRange> {
	catch_unwind(AssertUnwindSafe(|| block_range_at_inner(options))).ok().flatten()
}

fn block_range_at_inner(options: BlockRangeOptions) -> Option<BlockRange> {
	let BlockRangeOptions { code, path, line } = options;
	if line == 0 || code.is_empty() {
		return None;
	}
	let language = language_for_path(&path)?;
	let row = (line - 1) as usize;
	let col = first_content_column(&code, row)?;

	let mut parser = Parser::new();
	parser.set_language(&language).ok()?;
	let tree = parser.parse(&code, None)?;
	let root = tree.root_node();

	let point = Point::new(row, col);
	let leaf = root.named_descendant_for_point_range(point, point)?;
	// A leaf that starts before `row` means `point` landed on a continuation
	// line or a closing delimiter of a block opened earlier — nothing begins on
	// line N.
	if leaf.start_position().row != row {
		return None;
	}
	// Climb to the outermost named ancestor that still begins on `row`,
	// excluding the whole-file root.
	let mut node = leaf;
	while let Some(parent) = node.parent() {
		if parent.id() == root.id() || parent.start_position().row != row {
			break;
		}
		node = parent;
	}
	// Refuse degenerate error-recovery spans confined to the resolved subtree;
	// an unrelated syntax error elsewhere in the file does not disable this.
	if node.has_error() {
		return None;
	}
	Some(BlockRange {
		start_line: (node.start_position().row + 1) as u32,
		end_line: content_end_line(node.end_position(), node.start_position().row),
	})
}
