// Parallel filesystem walk and entry collection.

use std::{
	path::Path,
	sync::{Arc, Mutex},
};

use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};
use napi::bindgen_prelude::{Error, Result};

use super::{
	FileType, GlobMatch, ScanDetail, ScanOptions, grep_workers, normalize_relative_path,
	paths::{file_type_from_std, mtime_ms},
};
use crate::task;

// ═══════════════════════════════════════════════════════════════════════════
// Walker + collection
// ═══════════════════════════════════════════════════════════════════════════

/// Builds a deterministic filesystem walker configured for visibility and
/// ignore rules.
///
/// When `skip_node_modules` is true, `node_modules` directories are pruned at
/// traversal time (not just filtered post-scan). `.git` is always skipped.
#[allow(clippy::fn_params_excessive_bools, reason = "matches WalkBuilder option fields")]
pub fn build_walker(
	root: &Path,
	include_hidden: bool,
	use_gitignore: bool,
	skip_node_modules: bool,
	follow_links: bool,
) -> WalkBuilder {
	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(!include_hidden)
		.follow_links(follow_links)
		.sort_by_file_path(|a, b| a.cmp(b))
		// filter_entry controls whether to yield an entry AND whether to descend
		// into a directory. Returning false for a directory skips the entire subtree.
		.filter_entry(move |entry| {
			let name = entry.file_name().to_str().unwrap_or_default();
			// Always skip .git
			if name == ".git" {
				return false;
			}
			// Skip node_modules when skip_node_modules is true
			if skip_node_modules && name == "node_modules" {
				return false;
			}
			true
		});

	if use_gitignore {
		// Honor repository and global ignore files for repo-like behavior.
		builder
			.git_ignore(true)
			.git_exclude(true)
			.git_global(true)
			.ignore(true)
			.parents(true)
			.require_git(false);
	} else {
		// Disable all ignore sources for exhaustive filesystem traversal.
		builder.git_ignore(false).git_exclude(false).git_global(false).ignore(false).parents(false);
	}

	builder
}

struct EntryVisitor<'a> {
	root: &'a Path,
	detail: ScanDetail,
	ct: &'a task::CancelToken,
	entries: Vec<GlobMatch>,
	shared_entries: Arc<Mutex<Vec<Vec<GlobMatch>>>>,
	error: Arc<Mutex<Option<String>>>,
	visited: usize,
}

impl Drop for EntryVisitor<'_> {
	fn drop(&mut self) {
		if self.entries.is_empty() {
			return;
		}
		let entries = std::mem::take(&mut self.entries);
		self.shared_entries.lock().unwrap_or_else(|poison| poison.into_inner()).push(entries);
	}
}

impl ParallelVisitor for EntryVisitor<'_> {
	fn visit(&mut self, entry: std::result::Result<ignore::DirEntry, ignore::Error>) -> WalkState {
		if self.visited == 0 || self.visited >= 128 {
			self.visited = 0;
			if let Err(err) = self.ct.heartbeat() {
				*self.error.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(err.to_string());
				return WalkState::Quit;
			}
		}
		self.visited += 1;

		let Ok(entry) = entry else {
			return WalkState::Continue;
		};
		if let Some(entry) = collect_entry(self.root, &entry, self.detail) {
			self.entries.push(entry);
		}
		WalkState::Continue
	}
}

struct EntryVisitorBuilder<'a> {
	root: &'a Path,
	detail: ScanDetail,
	ct: &'a task::CancelToken,
	shared_entries: Arc<Mutex<Vec<Vec<GlobMatch>>>>,
	error: Arc<Mutex<Option<String>>>,
}

impl<'a> ParallelVisitorBuilder<'a> for EntryVisitorBuilder<'a> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 'a> {
		Box::new(EntryVisitor {
			root: self.root,
			detail: self.detail,
			ct: self.ct,
			entries: Vec::new(),
			shared_entries: Arc::clone(&self.shared_entries),
			error: Arc::clone(&self.error),
			visited: 0,
		})
	}
}

/// Scans filesystem entries and records normalized relative paths with file
/// metadata.
pub(super) fn collect_entries(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let mut builder = build_walker(
		root,
		options.include_hidden,
		options.use_gitignore,
		options.skip_node_modules,
		options.follow_links,
	);
	let workers = grep_workers();
	if workers > 0 {
		builder.threads(workers);
	}
	let shared_entries = Arc::new(Mutex::new(Vec::new()));
	let error = Arc::new(Mutex::new(None));
	let mut visitor_builder = EntryVisitorBuilder {
		root,
		detail: options.detail,
		ct,
		shared_entries: Arc::clone(&shared_entries),
		error: Arc::clone(&error),
	};
	ct.heartbeat()?;
	builder.build_parallel().visit(&mut visitor_builder);

	let walk_error = error.lock().unwrap_or_else(|poison| poison.into_inner()).take();
	if let Some(error) = walk_error {
		return Err(Error::from_reason(error));
	}

	let mut entries: Vec<GlobMatch> = shared_entries
		.lock()
		.unwrap_or_else(|poison| poison.into_inner())
		.drain(..)
		.flatten()
		.collect();
	entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	Ok(entries)
}

