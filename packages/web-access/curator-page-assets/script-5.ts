export const CURATOR_PAGE_SCRIPT_5 = `    }

    var signature = selectionSignature(selected);
    if (signature === lastAutoSummarySignature) {
      if (isRegenerating) {
        isRegenerating = false;
        if (getSummaryDraftText().length > 0) {
          stage = "summary-review";
        }
        updateStageUI();
      }
      return;
    }

    lastAutoSummarySignature = signature;
    requestSummary(selected);
  }

  function doApprove() {
    if (submitted || timerExpired || submitInFlight || stage !== "summary-review") return;

    var selected = getSelectedIndices();
    if (selected.length === 0) {
      setError("Select at least one result before approving");
      updateStageUI();
      return;
    }

    var draft = getSummaryDraftText();
    var payload = { selected: selected };
    if (draft.length > 0) {
      payload.summary = draft;
      payload.summaryMeta = normalizeSummaryMeta(summaryMeta, summaryMeta && summaryMeta.edited === true);
    }

    submitPayload(payload, "Summary approved")
      .catch(function(err) {
        var message = err instanceof Error ? err.message : String(err);
        setError("Failed to approve summary — " + (message || "the agent may have moved on"));
      });
  }

  function doCancel() {
    if (submitted || timerExpired || submitInFlight) return;
    submitted = true;
    submitInFlight = true;
    syncLoadingPanel();
    updateStageUI();
    clearError();

    postJson("/cancel", { reason: "user" })
      .then(function(data) {
        if (data && data.ok === false) {
          throw new Error(extractServerError(data) || "cancel rejected");
        }
        showSuccess("Skipped");
      })
      .catch(function(err) {
        submitted = false;
        submitInFlight = false;
        syncLoadingPanel();
        updateStageUI();
        var message = err instanceof Error ? err.message : String(err);
        setError("Failed to cancel — " + (message || "the agent may have moved on"));
      });
  }

  btnSend.addEventListener("click", function() {
    if (stage !== "results") return;
    requestSummary(getSelectedIndices());
  });

  if (btnSendRaw) {
    btnSendRaw.addEventListener("click", function() {
      var selected = getSelectedIndices();
      if (selected.length === 0) return;
      submitPayload({ selected: selected, rawResults: true }, "Results sent")
        .catch(function(err) {
          var message = err instanceof Error ? err.message : String(err);
          setError("Failed to send results — " + (message || "the agent may have moved on"));
        });
    });
  }

  if (btnSummaryBack) {
    btnSummaryBack.addEventListener("click", function() {
      if (exitRegeneratingState()) {
        resetTimer();
        return;
      }
      if (stage !== "summary-review") return;
      clearError();
      stage = "results";
      updateStageUI();
      resetTimer();
    });
  }

  if (btnSummaryRegenerate) {
    btnSummaryRegenerate.addEventListener("click", function() {
      requestSummary(getSelectedIndices(), getFeedbackText());
      resetTimer();
    });
  }

  function openPreviewModal() {
    var draft = getSummaryDraftText();
    if (!draft || !previewModal || !previewModalBody) return;
    var rendered = typeof marked !== "undefined" && marked.parse
      ? marked.parse(draft, { breaks: true })
      : "<pre>" + escHtml(draft) + "</pre>";
    previewModalBody.innerHTML = sanitizeMarkdownHtml(rendered);
    if (previewModalModel) {
      previewModalModel.innerHTML = '<option value="">Auto</option>';
      for (var i = 0; i < summaryModels.length; i++) {
        var m = summaryModels[i];
        var opt = document.createElement("option");
        opt.value = m.value;
        opt.textContent = m.label;
        previewModalModel.appendChild(opt);
      }
      previewModalModel.value = getSelectedSummaryModel() || "";
    }
    previewModal.classList.remove("hidden");
    resetTimer();
  }

  function closePreviewModal() {
    if (previewModal) previewModal.classList.add("hidden");
    if (previewModalBody) previewModalBody.innerHTML = "";
    hidePreviewPopover();
  }

  var popoverSelectedText = "";

  function hidePreviewPopover() {
    if (previewPopover) previewPopover.classList.add("hidden");
    if (previewPopoverInput) previewPopoverInput.value = "";
    popoverSelectedText = "";
  }

  function showPreviewPopover(text, rect) {
    if (!previewPopover || !previewPopoverQuote || !previewModalBody) return;
    popoverSelectedText = text;
    var display = text.length > 120 ? text.slice(0, 117) + "\u2026" : text;
    previewPopoverQuote.textContent = "\u201c" + display + "\u201d";
    if (previewPopoverInput) previewPopoverInput.value = "";
    previewPopover.classList.remove("hidden");

    var bodyRect = previewModalBody.getBoundingClientRect();
    var popH = previewPopover.offsetHeight;
    var top = rect.bottom - bodyRect.top + previewModalBody.scrollTop + 6;
    if (rect.bottom + popH + 20 > bodyRect.bottom) {
      top = rect.top - bodyRect.top + previewModalBody.scrollTop - popH - 6;
    }
    var left = Math.max(8, Math.min(rect.left - bodyRect.left, bodyRect.width - previewPopover.offsetWidth - 8));
    previewPopover.style.top = top + "px";
    previewPopover.style.left = left + "px";

    if (previewPopoverInput) previewPopoverInput.focus();
  }

  if (btnSummaryPreview) {
    btnSummaryPreview.addEventListener("click", openPreviewModal);
  }
  if (previewModalClose) {
    previewModalClose.addEventListener("click", closePreviewModal);
  }
  if (previewModalRegenerate) {
    previewModalRegenerate.addEventListener("click", function() {
      var selectedModel = previewModalModel ? previewModalModel.value.trim() : "";
      closePreviewModal();
      var modelProvider = getSummaryProvider(selectedModel);
      if (modelProvider && modelProvider !== currentSummaryProvider) {
        setSummaryProvider(modelProvider, selectedModel);
      } else if (summaryModelSelect) {
        summaryModelSelect.value = selectedModel;
        currentSummaryModel = selectedModel;
      }
      requestSummary(getSelectedIndices(), getFeedbackText());
      resetTimer();
    });
  }
  if (previewModalApprove) {
    previewModalApprove.addEventListener("click", function() {
      closePreviewModal();
      doApprove();
    });
  }
  if (previewModalBody) {
    previewModalBody.addEventListener("mouseup", function() {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var text = sel.toString().trim();
      if (!text) return;
      var range = sel.getRangeAt(0);
      showPreviewPopover(text, range.getBoundingClientRect());
    });
    previewModalBody.addEventListener("mousedown", function(e) {
      if (previewPopover && !previewPopover.contains(e.target)) {
        hidePreviewPopover();
      }
    });
  }

  if (previewPopoverRegen) {
    previewPopoverRegen.addEventListener("click", function() {
      var note = previewPopoverInput ? previewPopoverInput.value.trim() : "";
      var quoted = popoverSelectedText;
      hidePreviewPopover();

      var feedback = 'Regarding: "' + quoted + '"';
      if (note) feedback += " \u2014 " + note;

      var selectedModel = previewModalModel ? previewModalModel.value.trim() : "";
      closePreviewModal();
      var modelProvider = getSummaryProvider(selectedModel);
      if (modelProvider && modelProvider !== currentSummaryProvider) {
        setSummaryProvider(modelProvider, selectedModel);
      } else if (summaryModelSelect) {
        summaryModelSelect.value = selectedModel;
        currentSummaryModel = selectedModel;
      }
      requestSummary(getSelectedIndices(), feedback);
      resetTimer();
    });
  }

  if (previewPopoverInput) {
    previewPopoverInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (previewPopoverRegen) previewPopoverRegen.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        hidePreviewPopover();
      }
    });
  }

  if (previewModal) {
    previewModal.addEventListener("click", function(e) {
      if (e.target === previewModal) closePreviewModal();
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && !previewModal.classList.contains("hidden")) {
        if (previewPopover && !previewPopover.classList.contains("hidden")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          hidePreviewPopover();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        closePreviewModal();
      }
    });
  }

  if (btnSummaryApprove) {
    btnSummaryApprove.addEventListener("click", function() {
      doApprove();
      resetTimer();
    });
  }

  if (summaryInput) {
    summaryInput.addEventListener("input", function() {
      if (!summaryMeta || typeof summaryMeta !== "object") {
        summaryMeta = normalizeSummaryMeta(null, true);
      }
      summaryMeta.edited = true;
      clearError();
      updateStageUI();
      resetTimer();
    });
  }

  if (summaryProviderSelect) {
    summaryProviderSelect.addEventListener("change", function() {
      var provider = typeof summaryProviderSelect.value === "string" ? summaryProviderSelect.value : "";
      if (!provider || provider === currentSummaryProvider) return;
      setSummaryProvider(provider, "");
      clearError();
      updateStageUI();
      resetTimer();
    });
  }

  if (summaryModelSelect) {
    summaryModelSelect.addEventListener("change", function() {
      currentSummaryModel = typeof summaryModelSelect.value === "string"
        ? summaryModelSelect.value.trim()
        : "";
      clearError();
      resetTimer();
    });
  }

  function isInteractiveTarget(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return true;
    if (typeof target.isContentEditable === "boolean" && target.isContentEditable) return true;
    if (typeof target.closest === "function") {
      return !!target.closest('[contenteditable=""], [contenteditable="true"]');
    }
    return false;
  }

  document.addEventListener("keydown", function(e) {
    if (submitted || timerExpired || submitInFlight) return;

    var isSummaryInput = summaryInput && e.target === summaryInput;
    if (isSummaryInput && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (stage === "summary-review") doApprove();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (exitRegeneratingState()) {
        return;
      }
      if (stage === "summary-review") {
        stage = "results";
        clearError();
        updateStageUI();
      } else if (stage === "results") {
        doCancel();
      }
      return;
    }

    if (isInteractiveTarget(e.target)) return;

    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      if (stage !== "results") return;
      e.preventDefault();
      requestSummary(getSelectedIndices());
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if (stage !== "summary-review") return;
      e.preventDefault();
      doApprove();
      return;
    }

    if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (stage !== "results") return;
      var boxes = resultCardsEl.querySelectorAll(".result-card input[type=checkbox]");
      var selectable = [];
      boxes.forEach(function(cb) {
        if (cb.disabled) return;
        selectable.push(cb);
      });
      if (selectable.length === 0) return;
      var allChecked = true;
      selectable.forEach(function(cb) { if (!cb.checked) allChecked = false; });
      selectable.forEach(function(cb) {
        cb.checked = !allChecked;
        var parentCard = typeof cb.closest === "function" ? cb.closest(".result-card") : null;
        if (parentCard) parentCard.classList.toggle("checked", cb.checked);
      });
      updateStageUI();
      maybeAutoGenerateSummary();
      resetTimer();
    }
  });

  setInterval(function() {
    if (submitted) return;
    postJson("/heartbeat", {}).catch(function() {
      // Heartbeat is best-effort.
    });
  }, 10000);

  var lastResizeHeight = 0;
  function checkContentHeight() {
    if (!window.glimpse || typeof window.glimpse.send !== "function") return;
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (h > 0 && Math.abs(h - lastResizeHeight) > 30) {
      lastResizeHeight = h;
      window.glimpse.send({ type: "resize", height: h });
    }
  }
  setInterval(checkContentHeight, 500);

  if (queries.length === 0 && addSearchInput) {
    addSearchInput.focus();
  }
})();`;
