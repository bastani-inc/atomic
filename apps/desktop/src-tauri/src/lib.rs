mod engine;
mod jsonl;

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, mpsc};

use engine::{
	EngineInvocation, EngineOutput, EngineStatus, LiveEngine, default_engine_invocation,
	spawn_engine,
};

struct EngineCell {
	live: Mutex<Option<LiveEngine>>,
}

impl EngineCell {
	fn new() -> Self {
		Self { live: Mutex::new(None) }
	}
}

#[tauri::command]
fn default_engine() -> EngineInvocation {
	default_engine_invocation()
}

#[tauri::command]
async fn engine_status(state: State<'_, Arc<EngineCell>>) -> Result<EngineStatus, String> {
	let guard = state.live.lock().await;
	Ok(match guard.as_ref() {
		Some(engine) => EngineStatus {
			running: true,
			pid: engine.pid(),
			program: Some(engine.program().to_string()),
		},
		None => EngineStatus { running: false, pid: None, program: None },
	})
}

#[tauri::command]
async fn start_engine(
	app: AppHandle,
	state: State<'_, Arc<EngineCell>>,
	invocation: EngineInvocation,
) -> Result<EngineStatus, String> {
	let mut guard = state.live.lock().await;
	if guard.is_some() {
		return Err("engine is already running".to_string());
	}

	let (tx, mut rx) = mpsc::unbounded_channel();
	let engine = spawn_engine(invocation, tx).await?;
	let status = EngineStatus {
		running: true,
		pid: engine.pid(),
		program: Some(engine.program().to_string()),
	};
	*guard = Some(engine);
	drop(guard);

	let app_for_output = app.clone();
	let cell = Arc::clone(&*state);
	tokio::spawn(async move {
		while let Some(message) = rx.recv().await {
			match message {
				EngineOutput::Stdout(line) => {
					let _ = app_for_output.emit("engine-line", line);
				},
				EngineOutput::Stderr(chunk) => {
					let _ = app_for_output.emit("engine-stderr", chunk);
				},
				EngineOutput::Exited { code } => {
					let _ = app_for_output.emit("engine-exit", code);
					let mut guard = cell.live.lock().await;
					*guard = None;
				},
			}
		}
	});

	let _ = app.emit("engine-started", &status);
	Ok(status)
}

#[tauri::command]
async fn stop_engine(state: State<'_, Arc<EngineCell>>) -> Result<(), String> {
	let mut guard = state.live.lock().await;
	if let Some(engine) = guard.as_mut() {
		engine.kill().await?;
	}
	Ok(())
}

#[tauri::command]
async fn send_line(state: State<'_, Arc<EngineCell>>, value: Value) -> Result<(), String> {
	let mut guard = state.live.lock().await;
	let engine = guard.as_mut().ok_or_else(|| "engine is not running".to_string())?;
	engine.send_value(&value).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let cell = Arc::new(EngineCell::new());
	tauri::Builder::default()
		.manage(cell)
		.invoke_handler(tauri::generate_handler![
			default_engine,
			engine_status,
			start_engine,
			stop_engine,
			send_line
		])
		.run(tauri::generate_context!())
		.expect("error while running Atomic desktop proof of concept");
}
