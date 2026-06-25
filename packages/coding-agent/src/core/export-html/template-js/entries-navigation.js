      /**
       * Copy text to clipboard with visual feedback.
       * Uses navigator.clipboard with fallback to execCommand for HTTP contexts.
       */
      async function copyToClipboard(text, button) {
        let success = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            success = true;
          }
        } catch (err) {
          // Clipboard API failed, try fallback
        }

        // Fallback for HTTP or when Clipboard API is unavailable
        if (!success) {
          try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            success = document.execCommand('copy');
            document.body.removeChild(textarea);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        }

        if (success && button) {
          const originalHtml = button.innerHTML;
          button.innerHTML = '✓';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied');
          }, 1500);
        }
      }

      /**
       * Render the copy-link button HTML for a message.
       */
      function renderCopyLinkButton(entryId) {
        return `<button class="copy-link-btn" data-entry-id="${escapeHtml(entryId)}" title="Copy link to this message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>`;
      }

      function renderEntry(entry) {
        const ts = formatTimestamp(entry.timestamp);
        const tsHtml = ts ? `<div class="message-timestamp">${ts}</div>` : '';
        const entryDomId = `entry-${escapeHtml(entry.id)}`;
        const copyBtnHtml = renderCopyLinkButton(entry.id);

        if (entry.type === 'message') {
          const msg = entry.message;

          if (msg.role === 'user') {
            const content = msg.content;
            const text = typeof content === 'string' ? content :
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            const skillBlock = parseSkillBlock(text);

            if (skillBlock) {
              // Collect images from content array
              const images = Array.isArray(content) ? content.filter(c => c.type === 'image') : [];
              const hasUserContent = skillBlock.userMessage || images.length > 0;
              let html = `<div class="skill-user-entry" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

              // Skill invocation (collapsed by default, click to expand)
              html += `<div class="skill-invocation" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                <div class="skill-invocation-label">[skill] ${escapeHtml(skillBlock.name)}</div>
                <div class="skill-invocation-collapsed">${escapeHtml(skillBlock.name)} (click to expand)</div>
                <div class="skill-invocation-content markdown-content">${safeMarkedParse(skillBlock.content)}</div>
              </div>`;

              // User message (separate block if present)
              if (hasUserContent) {
                html += '<div class="user-message">';
                if (images.length > 0) {
                  html += '<div class="message-images">';
                  for (const img of images) {
                    html += `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="message-image" />`;
                  }
                  html += '</div>';
                }
                if (skillBlock.userMessage) {
                  html += `<div class="markdown-content">${safeMarkedParse(skillBlock.userMessage)}</div>`;
                }
                html += '</div>';
              }

              html += '</div>';
              return html;
            }

            // No skill block - normal user message
            let html = `<div class="user-message" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

            if (Array.isArray(content)) {
              const images = content.filter(c => c.type === 'image');
              if (images.length > 0) {
                html += '<div class="message-images">';
                for (const img of images) {
                  html += `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="message-image" />`;
                }
                html += '</div>';
              }
            }

            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'assistant') {
            let html = `<div class="assistant-message" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

            for (const block of msg.content) {
              if (block.type === 'text' && block.text.trim()) {
                html += `<div class="assistant-text markdown-content">${safeMarkedParse(block.text)}</div>`;
              } else if (block.type === 'thinking' && block.thinking.trim()) {
                html += `<div class="thinking-block">
                  <div class="thinking-text">${escapeHtml(block.thinking)}</div>
                  <div class="thinking-collapsed">Thinking ...</div>
                </div>`;
              }
            }

            for (const block of msg.content) {
              if (block.type === 'toolCall') {
                html += renderToolCall(block);
              }
            }

            if (msg.stopReason === 'aborted') {
              html += '<div class="error-text">Aborted</div>';
            } else if (msg.stopReason === 'error') {
              html += `<div class="error-text">Error: ${escapeHtml(msg.errorMessage || 'Unknown error')}</div>`;
            }

            html += '</div>';
            return html;
          }

          if (msg.role === 'bashExecution') {
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryDomId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.command)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${msg.exitCode})</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'toolResult') return '';
        }

        if (entry.type === 'model_change') {
          return `<div class="model-change" id="${entryDomId}">${tsHtml}Switched to model: <span class="model-name">${escapeHtml(entry.provider)}/${escapeHtml(entry.modelId)}</span></div>`;
        }

        if (entry.type === 'context_window_change') {
          return `<div class="model-change" id="${entryDomId}">${tsHtml}Context window: <span class="model-name">${escapeHtml(String(entry.contextWindow))}</span></div>`;
        }

        if (entry.type === 'compaction') {
          return `<div class="compaction" id="${entryDomId}" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
            <div class="compaction-label">[compaction]</div>
            <div class="compaction-collapsed">Compacted from ${entry.tokensBefore.toLocaleString()} tokens</div>
            <div class="compaction-content"><strong>Compacted from ${entry.tokensBefore.toLocaleString()} tokens</strong>\n\n${escapeHtml(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'branch_summary') {
          return `<div class="branch-summary" id="${entryDomId}">${tsHtml}
            <div class="branch-summary-header">Branch Summary</div>
            <div class="markdown-content">${safeMarkedParse(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'custom_message' && entry.display) {
          return `<div class="hook-message" id="${entryDomId}">${tsHtml}
            <div class="hook-type">[${escapeHtml(entry.customType)}]</div>
            <div class="markdown-content">${safeMarkedParse(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))}</div>
          </div>`;
        }

        return '';
      }

      // ============================================================
      // HEADER / STATS
      // ============================================================

      function computeStats(entryList) {
        let userMessages = 0, assistantMessages = 0, toolResults = 0;
        let customMessages = 0, compactions = 0, branchSummaries = 0, toolCalls = 0;
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const models = new Set();

        for (const entry of entryList) {
          if (entry.type === 'message') {
            const msg = entry.message;
            if (msg.role === 'user') userMessages++;
            if (msg.role === 'assistant') {
              assistantMessages++;
              if (msg.model) models.add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
              if (msg.usage) {
                tokens.input += msg.usage.input || 0;
                tokens.output += msg.usage.output || 0;
                tokens.cacheRead += msg.usage.cacheRead || 0;
                tokens.cacheWrite += msg.usage.cacheWrite || 0;
                if (msg.usage.cost) {
                  cost.input += msg.usage.cost.input || 0;
                  cost.output += msg.usage.cost.output || 0;
                  cost.cacheRead += msg.usage.cost.cacheRead || 0;
                  cost.cacheWrite += msg.usage.cost.cacheWrite || 0;
                }
              }
              toolCalls += msg.content.filter(c => c.type === 'toolCall').length;
            }
            if (msg.role === 'toolResult') toolResults++;
          } else if (entry.type === 'compaction') {
            compactions++;
          } else if (entry.type === 'branch_summary') {
            branchSummaries++;
          } else if (entry.type === 'custom_message') {
            customMessages++;
          }
        }

        return { userMessages, assistantMessages, toolResults, customMessages, compactions, branchSummaries, toolCalls, tokens, cost, models: Array.from(models) };
      }

      const globalStats = computeStats(entries);

      function renderHeader() {
        const totalCost = globalStats.cost.input + globalStats.cost.output + globalStats.cost.cacheRead + globalStats.cost.cacheWrite;

        const tokenParts = [];
        if (globalStats.tokens.input) tokenParts.push(`↑${formatTokens(globalStats.tokens.input)}`);
        if (globalStats.tokens.output) tokenParts.push(`↓${formatTokens(globalStats.tokens.output)}`);
        if (globalStats.tokens.cacheRead) tokenParts.push(`R${formatTokens(globalStats.tokens.cacheRead)}`);
        if (globalStats.tokens.cacheWrite) tokenParts.push(`W${formatTokens(globalStats.tokens.cacheWrite)}`);

        const msgParts = [];
        if (globalStats.userMessages) msgParts.push(`${globalStats.userMessages} user`);
        if (globalStats.assistantMessages) msgParts.push(`${globalStats.assistantMessages} assistant`);
        if (globalStats.toolResults) msgParts.push(`${globalStats.toolResults} tool results`);
        if (globalStats.customMessages) msgParts.push(`${globalStats.customMessages} custom`);
        if (globalStats.compactions) msgParts.push(`${globalStats.compactions} compactions`);
        if (globalStats.branchSummaries) msgParts.push(`${globalStats.branchSummaries} branch summaries`);

        let html = `
          <div class="header">
            <h1>Session: ${escapeHtml(header?.id || 'unknown')}</h1>
            <div class="help-bar">
              <span class="help-hint">T toggle thinking · O toggle tools</span>
              <div class="help-actions">
                <button type="button" class="header-toggle-btn" data-action="toggle-thinking" title="Toggle thinking (T)">Toggle thinking</button>
                <button type="button" class="header-toggle-btn" data-action="toggle-tools" title="Toggle tools (O)">Toggle tools</button>
                <button type="button" class="download-json-btn" onclick="downloadSessionJson()" title="Download session as JSONL">↓ JSONL</button>
              </div>
            </div>
            <div class="header-info">
              <div class="info-item"><span class="info-label">Date:</span><span class="info-value">${header?.timestamp ? new Date(header.timestamp).toLocaleString() : 'unknown'}</span></div>
              <div class="info-item"><span class="info-label">Models:</span><span class="info-value">${escapeHtml(globalStats.models.join(', ') || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Messages:</span><span class="info-value">${msgParts.join(', ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Tool Calls:</span><span class="info-value">${globalStats.toolCalls}</span></div>
              <div class="info-item"><span class="info-label">Tokens:</span><span class="info-value">${tokenParts.join(' ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Cost:</span><span class="info-value">$${totalCost.toFixed(3)}</span></div>
            </div>
          </div>`;

        // Render system prompt (user's base prompt, applies to all providers)
        if (systemPrompt) {
          const lines = systemPrompt.split('\n');
          const previewLines = 10;
          if (lines.length > previewLines) {
            const preview = lines.slice(0, previewLines).join('\n');
            const remaining = lines.length - previewLines;
            html += `<div class="system-prompt expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
              <div class="system-prompt-header">System Prompt</div>
              <div class="system-prompt-preview">${escapeHtml(preview)}</div>
              <div class="system-prompt-expand-hint">... (${remaining} more lines, click to expand)</div>
              <div class="system-prompt-full">${escapeHtml(systemPrompt)}</div>
            </div>`;
          } else {
            html += `<div class="system-prompt">
              <div class="system-prompt-header">System Prompt</div>
              <div class="system-prompt-full" style="display: block">${escapeHtml(systemPrompt)}</div>
            </div>`;
          }
        }

        if (tools && tools.length > 0) {
          html += `<div class="tools-list">
            <div class="tools-header">Available Tools</div>
            <div class="tools-content">
              ${tools.map(t => {
                const hasParams = t.parameters && typeof t.parameters === 'object' && t.parameters.properties && Object.keys(t.parameters.properties).length > 0;
                if (!hasParams) {
                  return `<div class="tool-item"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span></div>`;
                }
                const params = t.parameters;
                const properties = params.properties;
                const required = params.required || [];
                let paramsHtml = '';
                for (const [name, prop] of Object.entries(properties)) {
                  const isRequired = required.includes(name);
                  const typeStr = prop.type || 'any';
                  const reqLabel = isRequired ? '<span class="tool-param-required">required</span>' : '<span class="tool-param-optional">optional</span>';
                  paramsHtml += `<div class="tool-param"><span class="tool-param-name">${escapeHtml(name)}</span> <span class="tool-param-type">${escapeHtml(typeStr)}</span> ${reqLabel}`;
                  if (prop.description) {
                    paramsHtml += `<div class="tool-param-desc">${escapeHtml(prop.description)}</div>`;
                  }
                  paramsHtml += `</div>`;
                }
                return `<div class="tool-item" onclick="if(window.getSelection().toString())return;this.classList.toggle('params-expanded')"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span> <span class="tool-params-hint"></span><div class="tool-params-content">${paramsHtml}</div></div>`;
              }).join('')}
            </div>
          </div>`;
        }

        return html;
      }

      // ============================================================
      // NAVIGATION
      // ============================================================

      // Cache for rendered entry DOM nodes
      const entryCache = new Map();

      function renderEntryToNode(entry) {
        // Check cache first
        if (entryCache.has(entry.id)) {
          return entryCache.get(entry.id).cloneNode(true);
        }

        // Render to HTML string, then parse to node
        const html = renderEntry(entry);
        if (!html) return null;

        const template = document.createElement('template');
        template.innerHTML = html;
        const node = template.content.firstElementChild;

        // Cache the node
        if (node) {
          entryCache.set(entry.id, node.cloneNode(true));
        }
        return node;
      }

      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {
        currentLeafId = targetId;
        currentTargetId = scrollToEntryId || targetId;
        const path = getPath(targetId);

        renderTree();

        document.getElementById('header-container').innerHTML = renderHeader();
        attachHeaderHandlers();

        // Build messages using cached DOM nodes
        const messagesEl = document.getElementById('messages');
        const fragment = document.createDocumentFragment();

        for (const entry of path) {
          const node = renderEntryToNode(entry);
          if (node) {
            fragment.appendChild(node);
          }
        }

        messagesEl.innerHTML = '';
        messagesEl.appendChild(fragment);

        // Attach click handlers for copy-link buttons
        messagesEl.querySelectorAll('.copy-link-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = btn.dataset.entryId;
            const shareUrl = buildShareUrl(entryId);
            copyToClipboard(shareUrl, btn);
          });
        });

        // Use setTimeout(0) to ensure DOM is fully laid out before scrolling
        setTimeout(() => {
          const content = document.getElementById('content');
          if (scrollMode === 'bottom') {
            content.scrollTop = content.scrollHeight;
          } else if (scrollMode === 'target') {
            // If scrollToEntryId is provided, scroll to that specific entry
            const scrollTargetId = scrollToEntryId || targetId;
            const targetEl = document.getElementById(`entry-${scrollTargetId}`);
            if (targetEl) {
              targetEl.scrollIntoView({ block: 'center' });
              // Briefly highlight the target message
              if (scrollToEntryId) {
                targetEl.classList.add('highlight');
                setTimeout(() => targetEl.classList.remove('highlight'), 2000);
              }
            }
          }
        }, 0);
      }

