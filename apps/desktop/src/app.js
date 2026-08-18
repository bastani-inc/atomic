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

	const session = AtomicSession.createSession();
	let requestSeq = 0;
	let connected = false;
	let streaming = false;
	const pending = new Map();

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

	function renderItem(item) {
		const card = document.createElement("article");
		card.className = `card ${item.kind}`;
		card.dataset.id = item.id;
		const role = document.createElement("p");
		role.className = "role";
		const body = document.createElement("p");
		body.className = "body";
		if (item.kind === "user") {
			role.textContent = "You";
			body.textContent = item.text || "";
		} else if (item.kind === "assistant") {
			role.textContent = item.streaming ? "Atomic · streaming" : "Atomic";
			if (item.thinking) {
				const thinking = document.createElement("p");
				thinking.className = "thinking";
				thinking.textContent = item.thinking;
				card.append(role, thinking, body);
				body.textContent = item.text || "";
				return card;
			}
			body.textContent = item.text || "";
		} else if (item.kind === "tool") {
			role.textContent = `${item.toolName} · ${item.phase}`;
			body.textContent = item.output || JSON.stringify(item.args ?? {}, null, 2);
		} else {
			role.textContent = item.kind;
			body.textContent = item.text || "";
		}
		card.append(role, body);
		return card;
	}

	function renderTranscript() {
		const stick = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 48;
		transcriptEl.replaceChildren(...session.items.map(renderItem));
		if (stick || streaming) transcriptEl.scrollTop = transcriptEl.scrollHeight;
	}

	function addStatus(text, kind) {
		session.items.push({
			id: `status-${session.nextId++}`,
			kind: kind || "status",
			text,
		});
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
		if (result.kind === "model" && result.model) {
			modelPillEl.textContent = result.model.id || result.model.name || "model";
		}
		if (result.kind === "session-name" && result.name) sessionLabelEl.textContent = result.name;
		if (result.kind === "ui") handleUiRequest(result.request).catch((error) => addStatus(error.message, "error"));
	}

	async function startEngine() {
		const invocation = {
			program: programEl.value.trim(),
			args: argsEl.value.trim() ? argsEl.value.trim().split(/\s+/).filter(Boolean) : [],
			cwd: cwdEl.value.trim() || null,
		};
		setHint("Starting engine…");
		try {
			const status = await invoke("start_engine", { invocation });
			setConnected(true);
			setHint(status.pid ? `Engine pid ${status.pid}` : "Engine started");
			try {
				await sendCommand({ type: "get_state" });
				await sendCommand({ type: "get_messages" });
			} catch (error) {
				addStatus(error.message, "error");
			}
		} catch (error) {
			setRunState("error", "error");
			setHint(error.message || String(error));
			addStatus(error.message || String(error), "error");
		}
	}

	async function stopEngine() {
		try {
			await invoke("stop_engine");
		} catch (error) {
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
			if (streaming) command.streamingBehavior = "followUp";
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
		argsEl.value = (invocation.args || []).join(" ");
		cwdEl.value = invocation.cwd || "";

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
			if (event.payload && String(event.payload).trim()) {
				console.debug(event.payload);
			}
		});
		await tauri().event.listen("engine-exit", (event) => {
			for (const waiter of pending.values()) waiter.reject(new Error("engine exited"));
			pending.clear();
			setConnected(false);
			setStreaming(false);
			setHint(`Engine exited${event.payload == null ? "" : ` (${event.payload})`}.`);
		});

		toggleEl.addEventListener("click", () => {
			if (connected) stopEngine();
			else startEngine();
		});
		document.getElementById("composer").addEventListener("submit", onSubmit);
		abortEl.addEventListener("click", onAbort);
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
