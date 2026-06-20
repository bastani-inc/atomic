export const CURATOR_PAGE_SCRIPT_3 = `  });
  document.addEventListener("scroll", resetTimer, { passive: true });
  document.addEventListener("mousemove", resetTimer, { passive: true });

  timerEl.addEventListener("click", function(e) {
    e.stopPropagation();
    timerInput.value = timeoutSec;
    timerAdjustEl.classList.add("visible");
    timerEl.style.display = "none";
    timerInput.focus();
    timerInput.select();
  });

  function applyTimerAdjust() {
    var val = parseInt(timerInput.value, 10);
    if (val && val > 0) timeoutSec = Math.min(val, 600);
    timerAdjustEl.classList.remove("visible");
    timerEl.style.display = "";
    resetTimer();
  }

  timerSetBtn.addEventListener("click", function(e) { e.stopPropagation(); applyTimerAdjust(); });
  timerInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); applyTimerAdjust(); }
    if (e.key === "Escape") { timerAdjustEl.classList.remove("visible"); timerEl.style.display = ""; }
    e.stopPropagation();
  });
  document.addEventListener("click", function() {
    if (timerAdjustEl.classList.contains("visible")) {
      timerAdjustEl.classList.remove("visible");
      timerEl.style.display = "";
    }
  });

  function setDefaultProvider(provider, persist) {
    var normalized = normalizeProvider(provider, currentProvider);
    if (!normalized) return;
    currentProvider = normalized;
    recomputeProviderStates();
    if (persist) {
      postJson("/provider", { provider: normalized }).then(function(data) {
        if (data && data.ok === false) {
          throw new Error(extractServerError(data) || "request rejected");
        }
      }).catch(function(err) {
        var message = err instanceof Error ? err.message : String(err);
        setError("Failed to save provider preference: " + (message || "unknown error"));
      });
    }
  }

  providerButtons.forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (isResultMutationLocked()) return;
      if (providerBatchInFlight || addSearchInFlight) return;

      var provider = normalizeProvider(btn.dataset.provider, "");
      if (!provider) return;

      var state = btn.dataset.state || "idle";
      if (state === "loading") return;

      if (state === "searched") {
        if (provider === currentProvider) return;
        setDefaultProvider(provider, true);
        resetTimer();
        return;
      }

      setDefaultProvider(provider, true);
      if (allQueries.length === 0) {
        resetTimer();
        return;
      }

      interruptSummaryIfNeeded();
      providerBatchInFlight = true;
      batchLoadingProvider = provider;
      recomputeProviderStates();

      var batchQueries = allQueries.slice();
      var inflight = batchQueries.length;
      if (inflight === 0) {
        providerBatchInFlight = false;
        batchLoadingProvider = null;
        recomputeProviderStates();
        return;
      }

      var batchCards = [];
      for (var bi = 0; bi < batchQueries.length; bi++) {
        var bq = batchQueries[bi];
        var card = document.createElement("div");
        card.className = "result-card searching";
        card.innerHTML =
          '<div class="result-card-header">' +
            '<input type="checkbox" checked disabled>' +
            '<div class="result-card-info">' +
              '<div class="result-card-query-row">' +
                '<div class="result-card-query">' + escHtml(bq.query) + "</div>" +
                providerTagHtml(provider) +
              "</div>" +
              '<div class="result-card-meta"><span class="searching-dots">Searching</span></div>' +
            "</div>" +
          "</div>" +
          buildAltChipsHtml(provider, bq.query);
        resultCardsEl.appendChild(card);
        batchCards.push(card);
      }
      updateSummaryText();

      batchQueries.forEach(function(slot, si) {
        var searchingCard = batchCards[si];
        postJson("/search", { query: slot.query, provider: provider })
          .then(function(data) {
            if (submitted || timerExpired) return;
            if (!data || data.ok === false) {
              applyResponseToCard(searchingCard, {
                answer: "",
                results: [],
                error: extractServerError(data) || "Search failed",
                provider: provider,
              }, slot.query, provider, slot.slotId);
              return;
            }
            applyResponseToCard(searchingCard, data, slot.query, provider, slot.slotId);
          })
          .catch(function(err) {
            if (submitted || timerExpired) return;
            var message = err instanceof Error ? err.message : String(err);
            applyResponseToCard(searchingCard, {
              answer: "",
              results: [],
              error: message || "Search failed",
              provider: provider,
            }, slot.query, provider, slot.slotId);
          })
          .finally(function() {
            inflight -= 1;
            if (inflight <= 0) {
              providerBatchInFlight = false;
              batchLoadingProvider = null;
              recomputeProviderStates();
              updateStageUI();
              maybeAutoGenerateSummary();
            }
          });
      });

      resetTimer();
    });
  });

  if (resultCardsEl) {
    resultCardsEl.addEventListener("click", function(e) {
      if (!(e.target instanceof Element)) return;
      var chip = e.target.closest(".card-alt-chip");
      if (!chip) return;
      if (isResultMutationLocked()) return;

      var altProvider = chip.dataset.altProvider;
      var altQuery = chip.dataset.altQuery;
      if (!altProvider || !altQuery) return;

      interruptSummaryIfNeeded();

      chip.classList.add("loading");
      chip.disabled = true;
      resetTimer();

      var slotId = nextSlotId++;
      allQueries.push({ slotId: slotId, query: altQuery });

      var parentCard = chip.closest(".result-card");
      var newCard = document.createElement("div");
      newCard.className = "result-card searching";
      newCard.innerHTML =
        '<div class="result-card-header">' +
          '<input type="checkbox" checked disabled>' +
          '<div class="result-card-info">' +
            '<div class="result-card-query-row">' +
              '<div class="result-card-query">' + escHtml(altQuery) + "</div>" +
              providerTagHtml(altProvider) +
            "</div>" +
            '<div class="result-card-meta"><span class="searching-dots">Searching</span></div>' +
          "</div>" +
        "</div>" +
        buildAltChipsHtml(altProvider, altQuery);
      if (parentCard && parentCard.nextSibling) {
        resultCardsEl.insertBefore(newCard, parentCard.nextSibling);
      } else {
        resultCardsEl.appendChild(newCard);
      }
      updateSummaryText();

      postJson("/search", { query: altQuery, provider: altProvider })
        .then(function(data) {
          if (submitted || timerExpired) return;
          if (!data || data.ok === false) {
            applyResponseToCard(newCard, {
              answer: "", results: [],
              error: extractServerError(data) || "Search failed",
              provider: altProvider,
            }, altQuery, altProvider, slotId);
            return;
          }
          applyResponseToCard(newCard, data, altQuery, altProvider, slotId);
        })
        .catch(function(err) {
          removeSlot(slotId);
          newCard.remove();
          var message = err instanceof Error ? err.message : String(err);
          setError("Re-search failed: " + (message || "Search failed"));
          updateSummaryText();
        })
        .finally(function() {
          chip.classList.remove("loading");
          chip.disabled = false;
          recomputeProviderStates();
          updateStageUI();
          maybeAutoGenerateSummary();
        });
    });
  }

  if (addSearchInput && addSearchWand) {
    addSearchInput.addEventListener("input", function() {
      addSearchWand.disabled = rewriteInFlight || !addSearchInput.value.trim() || isResultMutationLocked();
    });

    addSearchWand.addEventListener("click", function() {
      var text = addSearchInput.value.trim();
      if (!text || rewriteInFlight || isResultMutationLocked()) return;
      rewriteInFlight = true;
      addSearchWand.disabled = true;
      addSearchWand.classList.add("rewriting");
      resetTimer();

      postJson("/rewrite", { query: text })
        .then(function(data) {
          if (!data || data.ok === false) {
            throw new Error(extractServerError(data) || "Rewrite failed");
          }
          var rewritten = typeof data.query === "string" ? data.query.trim() : "";
          if (rewritten) {
            addSearchInput.value = rewritten;
            addSearchInput.focus();
          }
        })
        .catch(function(err) {
          var message = err instanceof Error ? err.message : String(err);
          setError("Rewrite failed: " + (message || "unknown error"));
        })
        .finally(function() {
          rewriteInFlight = false;
          addSearchWand.classList.remove("rewriting");
          addSearchWand.disabled = !addSearchInput.value.trim() || isResultMutationLocked();
        });
    });
  }

  addSearchInput.addEventListener("keydown", function(e) {
    if (e.key !== "Enter") return;
    var text = addSearchInput.value.trim();
    if (!text || isResultMutationLocked()) return;
    interruptSummaryIfNeeded();
    e.preventDefault();
    e.stopPropagation();

    addSearchInFlight++;
    applyProviderInterlocks();
    addSearchInput.value = "";

    var slotId = nextSlotId++;
    allQueries.push({ slotId: slotId, query: text });
    syncLoadingPanel();
    recomputeProviderStates();

    var requestedProvider = currentProvider;

    var card = document.createElement("div");
    card.className = "result-card searching";
    card.innerHTML =
      '<div class="result-card-header">' +
        '<input type="checkbox" checked disabled>' +
        '<div class="result-card-info">' +
          '<div class="result-card-query-row">' +
            '<div class="result-card-query">' + escHtml(text) + "</div>" +
            providerTagHtml(requestedProvider) +
          "</div>" +
          '<div class="result-card-meta"><span class="searching-dots">Searching</span></div>' +
        "</div>" +
      "</div>" +
      buildAltChipsHtml(requestedProvider, text);
    resultCardsEl.appendChild(card);
    updateSummaryText();
    resetTimer();

    postJson("/search", { query: text, provider: requestedProvider })
      .then(function(data) {
        if (!data || data.ok === false) {
          removeSlot(slotId);
          card.remove();
          setError("Failed to add search: " + (extractServerError(data) || "Search failed"));
          recomputeProviderStates();
          updateSummaryText();
          return;
        }

        if (submitted || timerExpired) return;

        applyResponseToCard(card, data, text, requestedProvider, slotId);
      })
      .catch(function(err) {
        removeSlot(slotId);
        card.remove();
        var message = err instanceof Error ? err.message : String(err);
        setError("Failed to add search: " + (message || "Search failed"));
        recomputeProviderStates();
        updateSummaryText();
      })
      .finally(function() {
        addSearchInFlight--;
        recomputeProviderStates();
        updateStageUI();
        maybeAutoGenerateSummary();
      });
  });

  function showSuccess(text) {
    if (es) { es.close(); es = null; }
    closePreviewModal();
    successText.textContent = text;
    successOverlay.classList.remove("hidden");
    setTimeout(function() { window.close(); }, 800);
  }

  function showExpired(text) {
    if (es) { es.close(); es = null; }
    closePreviewModal();
    expiredText.textContent = text;
    expiredOverlay.classList.remove("hidden");
    requestAnimationFrame(function() { expiredOverlay.classList.add("visible"); });
  }

  function startOverlayCloseCountdown(seconds) {
    var count = seconds;
    closeCountdown.textContent = count;
    var iv = setInterval(function() {
      count--;
      closeCountdown.textContent = count;
      if (count <= 0) {
        clearInterval(iv);
        window.close();
      }
    }, 1000);
  }

  function submitPayload(payload, successText) {
    if (submitInFlight) return Promise.reject(new Error("Submit already in progress"));
    submitInFlight = true;
    submitted = true;
    syncLoadingPanel();
    updateStageUI();
    clearError();

    return postJson("/submit", payload)
      .then(function(data) {
        if (data && data.ok === false) {
          throw new Error(extractServerError(data) || "submit rejected");
        }
        showSuccess(successText);
      })
      .catch(function(err) {
        submitInFlight = false;
        submitted = false;
        syncLoadingPanel();
        updateStageUI();
        throw err;
      });
  }

  function submitWithTimeoutFallback(payload) {
    if (submitInFlight) return;
    submitInFlight = true;
    submitted = true;
    timerExpired = true;
    syncLoadingPanel();
    updateStageUI();
    clearError();
    showExpired("Time\u2019s up \u2014 submitting current summary state.");

    function finalizeClose() {
      submitInFlight = false;
      startOverlayCloseCountdown(5);
    }

    function toErrorMessage(err) {
      return err instanceof Error ? err.message : String(err);
    }`;
