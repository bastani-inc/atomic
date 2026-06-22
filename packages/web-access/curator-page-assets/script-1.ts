export const CURATOR_PAGE_SCRIPT_1 = `(function() {
  var DATA = __INLINE_DATA__;
  var token = DATA.sessionToken;
  var timeoutSec = DATA.timeout;
  var queries = Array.isArray(DATA.queries) ? DATA.queries : [];
  var providers = ["perplexity", "exa", "gemini"];
  var availProviders = DATA.availableProviders && typeof DATA.availableProviders === "object" ? DATA.availableProviders : {};
  var workflow = "summary-review";
  var initialDefaultProvider = typeof DATA.defaultProvider === "string" ? DATA.defaultProvider : "exa";
  if (providers.indexOf(initialDefaultProvider) === -1) initialDefaultProvider = "exa";

  var summaryModels = Array.isArray(DATA.summaryModels)
    ? DATA.summaryModels.filter(function(model) {
      return model && typeof model === "object" && typeof model.value === "string";
    })
    : [];
  var defaultSummaryModel = typeof DATA.defaultSummaryModel === "string"
    ? DATA.defaultSummaryModel.trim()
    : "";

  var submitted = false;
  var timerExpired = false;
  var submitInFlight = false;
  var searchesDone = false;
  var stage = "results";
  var summaryMeta = null;
  var summaryRequestSeq = 0;
  var lastAutoSummarySignature = "";
  var lastInteraction = Date.now();
  var completedCount = 0;
  var es = null;

  var allQueries = queries.map(function(query, slotId) { return { slotId: slotId, query: query }; });
  var nextSlotId = queries.length;
  var queryIndexToSlot = new Map();
  var providerCoverage = new Map();

  var currentProvider = initialDefaultProvider;
  var initialStreamDone = queries.length === 0;
  var providerBatchInFlight = false;
  var batchLoadingProvider = null;
  var addSearchInFlight = 0;
  var isRegenerating = false;

  var timerEl = document.getElementById("timer");
  var timerAdjustEl = document.getElementById("timer-adjust");
  var timerInput = document.getElementById("timer-input");
  var timerSetBtn = document.getElementById("timer-set");
  var heroTitle = document.querySelector(".hero-title");
  var heroDesc = document.querySelector(".hero-desc");
  var resultCardsEl = document.getElementById("result-cards");
  var btnSend = document.getElementById("btn-send");
  var btnSendRaw = document.getElementById("btn-send-raw");
  var sendRawRow = document.getElementById("send-raw-row");
  var summaryPanel = document.getElementById("summary-panel");
  var summarySubtitle = document.getElementById("summary-subtitle");
  var summaryGeneratingEl = document.getElementById("summary-generating");
  var summaryGeneratingCopy = document.getElementById("summary-generating-copy");
  var summaryInput = document.getElementById("summary-input");
  var summaryFeedback = document.getElementById("summary-feedback");
  var btnSummaryBack = document.getElementById("btn-summary-back");
  var btnSummaryRegenerate = document.getElementById("btn-summary-regenerate");
  var btnSummaryPreview = document.getElementById("btn-summary-preview");
  var btnSummaryApprove = document.getElementById("btn-summary-approve");
  var successOverlay = document.getElementById("success-overlay");
  var successText = document.getElementById("success-text");
  var expiredOverlay = document.getElementById("expired-overlay");
  var expiredText = document.getElementById("expired-text");
  var closeCountdown = document.getElementById("close-countdown");
  var errorBanner = document.getElementById("error-banner");
  var addSearchInput = document.getElementById("add-search-input");
  var addSearchEl = document.getElementById("add-search");
  var addSearchWand = document.getElementById("add-search-wand");
  var heroStatus = document.getElementById("hero-status");
  var summaryProviderSelect = document.getElementById("summary-provider-select");
  var summaryModelSelect = document.getElementById("summary-model-select");
  var previewModal = document.getElementById("preview-modal");
  var previewModalBody = document.getElementById("preview-modal-body");
  var previewModalClose = document.getElementById("preview-modal-close");
  var previewModalModel = document.getElementById("preview-modal-model");
  var previewModalRegenerate = document.getElementById("preview-modal-regenerate");
  var previewModalApprove = document.getElementById("preview-modal-approve");
  var previewPopover = document.getElementById("preview-popover");
  var previewPopoverQuote = document.getElementById("preview-popover-quote");
  var previewPopoverInput = document.getElementById("preview-popover-input");
  var previewPopoverRegen = document.getElementById("preview-popover-regen");
  var providerButtons = Array.prototype.slice.call(document.querySelectorAll(".provider-btn"));
  var loadingPanelEl = null;

  var summaryModelsByProvider = Object.create(null);
  var summaryProviders = [];
  var currentSummaryProvider = "";
  var currentSummaryModel = "";
  var summaryPendingModel = "";
  var summaryGeneratingStartedAt = 0;
  var summaryGeneratingPhase = -1;
  var rewriteInFlight = false;

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function sanitizeHref(url) {
    var value = typeof url === "string" ? url.trim() : "";
    return /^https?:\/\//i.test(value) ? value : "#";
  }

  function sanitizeMarkdownHtml(html) {
    var container = document.createElement("div");
    container.innerHTML = html;

    container.querySelectorAll("script, iframe, object, embed, form, style, link, meta, base")
      .forEach(function(el) { el.remove(); });

    var nodes = container.querySelectorAll("*");
    nodes.forEach(function(node) {
      for (var i = node.attributes.length - 1; i >= 0; i--) {
        var attr = node.attributes[i];
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    });

    var anchors = container.querySelectorAll("a[href]");
    anchors.forEach(function(anchor) {
      var safe = sanitizeHref(anchor.getAttribute("href") || "");
      anchor.setAttribute("href", safe);
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.setAttribute("target", "_blank");
    });

    var images = container.querySelectorAll("img[src]");
    images.forEach(function(img) {
      var safe = sanitizeHref(img.getAttribute("src") || "");
      if (safe === "#") {
        img.remove();
      } else {
        img.setAttribute("src", safe);
      }
    });

    return container.innerHTML;
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ token: token }, body)),
    });
  }

  function extractServerError(data) {
    if (!data || typeof data !== "object") return "";
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
    return "";
  }

  function postJson(path, body) {
    return post(path, body).then(function(res) {
      return res.text().then(function(raw) {
        var data = null;
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (err) {
            var parseMessage = err instanceof Error ? err.message : String(err);
            throw new Error("Invalid JSON response from " + path + ": " + parseMessage);
          }
        }

        if (!res.ok) {
          throw new Error(extractServerError(data) || ("HTTP " + res.status));
        }

        return data;
      });
    });
  }

  function formatTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function normalizeProvider(provider, fallback) {
    if (typeof provider === "string") {
      var normalized = provider.toLowerCase();
      if (providers.indexOf(normalized) !== -1) return normalized;
    }
    if (typeof fallback === "string") {
      var fallbackNormalized = fallback.toLowerCase();
      if (providers.indexOf(fallbackNormalized) !== -1) return fallbackNormalized;
    }
    return "";
  }

  function providerLabel(provider) {
    if (provider === "perplexity") return "Perplexity";
    if (provider === "exa") return "Exa";
    if (provider === "gemini") return "Gemini";
    return "Unknown";
  }

  function providerTagHtml(provider) {
    var normalized = normalizeProvider(provider, "");
    if (!normalized) return "";
    return '<span class="provider-tag provider-' + normalized + '">' + escHtml(providerLabel(normalized)) + "</span>";
  }

  function buildAltChipsHtml(provider, queryText) {
    var normalizedProv = normalizeProvider(provider, "");
    if (!normalizedProv) return "";
    var altProviders = providers.filter(function(p) { return p !== normalizedProv && availProviders[p] === true; });
    if (altProviders.length === 0) return "";
    var html = '<div class="card-alt-providers"><span>Also try</span>';
    for (var ap = 0; ap < altProviders.length; ap++) {
      html += '<button type="button" class="card-alt-chip" data-alt-provider="' + altProviders[ap] + '" data-alt-query="' + escHtml(queryText) + '">' + escHtml(providerLabel(altProviders[ap])) + '</button>';
    }
    html += "</div>";
    return html;
  }

  function getSummaryProvider(modelValue) {
    if (typeof modelValue !== "string") return "";
    var trimmed = modelValue.trim();
    var slash = trimmed.indexOf("/");
    if (slash <= 0) return "";
    return trimmed.slice(0, slash);
  }

  function summaryProviderLabel(provider) {
    if (!provider) return "";
    if (provider === "openai") return "OpenAI";
    if (provider === "google") return "Google";
    if (provider === "anthropic") return "Anthropic";
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  function buildSummaryModelState() {
    summaryModelsByProvider = Object.create(null);
    summaryProviders = [];
    var seenValues = {};

    for (var i = 0; i < summaryModels.length; i++) {
      var model = summaryModels[i];
      if (!model || typeof model.value !== "string") continue;
      var value = model.value.trim();
      if (!value || seenValues[value]) continue;
      var provider = getSummaryProvider(value);
      if (!provider) continue;
      seenValues[value] = true;

      if (!summaryModelsByProvider[provider]) {
        summaryModelsByProvider[provider] = [];
        summaryProviders.push(provider);
      }

      var label = typeof model.label === "string" && model.label.trim().length > 0
        ? model.label.trim()
        : value;
      summaryModelsByProvider[provider].push({ value: value, label: label });
    }
  }

  function renderSummaryProviderSelect() {
    if (!summaryProviderSelect) return;

    summaryProviderSelect.innerHTML = "";
    for (var i = 0; i < summaryProviders.length; i++) {
      var provider = summaryProviders[i];
      var option = document.createElement("option");
      option.value = provider;
      option.textContent = summaryProviderLabel(provider);
      summaryProviderSelect.appendChild(option);
    }
  }

  function populateSummaryModelSelect(provider, preferredModel) {
    if (!summaryModelSelect) return;

    summaryModelSelect.innerHTML = "";

    var autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = "Auto";
    summaryModelSelect.appendChild(autoOption);

    var models = summaryModelsByProvider[provider] || [];
    for (var i = 0; i < models.length; i++) {
      var option = document.createElement("option");
      option.value = models[i].value;
      var shortLabel = models[i].value;
      var labelSlash = shortLabel.indexOf("/");
      if (labelSlash > 0) shortLabel = shortLabel.slice(labelSlash + 1);
      option.textContent = shortLabel;
      summaryModelSelect.appendChild(option);
    }

    var hasPreferred = false;
    if (preferredModel) {
      for (var j = 0; j < models.length; j++) {
        if (models[j].value === preferredModel) {
          hasPreferred = true;
          break;
        }
      }
    }

    if (hasPreferred) {
      summaryModelSelect.value = preferredModel;
    } else if (models.length > 0) {
      summaryModelSelect.value = models[0].value;
    } else {
      summaryModelSelect.value = "";
    }

    currentSummaryModel = typeof summaryModelSelect.value === "string"
      ? summaryModelSelect.value.trim()
      : "";
  }

  function setSummaryProvider(provider, preferredModel) {
    if (summaryProviders.indexOf(provider) === -1) return;
    currentSummaryProvider = provider;

    if (summaryProviderSelect) {
      summaryProviderSelect.value = provider;
    }

    populateSummaryModelSelect(provider, preferredModel);
  }

  function initializeSummaryModelControls() {
    buildSummaryModelState();
    renderSummaryProviderSelect();

    if (summaryProviders.length === 0) {
      currentSummaryProvider = "";
      currentSummaryModel = "";
      if (summaryProviderSelect) summaryProviderSelect.innerHTML = "";
      if (summaryModelSelect) {
        summaryModelSelect.innerHTML = '<option value="">Auto</option>';
        summaryModelSelect.value = "";
      }
      return;
    }

    var defaultProvider = getSummaryProvider(defaultSummaryModel);
    if (defaultProvider && summaryProviders.indexOf(defaultProvider) !== -1) {
      setSummaryProvider(defaultProvider, defaultSummaryModel);
      return;
    }

    setSummaryProvider(summaryProviders[0], "");
  }

  function getSelectedSummaryModel() {
    if (!summaryModelSelect) return currentSummaryModel;
    if (typeof summaryModelSelect.value !== "string") return currentSummaryModel;
    currentSummaryModel = summaryModelSelect.value.trim();
    return currentSummaryModel;
  }

  function getFeedbackText() {
    if (!summaryFeedback || typeof summaryFeedback.value !== "string") return "";
    return summaryFeedback.value;
  }

  function getCoverageSet(provider) {
    var set = providerCoverage.get(provider);
    if (set) return set;
    set = new Set();
    providerCoverage.set(provider, set);
    return set;
  }

  function markCoverage(provider, slotId) {
    if (typeof slotId !== "number") return;
    var normalized = normalizeProvider(provider, "");
    if (!normalized) return;
    getCoverageSet(normalized).add(slotId);
  }

  function removeSlot(slotId) {
    allQueries = allQueries.filter(function(slot) { return slot.slotId !== slotId; });

    providerCoverage.forEach(function(coveredSlots) {
      coveredSlots.delete(slotId);
    });

    queryIndexToSlot.forEach(function(mappedSlotId, qi) {
      if (mappedSlotId === slotId) queryIndexToSlot.delete(qi);
    });

    syncLoadingPanel();`;
