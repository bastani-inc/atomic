(function () {
	"use strict";

	const transcriptEl = document.getElementById("transcript");
	const promptEl = document.getElementById("prompt");
	const sendEl = document.getElementById("send");
	const abortEl = document.getElementById("abort");
	const hintEl = document.getElementById("hint");
	const toggleEl = document.getElementById("engine-toggle");
	const programEl = document.getElementById("engine-program");
	const argsEl = document.getElementById("engine-args");
	const cwdEl = document.getElementById("engine-cwd");
	const sessionLabelEl = document.getElementById("session-label");
	const modelPillEl = document.getElementById("model-pill");
	const runPillEl = document.getElementById("run-pill");
	const dialogEl = document.getElementById("ui-dialog");
	const uiTitleEl = document.getElementById("ui-title");
	const uiMessageEl = document.getElementById("ui-message");
	const uiBodyEl = document.getElementById("ui-body");
	const uiConfirmEl = document.getElementById("ui-confirm");
	const streamingBehaviorEl = document.getElementById("streaming-behavior");
	const diagnosticsLogEl = document.getElementById("diagnostics-log");
	const copyDiagnosticsEl = document.getElementById("copy-diagnostics");

	const session = AtomicSession.createSession();
	let requestSeq = 0;
	let connected = false;
	let streaming = false;
	const pending = new Map();
	const diagnostics = {
		program: "",
		args: [],
		cwd: "",
		pid: null,
		stderr: "",
		lastExit: null,
		lastError: null,
		notes: [],
	};
	let stderrCarry = "";

	function tauri() {
		return window.__TAURI__;
	}

	async function invoke(command, payload) {
		if (!tauri()) throw new Error("This page must run inside the Tauri host.");
		return tauri().core.invoke(command, payload);
	}

	function nextId(prefix) {
		requestSeq += 1;
		return `${prefix}-${requestSeq}`;
	}

	function setRunState(state, label) {
		runPillEl.dataset.state = state;
		runPillEl.textContent = label;
	}

	function setHint(text) {
		hintEl.textContent = text;
	}

	function renderDiagnostics() {
		const lines = [
			`program: ${diagnostics.program || "(empty)"}`,
			`args:`,
			...(diagnostics.args.length ? diagnostics.args.map((arg) => `  ${arg}`) : ["  (none)"]),
			`cwd: ${diagnostics.cwd || "(empty)"}`,
			`pid: ${diagnostics.pid ?? "(not running)"}`,
			`lastExit: ${diagnostics.lastExit ?? "(none)"}`,
			`lastError: ${diagnostics.lastError ?? "(none)"}`,
			"",
			"stderr:",
			diagnostics.stderr.trim() ? diagnostics.stderr : "(empty)",
		];
		if (diagnostics.notes.length) {
			lines.push("", "notes:", ...diagnostics.notes.map((note) => `- ${note}`));
		}
		diagnosticsLogEl.textContent = lines.join("\n");
	}

	function noteDiagnostic(text) {
		diagnostics.notes.push(text);
		if (diagnostics.notes.length > 40) diagnostics.notes.shift();
		renderDiagnostics();
	}

	function syncPathTitles() {
		programEl.title = programEl.value;
		cwdEl.title = cwdEl.value;
	}

	function setConnected(value) {
		connected = value;
		promptEl.disabled = !value;
		sendEl.disabled = !value;
		abortEl.disabled = !value || !streaming;
		toggleEl.textContent = value ? "Stop engine" : "Start engine";
		if (!value) setRunState("idle", "idle");
	}

	function setStreaming(value) {
		streaming = value;
		abortEl.disabled = !connected || !value;
		setRunState(value ? "running" : connected ? "idle" : "idle", value ? "running" : "idle");
	}

	function formatQueueHint(queue) {
		const steering = (queue && queue.steering) || [];
		const followUp = (queue && queue.followUp) || [];
		if (!steering.length && !followUp.length) return "";
		const parts = [];
		if (steering.length) parts.push(`steer: ${steering.join(" | ")}`);
		if (followUp.length) parts.push(`follow-up: ${followUp.join(" | ")}`);
		return `Queued ${parts.join("; ")}`;
	}

	function assistantRole(item) {
		if (item.streaming) return "Atomic · streaming";
		if (item.stopReason === "aborted") return "Atomic · aborted";
		if (item.stopReason === "error") return "Atomic · error";
		if (item.stopReason && item.stopReason !== "stop" && item.stopReason !== "toolUse") {
			return `Atomic · ${item.stopReason}`;
		}
		return "Atomic";
	}

	function renderItem(item) {
		const card = document.createElement("article");
		card.className = `card ${item.kind}`;
		card.dataset.id = item.id;
		const role = document.createElement("p");
		role.className = "role";
		if (item.kind === "user") {
			role.textContent = "You";
			const body = document.createElement("p");
			body.className = "body";
			body.textContent = item.text || "";
			card.append(role, body);
			return card;
		}
		if (item.kind === "assistant") {
			if (item.stopReason === "aborted" || item.stopReason === "error") card.classList.add("stopped");
			role.textContent = assistantRole(item);
			card.append(role);
			if (item.thinking) {
				const thinking = document.createElement("p");
				thinking.className = "thinking";
				thinking.textContent = item.thinking;
				card.append(thinking);
			}
			const body = document.createElement("p");
			body.className = "body";
			body.textContent = item.text || item.errorMessage || "";
			card.append(body);
			return card;
		}
		if (item.kind === "tool") {
			const phase = item.phase || "running";
			card.classList.add(`phase-${phase}`);
			role.textContent = item.toolName || "tool";
			const badge = document.createElement("span");
			badge.className = `phase phase-${phase}`;
			badge.textContent = phase;
			role.append(badge);
			card.append(role);
			const args = document.createElement("pre");
			args.className = "tool-args";
			args.textContent =
				item.args == null || item.args === ""
					? ""
					: typeof item.args === "string"
						? item.args
						: JSON.stringify(item.args, null, 2);
			if (args.textContent) card.append(args);
			if (item.output) {
				const output = document.createElement("pre");
				output.className = "tool-output body";
				output.textContent = item.output;
				card.append(output);
			}
			return card;
		}
		role.textContent = item.kind;
		const body = document.createElement("p");
		body.className = "body";
		body.textContent = item.text || "";
		card.append(role, body);
		return card;
	}

	function renderTranscript() {
		const stick = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 48;
		transcriptEl.replaceChildren(...session.items.map(renderItem));
		if (stick || streaming) transcriptEl.scrollTop = transcriptEl.scrollHeight;
	}

	function addStatus(text, kind) {
		AtomicSession.appendHost(session, kind || "status", text);
		renderTranscript();
	}

	async function sendCommand(command) {
		const id = command.id || nextId("req");
		const value = { ...command, id };
		await invoke("send_line", { value });
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, command: value.type });
		});
	}

	function handleResponse(frame) {
		const waiter = pending.get(frame.id);
		if (!waiter) return;
		pending.delete(frame.id);
		if (frame.success) waiter.resolve(frame);
		else waiter.reject(new Error(frame.error || `${waiter.command} failed`));
	}

	async function handleUiRequest(request) {
		const method = request.method;
		if (method === "notify" || method === "setStatus" || method === "setTitle") {
			if (method === "setTitle" && request.title) sessionLabelEl.textContent = request.title;
			else setHint(request.message || request.text || request.title || method);
			return;
		}
		if (method === "setWidget" || method === "set_editor_text") return;

		uiTitleEl.textContent = request.title || "Extension prompt";
		uiMessageEl.textContent = request.message || "";
		uiBodyEl.replaceChildren();
		uiConfirmEl.hidden = false;

		let collect = () => ({ cancelled: true });
		if (method === "confirm") {
			uiConfirmEl.value = "ok";
			uiConfirmEl.textContent = "Confirm";
			collect = (submitter) =>
				submitter && submitter.value === "ok" ? { confirmed: true } : { cancelled: true };
		} else if (method === "select") {
			const select = document.createElement("select");
			for (const option of request.options || []) {
				const node = document.createElement("option");
				node.value = option;
				node.textContent = option;
				select.append(node);
			}
			uiBodyEl.append(select);
			collect = (submitter) =>
				submitter && submitter.value === "ok" ? { value: select.value } : { cancelled: true };
		} else if (method === "input" || method === "editor") {
			const field = document.createElement(method === "editor" ? "textarea" : "input");
			if (method === "editor") field.rows = 8;
			field.value = request.value || request.text || "";
			uiBodyEl.append(field);
			collect = (submitter) =>
				submitter && submitter.value === "ok" ? { value: field.value } : { cancelled: true };
		} else {
			addStatus(`Unhandled extension UI method: ${method}`, "error");
			await invoke("send_line", {
				value: { type: "extension_ui_response", id: request.id, cancelled: true },
			});
			return;
		}

		const result = await new Promise((resolve) => {
			const onClose = () => {
				dialogEl.removeEventListener("close", onClose);
				const submitter = dialogEl.returnValue === "ok" ? uiConfirmEl : null;
				resolve(collect(submitter));
			};
			dialogEl.addEventListener("close", onClose);
			dialogEl.showModal();
		});
		await invoke("send_line", {
			value: { type: "extension_ui_response", id: request.id, ...result },
		});
	}

	function applyFrame(frame) {
		if (!frame || typeof frame !== "object") return;
		if (frame.type === "response") {
			handleResponse(frame);
			if (frame.command === "get_state" && frame.data) {
				if (frame.data.model) {
					modelPillEl.textContent = frame.data.model.id || frame.data.model.name || "model";
				}
				if (frame.data.sessionName) sessionLabelEl.textContent = frame.data.sessionName;
				else if (frame.data.sessionId) sessionLabelEl.textContent = frame.data.sessionId;
				setStreaming(Boolean(frame.data.isStreaming));
			}
			if (frame.command === "get_messages" && frame.data) {
				AtomicSession.loadMessages(session, frame.data.messages);
				renderTranscript();
			}
			return;
		}
		const result = AtomicSession.handleEvent(session, frame);
		if (result.kind === "transcript") renderTranscript();
		if (result.kind === "status") setStreaming(Boolean(result.streaming));
		if (result.kind === "queue") {
			const hint = formatQueueHint(result.queue);
			if (hint) setHint(hint);
		}
		if (result.kind === "model" && result.model) {
			modelPillEl.textContent = result.model.id || result.model.name || "model";
		}
		if (result.kind === "session-name" && result.name) sessionLabelEl.textContent = result.name;
		if (result.kind === "ui") handleUiRequest(result.request).catch((error) => addStatus(error.message, "error"));
	}

	function ingestStderr(chunk) {
		const text = String(chunk ?? "");
		if (!text) return;
		diagnostics.stderr += text;
		if (diagnostics.stderr.length > 64 * 1024) {
			diagnostics.stderr = diagnostics.stderr.slice(-32 * 1024);
		}
		renderDiagnostics();
		stderrCarry += text;
		let newline = stderrCarry.indexOf("\n");
		while (newline !== -1) {
			const line = stderrCarry.slice(0, newline).replace(/\r$/, "").trim();
			stderrCarry = stderrCarry.slice(newline + 1);
			if (line) addStatus(line, "stderr");
			newline = stderrCarry.indexOf("\n");
		}
	}

	async function copyDiagnostics() {
		const text = diagnosticsLogEl.textContent || "";
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				const field = document.createElement("textarea");
				field.value = text;
				document.body.append(field);
				field.select();
				document.execCommand("copy");
				field.remove();
			}
			noteDiagnostic("Copied diagnostics to clipboard.");
			setHint("Diagnostics copied.");
		} catch (error) {
			setHint(error.message || String(error));
		}
	}

	async function startEngine() {
		const invocation = {
			program: programEl.value.trim(),
			args: AtomicSession.parseArgLines(argsEl.value),
			cwd: cwdEl.value.trim() || null,
		};
		diagnostics.program = invocation.program;
		diagnostics.args = invocation.args;
		diagnostics.cwd = invocation.cwd || "";
		diagnostics.pid = null;
		diagnostics.stderr = "";
		diagnostics.lastExit = null;
		diagnostics.lastError = null;
		stderrCarry = "";
		renderDiagnostics();
		setHint("Starting engine…");
		try {
			const status = await invoke("start_engine", { invocation });
			diagnostics.pid = status.pid ?? null;
			renderDiagnostics();
			setConnected(true);
			setHint(status.pid ? `Engine pid ${status.pid}` : "Engine started");
			try {
				await sendCommand({ type: "get_state" });
				await sendCommand({ type: "get_messages" });
			} catch (error) {
				diagnostics.lastError = error.message || String(error);
				renderDiagnostics();
				addStatus(error.message, "error");
			}
		} catch (error) {
			const message = error.message || String(error);
			diagnostics.lastError = message;
			renderDiagnostics();
			setRunState("error", "error");
			setHint(message);
			addStatus(message, "error");
		}
	}

	async function stopEngine() {
		try {
			await invoke("stop_engine");
		} catch (error) {
			diagnostics.lastError = error.message || String(error);
			renderDiagnostics();
			addStatus(error.message, "error");
		}
	}

	async function onSubmit(event) {
		event.preventDefault();
		const text = promptEl.value.trim();
		if (!text || !connected) return;
		promptEl.value = "";
		AtomicSession.noteLocalUser(session, text);
		renderTranscript();
		try {
			const command = { type: "prompt", message: text };
			if (streaming) command.streamingBehavior = streamingBehaviorEl.value || "followUp";
			await sendCommand(command);
		} catch (error) {
			addStatus(error.message, "error");
			setRunState("error", "error");
		}
	}

	async function onAbort() {
		try {
			await sendCommand({ type: "abort" });
		} catch (error) {
			addStatus(error.message, "error");
		}
	}

	async function boot() {
		if (!tauri()) {
			setHint("Open this UI through the Tauri host, not a plain browser tab.");
			toggleEl.disabled = true;
			return;
		}
		const invocation = await invoke("default_engine");
		programEl.value = invocation.program || "";
		argsEl.value = AtomicSession.formatArgLines(invocation.args || []);
		cwdEl.value = invocation.cwd || "";
		syncPathTitles();
		renderDiagnostics();

		await tauri().event.listen("engine-line", (event) => {
			const line = String(event.payload ?? "").trim();
			if (!line) return;
			try {
				applyFrame(JSON.parse(line));
			} catch {
				addStatus(`Non-JSON engine line: ${line}`, "error");
			}
		});
		await tauri().event.listen("engine-stderr", (event) => {
			if (event.payload) ingestStderr(event.payload);
		});
		await tauri().event.listen("engine-exit", (event) => {
			for (const waiter of pending.values()) waiter.reject(new Error("engine exited"));
			pending.clear();
			setConnected(false);
			setStreaming(false);
			diagnostics.pid = null;
			diagnostics.lastExit = event.payload == null ? "null" : String(event.payload);
			if (stderrCarry.trim()) addStatus(stderrCarry.trim(), "stderr");
			stderrCarry = "";
			renderDiagnostics();
			const code = event.payload == null ? "" : ` (${event.payload})`;
			setHint(`Engine exited${code}.`);
			addStatus(`Engine exited${code}.`, event.payload && event.payload !== 0 ? "error" : "status");
		});

		toggleEl.addEventListener("click", () => {
			if (connected) stopEngine();
			else startEngine();
		});
		document.getElementById("composer").addEventListener("submit", onSubmit);
		abortEl.addEventListener("click", onAbort);
		copyDiagnosticsEl.addEventListener("click", () => {
			copyDiagnostics().catch((error) => setHint(error.message || String(error)));
		});
		programEl.addEventListener("input", syncPathTitles);
		cwdEl.addEventListener("input", syncPathTitles);
		promptEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				document.getElementById("composer").requestSubmit();
			}
		});
	}

	boot().catch((error) => {
		setHint(error.message || String(error));
		setRunState("error", "error");
	});
})();
