export const CURATOR_PAGE_SCRIPT_4 = `
    function attemptCancelFallback(submitErrorMessage) {
      return postJson("/cancel", { reason: "timeout" })
        .catch(function(cancelErr) {
          console.error("Timeout finalize failed after submit errors:", submitErrorMessage, "| cancel:", toErrorMessage(cancelErr));
        })
        .finally(finalizeClose);
    }

    postJson("/submit", payload)
      .then(function(data) {
        if (data && data.ok === false) {
          throw new Error(extractServerError(data) || "submit rejected");
        }
        finalizeClose();
      })
      .catch(function(firstErr) {
        var firstMessage = toErrorMessage(firstErr);
        setTimeout(function() {
          postJson("/submit", payload)
            .then(function(data) {
              if (data && data.ok === false) {
                throw new Error(extractServerError(data) || "submit rejected");
              }
              finalizeClose();
            })
            .catch(function(secondErr) {
              var secondMessage = toErrorMessage(secondErr);
              attemptCancelFallback(firstMessage + " | " + secondMessage);
            });
        }, 250);
      });
  }

  function onTimeout() {
    if (submitted || timerExpired) return;
    var timeoutSelected = getTimeoutSelectedIndices();
    var payload = { selected: timeoutSelected };
    var draft = getSummaryDraftText();
    if (stage === "summary-review" && draft.length > 0) {
      payload.summary = draft;
      if (summaryMeta) payload.summaryMeta = summaryMeta;
    }
    submitWithTimeoutFallback(payload);
  }

  if (queries.length === 0) {
    heroTitle.textContent = "What do you need?";
    heroDesc.textContent = "Search for anything below, then generate and approve a summary.";
    if (heroStatus) heroStatus.textContent = "";
    btnSend.textContent = "No results yet";
  } else {
    for (var i = 0; i < queries.length; i++) {
      queryIndexToSlot.set(i, i);
      var card = document.createElement("div");
      card.className = "result-card searching";
      card.dataset.qi = i;
      card.innerHTML =
        '<div class="result-card-header">' +
          '<input type="checkbox" checked disabled>' +
          '<div class="result-card-info">' +
            '<div class="result-card-query-row">' +
              '<div class="result-card-query">' + escHtml(queries[i]) + "</div>" +
              providerTagHtml(initialDefaultProvider) +
            "</div>" +
            '<div class="result-card-meta"><span class="searching-dots">Searching</span></div>' +
          "</div>" +
        "</div>" +
        buildAltChipsHtml(initialDefaultProvider, queries[i]);
      resultCardsEl.appendChild(card);
    }
  }

  initializeSummaryModelControls();
  syncLoadingPanel();
  recomputeProviderStates();
  updateStageUI();

  es = new EventSource("/events?session=" + encodeURIComponent(token));

  function parseSseEventData(eventName, e) {
    try {
      return JSON.parse(e.data);
    } catch (err) {
      var message = err instanceof Error ? err.message : String(err);
      setError("Invalid " + eventName + " event payload: " + (message || "unknown parse error"));
      return null;
    }
  }

  es.addEventListener("result", function(e) {
    var data = parseSseEventData("result", e);
    if (!data) return;

    var card = resultCardsEl.querySelector('.result-card[data-qi="' + data.queryIndex + '"]');
    if (!card) return;

    var slotId = queryIndexToSlot.get(data.queryIndex);
    if (typeof slotId !== "number") slotId = data.queryIndex;
    applyResponseToCard(card, data, data.query || queries[data.queryIndex], data.provider, slotId);
  });

  es.addEventListener("search-error", function(e) {
    var data = parseSseEventData("search-error", e);
    if (!data) return;

    var card = resultCardsEl.querySelector('.result-card[data-qi="' + data.queryIndex + '"]');
    if (!card) return;

    var slotId = queryIndexToSlot.get(data.queryIndex);
    if (typeof slotId !== "number") slotId = data.queryIndex;
    applyResponseToCard(card, {
      queryIndex: data.queryIndex,
      answer: "",
      results: [],
      error: data.error || "Search failed",
      provider: data.provider,
    }, data.query || queries[data.queryIndex], data.provider, slotId);
  });

  es.addEventListener("done", function() {
    searchesDone = true;
    initialStreamDone = true;
    if (completedCount > 0) {
      updateSummaryText();
    }
    syncLoadingPanel();
    recomputeProviderStates();
    updateStageUI();
    maybeAutoGenerateSummary();
    resetTimer();
  });

  es.onerror = function() {
    // EventSource reconnects automatically.
  };

  function setupCardInteraction(card) {
    var header = card.querySelector(".result-card-header");
    var body = card.querySelector(".result-card-body");
    var cb = card.querySelector("input[type=checkbox]");
    var expandEl = card.querySelector(".result-card-expand");

    if (!header || !cb) return;

    header.addEventListener("click", function(e) {
      if (e.target.tagName === "A") return;
      if (e.target === cb) {
        if (isResultMutationLocked()) {
          e.preventDefault();
          return;
        }
        card.classList.toggle("checked", cb.checked);
        if (stage === "summary-review" || stage === "generating-summary") {
          interruptSummaryIfNeeded();
        }
        updateStageUI();
        maybeAutoGenerateSummary();
        return;
      }
      var isExpanded = body && body.classList.contains("open");
      if (body) body.classList.toggle("open");
      if (expandEl) expandEl.textContent = isExpanded ? "\u25BC" : "\u25B2";
    });

    if (body) {
      body.addEventListener("click", function(e) {
        e.stopPropagation();
      });
    }
  }

  function getSelectedIndices() {
    var indices = [];
    var cards = resultCardsEl.querySelectorAll(".result-card");
    cards.forEach(function(card) {
      if (card.dataset.completed !== "true") return;
      if (card.classList.contains("error")) return;
      var cb = card.querySelector("input[type=checkbox]");
      if (!cb || !cb.checked) return;
      var qi = parseInt(card.dataset.qi, 10);
      if (!Number.isNaN(qi)) indices.push(qi);
    });
    return indices;
  }

  function getCompletedSelectableIndices() {
    var indices = [];
    var cards = resultCardsEl.querySelectorAll(".result-card");
    cards.forEach(function(card) {
      if (card.dataset.completed !== "true") return;
      if (card.classList.contains("error")) return;
      var qi = parseInt(card.dataset.qi, 10);
      if (!Number.isNaN(qi)) indices.push(qi);
    });
    return indices;
  }

  function hasPendingSearchCards() {
    var cards = resultCardsEl.querySelectorAll(".result-card");
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.dataset.completed !== "true") return true;
    }
    return addSearchInFlight || providerBatchInFlight;
  }

  function getTimeoutSelectedIndices() {
    var selected = getSelectedIndices();
    if (selected.length > 0) return selected;
    return getCompletedSelectableIndices();
  }

  function normalizeSummaryMeta(meta, edited) {
    if (!meta || typeof meta !== "object") {
      return {
        model: null,
        durationMs: 0,
        tokenEstimate: 0,
        fallbackUsed: false,
        edited: !!edited,
      };
    }

    return {
      model: typeof meta.model === "string" || meta.model === null ? meta.model : null,
      durationMs: typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
      tokenEstimate: typeof meta.tokenEstimate === "number" && Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0 ? meta.tokenEstimate : 0,
      fallbackUsed: meta.fallbackUsed === true,
      fallbackReason: typeof meta.fallbackReason === "string" ? meta.fallbackReason : undefined,
      edited: !!edited,
    };
  }

  function isSummaryModelSelectionError(message) {
    if (typeof message !== "string") return false;
    return message.indexOf("Invalid summary model") !== -1
      || message.indexOf("Summary model not found") !== -1
      || message.indexOf("No API key available for summary model") !== -1
      || message.indexOf("Invalid provider") !== -1;
  }

  function resetSummaryGeneratingState() {
    summaryPendingModel = "";
    summaryGeneratingStartedAt = 0;
    summaryGeneratingPhase = -1;
  }

  function cancelInFlightSummaryRequest() {
    summaryRequestSeq += 1;
    resetSummaryGeneratingState();
  }

  function interruptSummaryIfNeeded() {
    if (stage !== "generating-summary" && stage !== "summary-review") return;
    if (stage === "generating-summary") {
      cancelInFlightSummaryRequest();
    }
    clearError();
    isRegenerating = getSummaryDraftText().length > 0;
    stage = "results";
    updateStageUI();
  }

  function exitRegeneratingState() {
    if (!isRegenerating) return false;
    if (stage === "generating-summary") {
      cancelInFlightSummaryRequest();
    }
    isRegenerating = false;
    clearError();
    stage = "results";
    updateStageUI();
    return true;
  }

  function requestSummary(indices, feedback) {
    if (submitted || timerExpired || submitInFlight) return;

    if (!Array.isArray(indices) || indices.length === 0) {
      setError("Select at least one result to summarize");
      stage = "results";
      updateStageUI();
      return;
    }

    if (hasPendingSearchCards()) {
      setError("Wait for running searches to finish before generating summary");
      stage = "results";
      updateStageUI();
      return;
    }

    clearError();
    var previousStage = stage;
    var wasRegenerating = isRegenerating;
    var selectedSummaryModel = getSelectedSummaryModel();
    summaryPendingModel = selectedSummaryModel;
    summaryGeneratingStartedAt = Date.now();
    summaryGeneratingPhase = -1;
    stage = "generating-summary";
    updateStageUI();

    var requestId = ++summaryRequestSeq;
    var feedbackText = typeof feedback === "string" ? feedback.trim() : "";
    var summarizePayload = { selected: indices };
    if (selectedSummaryModel.length > 0) {
      summarizePayload.model = selectedSummaryModel;
    }
    if (feedbackText.length > 0) {
      summarizePayload.feedback = feedbackText;
    }

    postJson("/summarize", summarizePayload)
      .then(function(data) {
        if (requestId !== summaryRequestSeq) return data;
        if (!data || data.ok === false) {
          throw new Error(extractServerError(data) || "summary request rejected");
        }
        return data;
      })
      .catch(function(err) {
        if (requestId !== summaryRequestSeq) throw err;

        var firstMessage = err instanceof Error ? err.message : String(err);
        if (selectedSummaryModel.length === 0 || !isSummaryModelSelectionError(firstMessage)) {
          throw err;
        }

        summaryPendingModel = "";
        updateStageUI();

        var retryPayload = { selected: indices };
        if (feedbackText.length > 0) {
          retryPayload.feedback = feedbackText;
        }
        return postJson("/summarize", retryPayload).then(function(retryData) {
          if (!retryData || retryData.ok === false) {
            throw new Error(extractServerError(retryData) || "summary request rejected");
          }
          return retryData;
        }).catch(function(retryErr) {
          var retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(firstMessage + " (auto retry failed: " + (retryMessage || "unknown error") + ")");
        });
      })
      .then(function(data) {
        if (requestId !== summaryRequestSeq) return;

        var summaryText = typeof data.summary === "string" ? data.summary.trim() : "";
        if (!summaryText) {
          throw new Error("Summary response was empty");
        }

        if (summaryInput) {
          summaryInput.value = summaryText;
        }
        if (summaryFeedback) {
          summaryFeedback.value = "";
        }
        summaryMeta = normalizeSummaryMeta(data.meta || null, false);
        lastAutoSummarySignature = selectionSignature(indices);
        resetSummaryGeneratingState();
        isRegenerating = false;
        stage = "summary-review";
        updateStageUI();
      })
      .catch(function(err) {
        if (requestId !== summaryRequestSeq) return;
        var message = err instanceof Error ? err.message : String(err);
        setError("Failed to generate summary — " + (message || "unknown error"));
        resetSummaryGeneratingState();
        isRegenerating = false;
        if (wasRegenerating && getSummaryDraftText().length > 0) {
          stage = "summary-review";
        } else {
          stage = previousStage === "summary-review" ? "summary-review" : "results";
        }
        updateStageUI();
      });
  }

  function selectionSignature(indices) {
    return indices.slice().sort(function(a, b) { return a - b; }).join(",");
  }

  function maybeAutoGenerateSummary() {
    if (workflow !== "summary-review") return;
    if (!searchesDone) return;
    if (stage !== "results") return;
    if (submitted || timerExpired || submitInFlight) return;
    if (hasPendingSearchCards()) return;

    var selected = getSelectedIndices();
    if (selected.length === 0) {
      if (isRegenerating) {
        isRegenerating = false;
        updateStageUI();
      }
      return;`;
