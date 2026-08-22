use std::{env, path::PathBuf, process::Stdio};

use serde::{Deserialize, Serialize};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	process::Command,
	sync::mpsc,
};

use crate::jsonl::{JsonlDecoder, serialize_json_line};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineInvocation {
	pub program: String,
	pub args: Vec<String>,
	pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineStatus {
	pub running: bool,
	pub pid: Option<u32>,
	pub program: Option<String>,
}

pub struct LiveEngine {
	stdin: tokio::process::ChildStdin,
	pid: Option<u32>,
	program: String,
	kill: Option<mpsc::Sender<()>>,
}

pub enum EngineOutput {
	Stdout(String),
	Stderr(String),
	Exited { code: Option<i32> },
}

impl LiveEngine {
	pub fn pid(&self) -> Option<u32> {
		self.pid
	}

	pub fn program(&self) -> &str {
		&self.program
	}

	pub async fn send_value(&mut self, value: &serde_json::Value) -> Result<(), String> {
		let bytes = serialize_json_line(value).map_err(|error| error.to_string())?;
		self
			.stdin
			.write_all(&bytes)
			.await
			.map_err(|error| format!("failed to write RPC command: {error}"))?;
		self.stdin.flush().await.map_err(|error| format!("failed to flush RPC command: {error}"))
	}

	pub async fn kill(&mut self) -> Result<(), String> {
		if let Some(kill) = self.kill.take() {
			kill.send(()).await.map_err(|_| "engine is already stopping".to_string())?;
		}
		Ok(())
	}
}

pub fn default_engine_invocation() -> EngineInvocation {
	if let Ok(raw) = env::var("ATOMIC_DESKTOP_ENGINE") {
		let trimmed = raw.trim();
		if !trimmed.is_empty() {
			return parse_invocation(trimmed, env::current_dir().ok());
		}
	}

	if let Some(repo) = discover_repo_root() {
		let source_cli = repo.join("packages/coding-agent/src/cli.ts");
		let dist_cli = repo.join("packages/coding-agent/dist/cli.js");
		if source_cli.is_file() {
			if let Some(bun) = find_on_path("bun") {
				let mut invocation = EngineInvocation {
					program: bun.display().to_string(),
					args: vec![
						source_cli.display().to_string(),
						"--mode".to_string(),
						"rpc".to_string(),
					],
					cwd: Some(repo.display().to_string()),
				};
				apply_extra_engine_args(&mut invocation.args);
				return invocation;
			}
		}
		if dist_cli.is_file() {
			if let Some(node) = find_on_path("node") {
				let mut invocation = EngineInvocation {
					program: node.display().to_string(),
					args: vec![dist_cli.display().to_string(), "--mode".to_string(), "rpc".to_string()],
					cwd: Some(repo.display().to_string()),
				};
				apply_extra_engine_args(&mut invocation.args);
				return invocation;
			}
		}
	}

	let mut invocation = EngineInvocation {
		program: find_on_path("atomic")
			.map(|path| path.display().to_string())
			.unwrap_or_else(|| "atomic".to_string()),
		args: vec!["--mode".to_string(), "rpc".to_string()],
		cwd: env::current_dir().ok().map(|path| path.display().to_string()),
	};
	apply_extra_engine_args(&mut invocation.args);
	invocation
}

pub fn parse_invocation(raw: &str, cwd: Option<PathBuf>) -> EngineInvocation {
	let tokens = tokenize(raw);
	let (program, args) = tokens.split_first().map_or_else(
		|| ("atomic".to_string(), Vec::new()),
		|(program, rest)| (program.clone(), rest.to_vec()),
	);
	let mut args = args;
	ensure_rpc_mode(&mut args);
	EngineInvocation { program, args, cwd: cwd.map(|path| path.display().to_string()) }
}

pub fn ensure_rpc_mode(args: &mut Vec<String>) {
	// Atomic parseArgs is last-option-wins, and `--mode=rpc` is not a mode flag
	// there. Always finish with a two-token `--mode rpc`.
	args.retain(|arg| arg != "--mode=rpc");
	let mut index = 0;
	while index < args.len() {
		if args[index] == "--mode" && args.get(index + 1).map(String::as_str) == Some("rpc") {
			args.drain(index..=index + 1);
			continue;
		}
		index += 1;
	}
	args.push("--mode".to_string());
	args.push("rpc".to_string());
}

pub fn append_arg_tokens(args: &mut Vec<String>, raw: &str) {
	for token in tokenize(raw) {
		if !token.is_empty() {
			args.push(token);
		}
	}
}

fn apply_extra_engine_args(args: &mut Vec<String>) {
	if let Ok(raw) = env::var("ATOMIC_DESKTOP_ENGINE_ARGS") {
		append_arg_tokens(args, &raw);
	}
	ensure_rpc_mode(args);
}

pub async fn spawn_engine(
	invocation: EngineInvocation,
	output: mpsc::UnboundedSender<EngineOutput>,
) -> Result<LiveEngine, String> {
	if invocation.program.trim().is_empty() {
		return Err("engine program is empty".to_string());
	}

	let mut command = Command::new(&invocation.program);
	command
		.args(&invocation.args)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	if let Some(cwd) = invocation.cwd.as_deref().filter(|value| !value.is_empty()) {
		command.current_dir(cwd);
	}

	let mut child = command.spawn().map_err(|error| {
		format!(
			"failed to start `{}`: {error}. Set ATOMIC_DESKTOP_ENGINE or put `atomic` on PATH.",
			invocation.program
		)
	})?;
	let stdin = child.stdin.take().ok_or_else(|| "engine stdin was not piped".to_string())?;
	let mut stdout = child.stdout.take().ok_or_else(|| "engine stdout was not piped".to_string())?;
	let mut stderr = child.stderr.take().ok_or_else(|| "engine stderr was not piped".to_string())?;
	let pid = child.id();

	let stdout_tx = output.clone();
	tokio::spawn(async move {
		let mut buf = vec![0_u8; 16 * 1024];
		let mut decoder = JsonlDecoder::new();
		loop {
			match stdout.read(&mut buf).await {
				Ok(0) => break,
				Ok(n) => {
					for frame in decoder.push(&buf[..n]) {
						if stdout_tx.send(EngineOutput::Stdout(frame)).is_err() {
							return;
						}
					}
				},
				Err(_) => break,
			}
		}
		if let Some(rest) = decoder.finish() {
			if !rest.is_empty() {
				let _ = stdout_tx.send(EngineOutput::Stdout(rest));
			}
		}
	});

	let stderr_tx = output.clone();
	tokio::spawn(async move {
		let mut buf = vec![0_u8; 8 * 1024];
		loop {
			match stderr.read(&mut buf).await {
				Ok(0) => break,
				Ok(n) => {
					let text = String::from_utf8_lossy(&buf[..n]).into_owned();
					if stderr_tx.send(EngineOutput::Stderr(text)).is_err() {
						return;
					}
				},
				Err(_) => break,
			}
		}
	});

	let (kill_tx, mut kill_rx) = mpsc::channel(1);
	let wait_tx = output;
	tokio::spawn(async move {
		let status = tokio::select! {
			status = child.wait() => status,
			_ = kill_rx.recv() => {
				let _ = child.kill().await;
				child.wait().await
			}
		};
		let code = status.ok().and_then(|exit| exit.code());
		let _ = wait_tx.send(EngineOutput::Exited { code });
	});

	Ok(LiveEngine { stdin, pid, program: invocation.program, kill: Some(kill_tx) })
}

fn discover_repo_root() -> Option<PathBuf> {
	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let mut candidate = manifest.as_path();
	for _ in 0..4 {
		candidate = candidate.parent()?;
		if candidate.join("packages/coding-agent").is_dir() {
			return Some(candidate.to_path_buf());
		}
	}
	None
}

fn find_on_path(name: &str) -> Option<PathBuf> {
	let file_names = if cfg!(windows) && !name.contains('.') {
		vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
	} else {
		vec![name.to_string()]
	};
	env::var_os("PATH").and_then(|paths| {
		env::split_paths(&paths).find_map(|dir| {
			file_names.iter().find_map(|file_name| {
				let path = dir.join(file_name);
				path.is_file().then_some(path)
			})
		})
	})
}

fn tokenize(raw: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	let mut current = String::new();
	let mut chars = raw.chars();
	let mut quote: Option<char> = None;
	while let Some(ch) = chars.next() {
		match (quote, ch) {
			(None, '"') | (None, '\'') => quote = Some(ch),
			(Some(q), ch) if ch == q => quote = None,
			(None, ch) if ch.is_whitespace() => {
				if !current.is_empty() {
					tokens.push(std::mem::take(&mut current));
				}
			},
			(_, '\\') if quote == Some('"') => {
				if let Some(escaped) = chars.next() {
					current.push(escaped);
				}
			},
			(_, ch) => current.push(ch),
		}
	}
	if !current.is_empty() {
		tokens.push(current);
	}
	tokens
}

#[cfg(test)]
mod tests {
	use super::ensure_rpc_mode;

	#[test]
	fn appends_mode_rpc_when_missing() {
		let mut args = vec!["--no-session".to_string()];
		ensure_rpc_mode(&mut args);
		assert_eq!(args, vec!["--no-session", "--mode", "rpc"]);
	}

	#[test]
	fn moves_mode_rpc_to_the_end() {
		let mut args = vec!["--mode".to_string(), "rpc".to_string(), "--no-extensions".to_string()];
		ensure_rpc_mode(&mut args);
		assert_eq!(args, vec!["--no-extensions", "--mode", "rpc"]);
	}

	#[test]
	fn last_option_wins_over_a_later_text_mode() {
		let mut args =
			vec!["--mode".to_string(), "rpc".to_string(), "--mode".to_string(), "text".to_string()];
		ensure_rpc_mode(&mut args);
		assert_eq!(args, vec!["--mode", "text", "--mode", "rpc"]);
	}

	#[test]
	fn rewrites_equals_form_to_two_tokens() {
		let mut args = vec!["--mode=rpc".to_string()];
		ensure_rpc_mode(&mut args);
		assert_eq!(args, vec!["--mode", "rpc"]);
	}
}