pub(crate) fn collect_entry(
	root: &Path,
	entry: &ignore::DirEntry,
	detail: ScanDetail,
) -> Option<GlobMatch> {
	let path = entry.path();
	let relative = normalize_relative_path(root, path);
	if relative.is_empty() {
		// Ignore the synthetic root entry ("" relative path).
		return None;
	}

	let (file_type, mtime, size) = match detail {
		ScanDetail::Minimal => {
			let file_type = file_type_from_std(entry.file_type()?)?;
			(file_type, None, None)
		},
		ScanDetail::Full => {
			let metadata = entry.metadata().or_else(|_| std::fs::symlink_metadata(path)).ok()?;
			let file_type = file_type_from_std(metadata.file_type())?;
			let size = if file_type == FileType::File { Some(metadata.len() as f64) } else { None };
			(file_type, mtime_ms(&metadata), size)
		},
	};

	Some(GlobMatch { path: relative.into_owned(), file_type, mtime, size })
}

#[cfg(test)]
mod tests {
	use std::{fs, time::Duration};

	use crate::fs_cache::test_util::TempDirGuard;

	#[test]
	fn build_walker_skips_git_and_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".git/objects")).unwrap();
		fs::write(root.path().join(".git/objects/a.txt"), "git obj").unwrap();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		// skip_node_modules: true -> should only see real.txt
		let walker = super::build_walker(root.path(), true, false, true, false);
		let paths: Vec<String> = walker
			.build()
			.filter_map(|e| e.ok())
			.filter(|e| e.path() != root.path())
			.map(|e| e.path().strip_prefix(root.path()).unwrap().to_string_lossy().into_owned())
			.collect();
		assert!(
			!paths.iter().any(|p| p.contains("node_modules") || p.contains(".git")),
			"expected no .git or node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|p| p == "real.txt"), "expected real.txt, got: {paths:?}");

		// skip_node_modules: false -> should see node_modules but not .git
		let walker = super::build_walker(root.path(), true, false, false, false);
		let paths: Vec<String> = walker
			.build()
			.filter_map(|e| e.ok())
			.filter(|e| e.path() != root.path())
			.map(|e| e.path().strip_prefix(root.path()).unwrap().to_string_lossy().into_owned())
			.collect();
		assert!(
			!paths.iter().any(|p| p.contains(".git")),
			"expected no .git entries, got: {paths:?}"
		);
		assert!(
			paths.iter().any(|p| p.contains("node_modules")),
			"expected node_modules entries, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_skips_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();
		let entries = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Full,
			},
			&ct,
		)
		.unwrap();
		let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
		assert!(
			!paths.iter().any(|p| p.contains("node_modules")),
			"expected no node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|p| p == &"real.txt"), "expected real.txt, got: {paths:?}");
	}

	#[test]
	fn collect_entries_respects_pre_cancelled_token() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::new(Some(0), None);
		std::thread::sleep(Duration::from_millis(1));
		let result = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Minimal,
			},
			&ct,
		);

		let Err(err) = result else {
			panic!("pre-cancelled scans should fail before returning entries");
		};
		assert!(
			err.to_string().contains("timed out"),
			"expected timeout cancellation error, got: {err}"
		);
	}

	#[test]
	fn scan_detail_controls_metadata_collection() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let ct = crate::task::CancelToken::default();
		let minimal = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Minimal,
			},
			&ct,
		)
		.unwrap();
		let minimal_file =
			minimal.iter().find(|entry| entry.path == "real.txt").expect("minimal scan includes file");
		assert_eq!(minimal_file.mtime, None);
		assert_eq!(minimal_file.size, None);

		let full = super::collect_entries(
			root.path(),
			super::ScanOptions {
				include_hidden: true,
				use_gitignore: false,
				skip_node_modules: true,
				follow_links: false,
				detail: super::ScanDetail::Full,
			},
			&ct,
		)
		.unwrap();
		let full_file =
			full.iter().find(|entry| entry.path == "real.txt").expect("full scan includes file");
		assert!(full_file.mtime.is_some(), "full scan should include mtime");
		assert_eq!(full_file.size, Some(2.0));
	}
}
