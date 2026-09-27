use super::*;

fn command_at(path: &std::path::Path, terminal: CommandTerminal) -> Arc<CommandTask> {
	Arc::new(CommandTask {
		intent: CommandIntent {
			kind: CommandTaskKind::Command,
			command: format!("echo UNSUPERVISED > \"{}\"", path.display()).into(),
			description: None,
			cwd: None,
			env: None,
			shell: None,
			inherit_env: None,
			terminal,
			execution_timeout_ms: None,
			parent_task_id: None,
		},
		options: CommandResourceOptions {
			sink: Some(CommandOutputSink::Drained),
			..Default::default()
		},
		background: AtomicBool::new(false),
		output: Mutex::new(OutputStore::new(
			path.with_extension("output"),
			COMMAND_LIVE_BYTES,
			FOREGROUND_SPILL_BYTES,
			TASK_DISK_BYTES,
		)),
		input: Mutex::new(InputQueue::default()),
		resize: Mutex::new(None),
		setup: Mutex::new(None),
		setup_changed: Condvar::new(),
		worker: Mutex::new(None),
		finished: AtomicBool::new(false),
	})
}
#[test]
fn conpty_assignment_refusal_never_runs_marker_and_joins_output_worker() {
	let path = std::env::temp_dir().join(format!("atomic-conpty-refusal-{}", std::process::id()));
	assert!(!path.exists());
	let command = command_at(&path, CommandTerminal::Pty { columns: 80, rows: 24 });
	let failure = match spawn(&command, true) {
		Ok(_) => panic!("uncontained ConPTY command launched"),
		Err(failure) => failure,
	};
	assert_eq!(failure.error.code, "ContainmentUnavailable");
	assert_eq!(failure.cleanup, Cleanup::Reaped {});
	assert!(!path.exists(), "command ran before assignment");
	assert_eq!(Arc::strong_count(&command), 1, "output worker was not joined");
}
#[test]
fn conpty_create_process_failure_closes_console_and_joins_output_worker() {
	let path =
		std::env::temp_dir().join(format!("atomic-conpty-spawn-refusal-{}", std::process::id()));
	let mut command = command_at(&path, CommandTerminal::Pty { columns: 80, rows: 24 });
	Arc::get_mut(&mut command).unwrap().intent.shell = Some(CommandShell {
		program: "C:\\atomic-nonexistent-directory\\missing.exe".into(),
		args: vec![],
	});
	let failure = match spawn(&command, false) {
		Ok(_) => panic!("missing executable launched"),
		Err(failure) => failure,
	};
	assert_eq!(failure.error.code, "SpawnFailed");
	assert_eq!(failure.cleanup, Cleanup::Reaped {});
	assert_eq!(Arc::strong_count(&command), 1, "failed setup detached its reader");
	assert!(!path.exists());
}
#[test]
fn conpty_reader_keeps_settled_spool_open_until_it_stops_3313() {
	let path =
		std::env::temp_dir().join(format!("atomic-conpty-late-writer-{}", std::process::id()));
	let command = command_at(&path, CommandTerminal::Pty { columns: 80, rows: 24 });
	command.output.lock().unwrap().background();
	let spool = command.output.lock().unwrap().path.clone();
	let mut console = None;
	let stdin = PseudoConsole::create(&command, 80, 24, &mut console).unwrap();
	command.output.lock().unwrap().settle();
	let open_while_reading = command.output.lock().unwrap().file.is_some();
	drop(stdin);
	let closed = console.as_mut().unwrap().close_until(Instant::now() + PROCESS_DRAIN_GRACE);
	drop(console);
	let open_after_reader = command.output.lock().unwrap().file.is_some();
	drop(command);
	assert!(open_while_reading, "settled spool closed while the ConPTY reader could still append");
	assert!(closed, "ConPTY reader did not stop");
	assert!(!open_after_reader, "spool stayed open after the ConPTY reader stopped");
	assert!(!spool.exists(), "dropped output store kept its spool");
}
