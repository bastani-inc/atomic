// Path resolution and metadata classification for filesystem scans.

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::{Error, Result};

use super::FileType;

// ═══════════════════════════════════════════════════════════════════════════
// Path utilities
// ═══════════════════════════════════════════════════════════════════════════

/// Resolve a search path string to a canonical `PathBuf` (must be a directory).
pub fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	let root = if candidate.is_absolute() {
		candidate
	} else {
		let cwd = std::env::current_dir()
			.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
		cwd.join(candidate)
	};
	let metadata = std::fs::metadata(&root)
		.map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;
	if !metadata.is_dir() {
		return Err(Error::from_reason("Search path must be a directory".to_string()));
	}
	Ok(std::fs::canonicalize(&root).unwrap_or(root))
}

/// Normalize a filesystem path to a forward-slash relative string.
pub fn normalize_relative_path<'a>(root: &Path, path: &'a Path) -> Cow<'a, str> {
	let relative = path.strip_prefix(root).unwrap_or(path);
	if cfg!(windows) {
		let relative = relative.to_string_lossy();
		if relative.contains('\\') { Cow::Owned(relative.replace('\\', "/")) } else { relative }
	} else {
		relative.to_string_lossy()
	}
}

pub fn contains_component(path: &Path, target: &str) -> bool {
	path
		.components()
		.any(|component| component.as_os_str().to_str().is_some_and(|value| value == target))
}

pub fn should_skip_path(path: &Path, mentions_node_modules: bool) -> bool {
	// Always skip VCS internals; they are noise for user-facing discovery.
	if contains_component(path, ".git") {
		return true;
	}
	if !mentions_node_modules && contains_component(path, "node_modules") {
		// Skip node_modules by default unless explicitly requested/pattern-matched.
		return true;
	}
	false
}

pub(super) fn file_type_from_std(file_type: std::fs::FileType) -> Option<FileType> {
	if file_type.is_symlink() {
		Some(FileType::Symlink)
	} else if file_type.is_dir() {
		Some(FileType::Dir)
	} else if file_type.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

pub(super) fn mtime_ms(metadata: &std::fs::Metadata) -> Option<f64> {
	metadata
		.modified()
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_millis() as f64)
}

pub fn classify_file_type(path: &Path) -> Option<(FileType, Option<f64>, Option<u64>)> {
	let metadata = std::fs::symlink_metadata(path).ok()?;
	let file_type = file_type_from_std(metadata.file_type())?;
	let size = if file_type == FileType::File { Some(metadata.len()) } else { None };
	Some((file_type, mtime_ms(&metadata), size))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use super::classify_file_type;
	#[cfg(unix)]
	use crate::fs_cache::test_util::{TempDirGuard, make_fifo};

	#[cfg(unix)]
	#[test]
	fn classify_file_type_skips_fifo() {
		let root = TempDirGuard::new();
		let fifo = root.path().join("skip-me.fifo");
		make_fifo(&fifo);

		assert_eq!(classify_file_type(&fifo), None);
	}
}
