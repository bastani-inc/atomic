export const CURATOR_PAGE_SCRIPT_2 = `  }

  function isResultMutationLocked() {
    return submitted || timerExpired || submitInFlight;
  }

  function applyProviderInterlocks() {
    var disableProviders = isResultMutationLocked() || providerBatchInFlight || addSearchInFlight;
    for (var i = 0; i < providerButtons.length; i++) {
      var btn = providerButtons[i];
      var state = btn.dataset.state || "idle";
      btn.disabled = disableProviders || state === "loading";
    }

    var disableAddSearch = isResultMutationLocked();
    if (addSearchInput) {
      addSearchInput.disabled = disableAddSearch;
    }

    if (addSearchEl) {
      addSearchEl.style.opacity = disableAddSearch ? "0.6" : "";
      addSearchEl.style.pointerEvents = disableAddSearch ? "none" : "";
    }

    var cards = resultCardsEl ? resultCardsEl.querySelectorAll(".result-card") : [];
    cards.forEach(function(card) {
      var cb = card.querySelector("input[type=checkbox]");
      if (!cb) return;
      var searching = card.classList.contains("searching");
      var error = card.classList.contains("error");
      cb.disabled = searching || error || isResultMutationLocked();
    });
  }

  function recomputeProviderStates() {
    for (var i = 0; i < providerButtons.length; i++) {
      var btn = providerButtons[i];
      var provider = normalizeProvider(btn.dataset.provider, "");
      if (!provider) continue;

      var state = "idle";
      if (providerBatchInFlight && batchLoadingProvider === provider) {
        state = "loading";
      } else if (!initialStreamDone && queries.length > 0 && provider === initialDefaultProvider) {
        state = "loading";
      } else if (allQueries.length > 0) {
        var coveredSlots = providerCoverage.get(provider);
        if (coveredSlots && coveredSlots.size >= allQueries.length) {
          state = "searched";
        }
      }

      btn.dataset.state = state;
      btn.classList.remove("idle", "loading", "searched");
      btn.classList.add(state);
      btn.classList.toggle("is-default", provider === currentProvider);
    }

    applyProviderInterlocks();
  }

  function updateSummaryText() {
    if (completedCount <= 0) return;
    var totalCards = resultCardsEl.querySelectorAll(".result-card").length;
    var searchingCount = totalCards - completedCount;
    if (searchingCount > 0) {
      heroTitle.textContent = completedCount + " of " + totalCards + " Searches Complete";
    } else {
      heroTitle.textContent = completedCount + " Search" + (completedCount !== 1 ? "es" : "") + " Complete";
    }
    heroDesc.textContent = "Check the results to include, then generate and approve a summary.";
    if (heroStatus) heroStatus.textContent = completedCount + " completed" + (searchingCount > 0 ? ", " + searchingCount + " searching" : "");
  }

  function getSummaryDraftText() {
    if (!summaryInput || typeof summaryInput.value !== "string") return "";
    return summaryInput.value.trim();
  }

  function clearError() {
    if (!errorBanner) return;
    errorBanner.hidden = true;
    errorBanner.textContent = "";
  }

  function setError(text) {
    if (!errorBanner) return;
    errorBanner.textContent = text;
    errorBanner.hidden = false;
  }

  function updateSummaryGeneratingIndicator() {
    if (!summaryGeneratingCopy) return;

    if (stage !== "generating-summary") {
      summaryGeneratingCopy.textContent = "Generating summary draft…";
      summaryGeneratingPhase = -1;
      if (summaryGeneratingEl) {
        summaryGeneratingEl.removeAttribute("data-phase");
      }
      return;
    }

    if (summaryGeneratingStartedAt <= 0) {
      summaryGeneratingStartedAt = Date.now();
    }

    var elapsedMs = Date.now() - summaryGeneratingStartedAt;
    var nextPhase = Math.min(2, Math.floor(elapsedMs / 1800));
    if (nextPhase === summaryGeneratingPhase) return;

    summaryGeneratingPhase = nextPhase;

    var phaseLabel = "Planning summary";
    if (nextPhase === 1) phaseLabel = "Drafting summary";
    if (nextPhase === 2) phaseLabel = "Polishing summary";

    summaryGeneratingCopy.textContent = summaryPendingModel
      ? phaseLabel + " with " + summaryPendingModel + "…"
      : phaseLabel + "…";

    if (summaryGeneratingEl) {
      summaryGeneratingEl.dataset.phase = String(nextPhase);
    }
  }

  function updateStageUI() {
    var showSummary = stage === "summary-review" || stage === "generating-summary" || isRegenerating;
    if (summaryPanel) {
      summaryPanel.classList.toggle("hidden", !showSummary);
      summaryPanel.classList.toggle("updating", isRegenerating);
    }
    if (summarySubtitle) {
      var selCount = getSelectedIndices().length;
      var selLabel = selCount + " selected result" + (selCount !== 1 ? "s" : "");
      if (isRegenerating && stage === "generating-summary") {
        summarySubtitle.textContent = "Selection changed — regenerating summary…";
      } else if (isRegenerating) {
        summarySubtitle.textContent = "Selection changed — summary will regenerate shortly…";
      } else if (stage === "generating-summary") {
        summarySubtitle.textContent = summaryPendingModel
          ? "Summarizing " + selLabel + " with " + summaryPendingModel + "…"
          : "Summarizing " + selLabel + "…";
      } else if (summaryMeta && summaryMeta.fallbackUsed) {
        summarySubtitle.textContent = "Fallback summary of " + selLabel + ".";
      } else {
        summarySubtitle.textContent = "Summary of " + selLabel + ". Edit directly, regenerate with feedback, or approve.";
      }
    }

    if (summaryGeneratingEl) {
      var showGenerating = stage === "generating-summary" && !isRegenerating;
      summaryGeneratingEl.classList.toggle("hidden", !showGenerating);
    }
    updateSummaryGeneratingIndicator();

    if (summaryInput) {
      summaryInput.classList.toggle("hidden", stage === "generating-summary" && !isRegenerating);
      summaryInput.disabled = submitted || timerExpired || stage === "generating-summary" || submitInFlight || isRegenerating;
    }
    if (summaryFeedback) {
      summaryFeedback.disabled = submitted || timerExpired || submitInFlight || stage === "generating-summary" || isRegenerating;
    }
    var disableSummaryModelControls = submitted || timerExpired || stage === "generating-summary" || submitInFlight || summaryProviders.length === 0;
    if (summaryProviderSelect) {
      summaryProviderSelect.disabled = disableSummaryModelControls;
    }
    if (summaryModelSelect) {
      summaryModelSelect.disabled = disableSummaryModelControls;
    }

    var inResults = stage === "results";
    var hasSelection = getSelectedIndices().length > 0;
    var hasCompleted = getCompletedSelectableIndices().length > 0;
    var canGenerate = inResults && !submitted && !timerExpired && !submitInFlight && hasCompleted;

    if (btnSend) {
      if (stage === "generating-summary") {
        btnSend.textContent = "Generating summary…";
        btnSend.disabled = true;
      } else if (!inResults) {
        btnSend.textContent = "Summary ready";
        btnSend.disabled = true;
      } else if (!hasCompleted) {
        btnSend.textContent = searchesDone ? "No results yet" : "Waiting for results…";
        btnSend.disabled = true;
      } else {
        btnSend.textContent = hasSelection ? "Generate summary" : "Select results to summarize";
        btnSend.disabled = !canGenerate || !hasSelection;
      }
    }
    if (sendRawRow) {
      sendRawRow.classList.toggle("hidden", !hasSelection || submitted || timerExpired);
    }
    if (btnSendRaw) {
      btnSendRaw.disabled = !hasSelection || submitted || timerExpired || submitInFlight;
    }

    if (btnSummaryBack) btnSummaryBack.disabled = submitted || timerExpired || submitInFlight || (stage === "generating-summary" && !isRegenerating);
    if (btnSummaryRegenerate) btnSummaryRegenerate.disabled = submitted || timerExpired || submitInFlight || stage === "generating-summary" || isRegenerating;
    var hasDraft = getSummaryDraftText().length > 0;
    if (btnSummaryPreview) btnSummaryPreview.disabled = !hasDraft || stage === "generating-summary";
    if (btnSummaryApprove) {
      btnSummaryApprove.disabled = submitted || timerExpired || submitInFlight || stage === "generating-summary" || isRegenerating || !hasSelection || !hasDraft;
    }

    applyProviderInterlocks();
  }

  function shouldShowLoadingPanel() {
    if (submitted || timerExpired || searchesDone) return false;
    if (completedCount > 0) return false;
    return allQueries.length > 0;
  }

  function ensureLoadingPanel() {
    if (loadingPanelEl) return loadingPanelEl;
    if (!resultCardsEl) return null;

    var panel = document.createElement("div");
    panel.className = "result-loading";
    panel.innerHTML =
      '<div class="result-loading-header">' +
        '<div class="result-loading-title">Searching sources</div>' +
        '<div class="result-loading-sub">Searching\u2026</div>' +
      '</div>' +
      '<div class="result-loading-grid">' +
        '<div class="loading-card"><div class="loading-card-row long"></div><div class="loading-card-row mid"></div><div class="loading-card-row short"></div></div>' +
        '<div class="loading-card"><div class="loading-card-row long"></div><div class="loading-card-row mid"></div><div class="loading-card-row short"></div></div>' +
      '</div>';

    resultCardsEl.prepend(panel);
    loadingPanelEl = panel;
    return panel;
  }

  function updateLoadingPanelSummary() {
    if (!loadingPanelEl) return;
    var sub = loadingPanelEl.querySelector(".result-loading-sub");
    if (!sub) return;

    var total = allQueries.length;
    if (total <= 0) {
      sub.textContent = "Searching\u2026";
      return;
    }

    var done = Math.min(completedCount, total);
    var noun = total === 1 ? "query" : "queries";
    sub.textContent = "Searching " + done + "/" + total + " " + noun + "\u2026";
  }

  function syncLoadingPanel() {
    if (shouldShowLoadingPanel()) {
      if (!ensureLoadingPanel()) return;
      updateLoadingPanelSummary();
      return;
    }

    if (loadingPanelEl) {
      loadingPanelEl.remove();
      loadingPanelEl = null;
    }
  }

  function renderErrorCard(card, queryText, errorText, provider) {
    var tag = providerTagHtml(provider);
    card.innerHTML =
      '<div class="result-card-header">' +
        '<input type="checkbox" disabled>' +
        '<div class="result-card-info">' +
          '<div class="result-card-query-row">' +
            '<div class="result-card-query">' + escHtml(queryText) + "</div>" +
            tag +
          "</div>" +
          '<div class="result-card-meta" style="color:var(--timer-urgent-fg)">Failed</div>' +
        "</div>" +
      "</div>" +
      '<div class="result-card-error-msg">' + escHtml(errorText || "Search failed") + "</div>";
  }

  function populateResultCard(card, data, queryText, provider) {
    var sourceCount = data.results ? data.results.length : 0;
    var domains = [];
    if (data.results) {
      for (var i = 0; i < Math.min(data.results.length, 3); i++) {
        domains.push(data.results[i].domain);
      }
    }
    var metaText = sourceCount + " source" + (sourceCount !== 1 ? "s" : "");
    if (domains.length > 0) metaText += " \u00B7 " + domains.join(", ");
    if (sourceCount > 3) metaText += ", +" + (sourceCount - 3);

    var preview = "";
    if (data.answer) {
      preview = data.answer.substring(0, 200).replace(/\\n+/g, " ").replace(/[#*_\\[\\]]/g, "");
    }

    var bodyHtml = "";
    if (data.answer) {
      var rendered = typeof marked !== "undefined" && marked.parse
        ? marked.parse(data.answer, { breaks: true })
        : "<p>" + escHtml(data.answer) + "</p>";
      bodyHtml += '<div class="result-card-answer">' + sanitizeMarkdownHtml(rendered) + "</div>";
    }
    if (data.results && data.results.length > 0) {
      bodyHtml += '<div class="result-card-sources"><div class="result-card-sources-title">Sources</div>';
      for (var k = 0; k < data.results.length; k++) {
        var r = data.results[k];
        var label = r.title && r.title.indexOf("Source ") !== 0 ? r.title : r.url;
        var href = sanitizeHref(r.url);
        bodyHtml += '<a class="source-link" href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(label) + '<span class="source-domain">' + escHtml(r.domain) + "</span></a>";
      }
      bodyHtml += "</div>";
    }

    var altChipsHtml = buildAltChipsHtml(provider, queryText);

    card.innerHTML =
      '<div class="result-card-header">' +
        '<input type="checkbox" checked>' +
        '<div class="result-card-info">' +
          '<div class="result-card-query-row">' +
            '<div class="result-card-query">' + escHtml(queryText) + "</div>" +
            providerTagHtml(provider) +
          "</div>" +
          '<div class="result-card-meta">' + escHtml(metaText) + "</div>" +
          (preview ? '<div class="result-card-preview">' + escHtml(preview) + "</div>" : "") +
        "</div>" +
        '<div class="result-card-expand">\u25BC</div>' +
      "</div>" +
      altChipsHtml +
      '<div class="result-card-body">' + bodyHtml + "</div>";
  }

  function applyResponseToCard(card, data, queryText, providerHint, slotHint) {
    if (!card || !data) return;
    if (submitted || timerExpired) return;

    var queryIndex = typeof data.queryIndex === "number" ? data.queryIndex : null;
    if (queryIndex !== null) {
      card.dataset.qi = String(queryIndex);
    }

    var slotId = typeof slotHint === "number" ? slotHint : (queryIndex !== null ? queryIndexToSlot.get(queryIndex) : undefined);
    if (typeof slotId !== "number" && queryIndex !== null) {
      slotId = queryIndex;
    }
    if (queryIndex !== null && typeof slotId === "number") {
      queryIndexToSlot.set(queryIndex, slotId);
    }

    var provider = normalizeProvider(data.provider, providerHint);

    card.classList.remove("searching", "checked", "error");

    if (data.error) {
      card.classList.add("error");
      renderErrorCard(card, queryText, data.error, provider);
    } else {
      card.classList.add("checked");
      populateResultCard(card, data, queryText, provider);
      setupCardInteraction(card);
    }

    if (card.dataset.completed !== "true") {
      completedCount++;
      card.dataset.completed = "true";
    }
    markCoverage(provider, slotId);
    updateSummaryText();
    syncLoadingPanel();
    recomputeProviderStates();
    updateStageUI();
    maybeAutoGenerateSummary();
    resetTimer();
  }

  function resetTimer() { lastInteraction = Date.now(); }

  function updateTimer() {
    var idleSec = Math.floor((Date.now() - lastInteraction) / 1000);
    var remaining = Math.max(0, timeoutSec - idleSec);
    timerEl.textContent = formatTime(remaining);

    timerEl.classList.remove("warn", "urgent", "active");
    if (remaining <= 15) timerEl.classList.add("urgent");
    else if (remaining <= 30) timerEl.classList.add("warn");
    else if (remaining < timeoutSec) timerEl.classList.add("active");

    updateSummaryGeneratingIndicator();

    if (remaining <= 0 && !submitted && !timerExpired) onTimeout();
  }

  setInterval(updateTimer, 1000);
  updateTimer();

  ["click", "keydown", "input", "change"].forEach(function(evt) {
    document.addEventListener(evt, resetTimer, { passive: true });`;
