      // ============================================================
      // TREE RENDERING (DOM manipulation)
      // ============================================================

      let currentLeafId = leafId;
      let currentTargetId = urlTargetId || leafId;
      let treeRendered = false;

      function renderTree() {
        const tree = buildTree();
        const activePathIds = buildActivePathIds(currentLeafId);
        const flatNodes = flattenTree(tree, activePathIds);
        const filtered = filterNodes(flatNodes, currentLeafId);
        const container = document.getElementById('tree-container');

        // Full render only on first call or when filter/search changes
        if (!treeRendered) {
          container.innerHTML = '';

          for (const flatNode of filtered) {
            const entry = flatNode.node.entry;
            const isOnPath = activePathIds.has(entry.id);
            const isTarget = entry.id === currentTargetId;

            const div = document.createElement('div');
            div.className = 'tree-node';
            if (isOnPath) div.classList.add('in-path');
            if (isTarget) div.classList.add('active');
            div.dataset.id = entry.id;

            const prefix = buildTreePrefix(flatNode);
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            prefixSpan.textContent = prefix;

            const marker = document.createElement('span');
            marker.className = 'tree-marker';
            marker.textContent = isOnPath ? '•' : ' ';

            const content = document.createElement('span');
            content.className = 'tree-content';
            content.innerHTML = getTreeNodeDisplayHtml(entry, flatNode.node.label);

            div.appendChild(prefixSpan);
            div.appendChild(marker);
            div.appendChild(content);
            // Navigate to the newest leaf through this node, but scroll to the clicked node
            div.addEventListener('click', () => {
              if (window.getSelection().toString()) return;
              const leafId = findNewestLeaf(entry.id);
              navigateTo(leafId, 'target', entry.id);
            });

            container.appendChild(div);
          }

          treeRendered = true;
        } else {
          // Just update markers and classes
          const nodes = container.querySelectorAll('.tree-node');
          for (const node of nodes) {
            const id = node.dataset.id;
            const isOnPath = activePathIds.has(id);
            const isTarget = id === currentTargetId;

            node.classList.toggle('in-path', isOnPath);
            node.classList.toggle('active', isTarget);

            const marker = node.querySelector('.tree-marker');
            if (marker) {
              marker.textContent = isOnPath ? '•' : ' ';
            }
          }
        }

        document.getElementById('tree-status').textContent = `${filtered.length} / ${flatNodes.length} entries`;

        // Scroll active node into view after layout
        setTimeout(() => {
          const activeNode = container.querySelector('.tree-node.active');
          if (activeNode) {
            activeNode.scrollIntoView({ block: 'nearest' });
          }
        }, 0);
      }

      function forceTreeRerender() {
        treeRendered = false;
        renderTree();
      }

      // ============================================================
      // MESSAGE RENDERING
      // ============================================================

      function formatTokens(count) {
        if (count < 1000) return count.toString();
        if (count < 10000) return (count / 1000).toFixed(1) + 'k';
        if (count < 1000000) return Math.round(count / 1000) + 'k';
        return (count / 1000000).toFixed(1) + 'M';
      }

      function formatTimestamp(ts) {
        if (!ts) return '';
        const date = new Date(ts);
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function replaceTabs(text) {
        return text.replace(/\t/g, '   ');
      }

      /** Safely coerce value to string for display. Returns null if invalid type. */
      function str(value) {
        if (typeof value === 'string') return value;
        if (value == null) return '';
        return null;
      }

      function getLanguageFromPath(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const extToLang = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
          c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
          php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
          sql: 'sql', html: 'html', css: 'css', scss: 'scss',
          json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
          md: 'markdown', dockerfile: 'dockerfile'
        };
        return extToLang[ext];
      }

      function findToolResult(toolCallId) {
        for (const entry of entries) {
          if (entry.type === 'message' && entry.message.role === 'toolResult') {
            if (entry.message.toolCallId === toolCallId) {
              return entry.message;
            }
          }
        }
        return null;
      }

      function formatExpandableOutput(text, maxLines, lang) {
        text = replaceTabs(text);
        const lines = text.split('\n');
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        if (lang) {
          let highlighted;
          try {
            highlighted = hljs.highlight(text, { language: lang }).value;
          } catch {
            highlighted = escapeHtml(text);
          }

          if (remaining > 0) {
            const previewCode = displayLines.join('\n');
            let previewHighlighted;
            try {
              previewHighlighted = hljs.highlight(previewCode, { language: lang }).value;
            } catch {
              previewHighlighted = escapeHtml(previewCode);
            }

            return `<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
              <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
              <div class="expand-hint">... (${remaining} more lines)</div></div>
              <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
          }

          return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
        }

        // Plain text output
        if (remaining > 0) {
          let out = '<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle(\'expanded\')">';
          out += '<div class="output-preview">';
          for (const line of displayLines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
          out += '<div class="output-full">';
          for (const line of lines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += '</div></div>';
          return out;
        }

        let out = '<div class="tool-output">';
        for (const line of displayLines) {
          out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        out += '</div>';
        return out;
      }

      function renderToolCall(call) {
        const result = findToolResult(call.id);
        const isError = result?.isError || false;
        const statusClass = result ? (isError ? 'error' : 'success') : 'pending';

        const getResultText = () => {
          if (!result) return '';
          const textBlocks = result.content.filter(c => c.type === 'text');
          return textBlocks.map(c => c.text).join('\n');
        };

        const getResultImages = () => {
          if (!result) return [];
          return result.content.filter(c => c.type === 'image');
        };

        const renderResultImages = () => {
          const images = getResultImages();
          if (images.length === 0) return '';
          return '<div class="tool-images">' +
            images.map(img => `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="tool-image" />`).join('') +
            '</div>';
        };

        let html = `<div class="tool-execution ${statusClass}">`;
        const args = call.arguments || {};
        const name = call.name;

        const invalidArg = '<span class="tool-error">[invalid arg]</span>';

        switch (name) {
          case 'bash': {
            const command = str(args.command);
            const cmdDisplay = command === null ? invalidArg : escapeHtml(command || '...');
            html += `<div class="tool-command">$ ${cmdDisplay}</div>`;
            if (result) {
              const output = getResultText().trim();
              if (output) html += formatExpandableOutput(output, 5);
            }
            break;
          }
          case 'read': {
            const filePath = str(args.file_path ?? args.path);
            const offset = args.offset;
            const limit = args.limit;

            let pathHtml = filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''));
            if (filePath !== null && (offset !== undefined || limit !== undefined)) {
              const startLine = offset ?? 1;
              const endLine = limit !== undefined ? startLine + limit - 1 : '';
              pathHtml += `<span class="line-numbers">:${startLine}${endLine ? '-' + endLine : ''}</span>`;
            }

            html += `<div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${pathHtml}</span></div>`;
            if (result) {
              html += renderResultImages();
              const output = getResultText();
              const lang = filePath ? getLanguageFromPath(filePath) : null;
              if (output) html += formatExpandableOutput(output, 10, lang);
            }
            break;
          }
          case 'write': {
            const filePath = str(args.file_path ?? args.path);
            const content = str(args.content);

            html += `<div class="tool-header"><span class="tool-name">write</span> <span class="tool-path">${filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''))}</span>`;
            if (content !== null && content) {
              const lines = content.split('\n');
              if (lines.length > 10) html += ` <span class="line-count">(${lines.length} lines)</span>`;
            }
            html += '</div>';

            if (content === null) {
              html += `<div class="tool-error">[invalid content arg - expected string]</div>`;
            } else if (content) {
              const lang = filePath ? getLanguageFromPath(filePath) : null;
              html += formatExpandableOutput(content, 10, lang);
            }
            if (result) {
              const output = getResultText().trim();
              if (output) html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
            }
            break;
          }
          case 'edit': {
            const filePath = str(args.file_path ?? args.path);
            html += `<div class="tool-header"><span class="tool-name">edit</span> <span class="tool-path">${filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''))}</span></div>`;

            if (result?.details?.diff) {
              const diffLines = result.details.diff.split('\n');
              html += '<div class="tool-diff">';
              for (const line of diffLines) {
                const cls = line.match(/^\+/) ? 'diff-added' : line.match(/^-/) ? 'diff-removed' : 'diff-context';
                html += `<div class="${cls}">${escapeHtml(replaceTabs(line))}</div>`;
              }
              html += '</div>';
            } else if (result) {
              const output = getResultText().trim();
              if (output) html += `<div class="tool-output"><pre>${escapeHtml(output)}</pre></div>`;
            }
            break;
          }
          case 'ls': {
            const dirPath = str(args.path);
            const limit = args.limit;

            let pathHtml = dirPath === null ? invalidArg : escapeHtml(shortenPath(dirPath || '.'));
            if (limit !== undefined) {
              pathHtml += ` <span class="line-count">(limit ${escapeHtml(String(limit))})</span>`;
            }

            html += `<div class="tool-header"><span class="tool-name">ls</span> <span class="tool-path">${pathHtml}</span></div>`;
            if (result) {
              const output = getResultText().trim();
              if (output) html += formatExpandableOutput(output, 20);
            }
            break;
          }
          default: {
            // Check for pre-rendered custom tool HTML
            const rendered = renderedTools?.[call.id];
            if (rendered?.callHtml || rendered?.resultHtmlCollapsed || rendered?.resultHtmlExpanded) {
              // Custom tool with pre-rendered HTML from TUI renderer
              if (rendered.callHtml) {
                html += `<div class="tool-header ansi-rendered">${rendered.callHtml}</div>`;
              } else {
                html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
              }

              if (rendered.resultHtmlCollapsed && rendered.resultHtmlExpanded && rendered.resultHtmlCollapsed !== rendered.resultHtmlExpanded) {
                // Both collapsed and expanded differ - render expandable section
                html += `<div class="tool-output expandable ansi-rendered" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                  <div class="output-preview">${rendered.resultHtmlCollapsed}</div>
                  <div class="output-full">${rendered.resultHtmlExpanded}</div>
                </div>`;
              } else if (rendered.resultHtmlExpanded) {
                // Only expanded exists (or collapsed is identical) - show directly
                html += `<div class="tool-output ansi-rendered">${rendered.resultHtmlExpanded}</div>`;
              } else if (result) {
                // No pre-rendered result HTML - fallback to JSON
                const output = getResultText();
                if (output) html += formatExpandableOutput(output, 10);
              }
            } else {
              // Fallback to JSON display (existing behavior)
              html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
              html += `<div class="tool-output"><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;
              if (result) {
                const output = getResultText();
                if (output) html += formatExpandableOutput(output, 10);
              }
            }
          }
        }

        html += '</div>';
        return html;
      }

      /**
       * Download the session data as a JSONL file.
       * Reconstructs the original format: header line + entry lines.
       */
      window.downloadSessionJson = function() {
        // Build JSONL content: header first, then all entries
        const lines = [];
        if (header) {
          lines.push(JSON.stringify({ type: 'header', ...header }));
        }
        for (const entry of entries) {
          lines.push(JSON.stringify(entry));
        }
        const jsonlContent = lines.join('\n');

        // Create download
        const blob = new Blob([jsonlContent], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${header?.id || 'session'}.jsonl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      /**
       * Build a shareable URL for a specific message.
       * URL format: base?gistId&leafId=<leafId>&targetId=<entryId>
       */
      function buildShareUrl(entryId) {
        // Check for injected base URL (used when loaded in iframe via srcdoc)
        const baseUrlMeta = document.querySelector('meta[name="pi-share-base-url"]');
        const baseUrl = baseUrlMeta ? baseUrlMeta.content : window.location.href.split('?')[0];

        const url = new URL(window.location.href);
        // Find the gist ID (first query param without value, e.g., ?abc123)
        const gistId = Array.from(url.searchParams.keys()).find(k => !url.searchParams.get(k));

        // Build the share URL
        const params = new URLSearchParams();
        params.set('leafId', currentLeafId);
        params.set('targetId', entryId);

        // If we have an injected base URL (iframe context), use it directly
        if (baseUrlMeta) {
          return `${baseUrl}&${params.toString()}`;
        }

        // Otherwise build from current location (direct file access)
        url.search = gistId ? `?${gistId}&${params.toString()}` : `?${params.toString()}`;
        return url.toString();
      }

