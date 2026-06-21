      // ============================================================
      // INITIALIZATION
      // ============================================================

      // Configure marked with syntax highlighting and TUI-compatible HTML handling
      const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

      marked.use({
        breaks: true,
        gfm: true,
        tokenizer: {
          // Treat HTML-like input as plain text so tags are shown verbatim,
          // matching the TUI markdown renderer.
          html() {
            return undefined;
          },
          tag() {
            return undefined;
          },
          del(src) {
            const match = strictStrikethroughRegex.exec(src);
            if (!match) return undefined;
            return {
              type: 'del',
              raw: match[0],
              text: match[2],
              tokens: this.lexer.inlineTokens(match[2])
            };
          }
        },
        renderer: {
          // Sanitize link URLs with a scheme allow-list. Browsers strip C0
          // controls from schemes, so strip them before checking and emitting.
          link(token) {
            const href = sanitizeMarkdownUrl(token.href);
            if (href === null) {
              return this.parser.parseInline(token.tokens);
            }
            let out = '<a href="' + escapeHtml(href) + '"';
            if (token.title) {
              out += ' title="' + escapeHtml(token.title) + '"';
            }
            out += '>' + this.parser.parseInline(token.tokens) + '</a>';
            return out;
          },
          // Sanitize image src URLs with the same scheme allow-list.
          image(token) {
            const href = sanitizeMarkdownUrl(token.href);
            if (href === null) {
              return escapeHtml(token.text || '');
            }
            let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || '') + '"';
            if (token.title) {
              out += ' title="' + escapeHtml(token.title) + '"';
            }
            out += '>';
            return out;
          },
          // Code blocks: syntax highlight, no HTML escaping
          code(token) {
            const code = token.text;
            const lang = token.lang;
            let highlighted;
            if (lang && hljs.getLanguage(lang)) {
              try {
                highlighted = hljs.highlight(code, { language: lang }).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            } else {
              // Auto-detect language if not specified
              try {
                highlighted = hljs.highlightAuto(code).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            }
            return `<pre><code class="hljs">${highlighted}</code></pre>`;
          },
          // Inline code: escape HTML
          codespan(token) {
            return `<code>${escapeHtml(token.text)}</code>`;
          }
        }
      });

      // Simple marked parse (escaping handled in renderers)
      function safeMarkedParse(text) {
        return marked.parse(text);
      }

      // Search input
      const searchInput = document.getElementById('tree-search');
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        forceTreeRerender();
      });

      // Filter buttons
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          filterMode = btn.dataset.filter;
          forceTreeRerender();
        });
      });

      // Sidebar toggle
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const hamburger = document.getElementById('hamburger');
      const sidebarResizer = document.getElementById('sidebar-resizer');
      const SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';
      const MIN_CONTENT_WIDTH = 320;

      function isMobileLayout() {
        return window.matchMedia('(max-width: 900px)').matches;
      }

      function getSidebarBounds() {
        const rootStyles = getComputedStyle(document.documentElement);
        const minWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-min-width')) || 240;
        const maxWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-max-width')) || 720;
        const viewportMaxWidth = window.innerWidth - MIN_CONTENT_WIDTH;
        return {
          minWidth,
          maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth))
        };
      }

      function clampSidebarWidth(width) {
        const { minWidth, maxWidth } = getSidebarBounds();
        return Math.max(minWidth, Math.min(maxWidth, width));
      }

      function applySidebarWidth(width) {
        document.documentElement.style.setProperty('--sidebar-width', `${Math.round(clampSidebarWidth(width))}px`);
      }

      function loadSidebarWidth() {
        try {
          const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
          if (raw === null) return null;
          const width = Number(raw);
          return Number.isFinite(width) ? width : null;
        } catch {
          return null;
        }
      }

      function saveSidebarWidth(width) {
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
        } catch {
          // Ignore storage failures (e.g. private browsing restrictions)
        }
      }

      function setupSidebarResize() {
        const savedWidth = loadSidebarWidth();
        if (savedWidth !== null) {
          applySidebarWidth(savedWidth);
        }

        if (!sidebarResizer) return;

        let cleanupDrag = null;

        const stopDrag = (pointerId) => {
          if (cleanupDrag) {
            cleanupDrag(pointerId);
            cleanupDrag = null;
          }
        };

        sidebarResizer.addEventListener('pointerdown', (e) => {
          if (isMobileLayout()) return;

          e.preventDefault();
          const startX = e.clientX;
          const startWidth = sidebar.getBoundingClientRect().width;
          document.body.classList.add('sidebar-resizing');
          sidebarResizer.setPointerCapture?.(e.pointerId);

          const onPointerMove = (event) => {
            applySidebarWidth(startWidth + (event.clientX - startX));
          };

          cleanupDrag = (pointerIdToRelease) => {
            document.body.classList.remove('sidebar-resizing');
            sidebarResizer.releasePointerCapture?.(pointerIdToRelease);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
            saveSidebarWidth(sidebar.getBoundingClientRect().width);
          };

          const onPointerUp = (event) => stopDrag(event.pointerId);
          const onPointerCancel = (event) => stopDrag(event.pointerId);

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerCancel);
        });

        sidebarResizer.addEventListener('dblclick', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(400);
          saveSidebarWidth(400);
        });

        window.addEventListener('resize', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(sidebar.getBoundingClientRect().width);
        });
      }

      setupSidebarResize();

      hamburger.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        hamburger.style.display = 'none';
      });

      const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        hamburger.style.display = '';
      };

      overlay.addEventListener('click', closeSidebar);
      document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

      // Toggle states
      let thinkingExpanded = true;
      let toolOutputsExpanded = false;

      const toggleThinking = () => {
        thinkingExpanded = !thinkingExpanded;
        document.querySelectorAll('.thinking-text').forEach(el => {
          el.style.display = thinkingExpanded ? '' : 'none';
        });
        document.querySelectorAll('.thinking-collapsed').forEach(el => {
          el.style.display = thinkingExpanded ? 'none' : 'block';
        });
      };

      const toggleToolOutputs = () => {
        toolOutputsExpanded = !toolOutputsExpanded;
        document.querySelectorAll('.tool-output.expandable').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
        document.querySelectorAll('.compaction').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
        document.querySelectorAll('.skill-invocation').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
      };

      const attachHeaderHandlers = () => {
        document.querySelector('[data-action="toggle-thinking"]')?.addEventListener('click', toggleThinking);
        document.querySelector('[data-action="toggle-tools"]')?.addEventListener('click', toggleToolOutputs);
      };

      const isEditableTarget = (element) => {
        if (!element) return false;
        const tagName = element.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') {
          return true;
        }
        return element.isContentEditable || Boolean(element.closest?.('[contenteditable="true"]'));
      };

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          searchQuery = '';
          navigateTo(leafId, 'bottom');
        }

        if (isEditableTarget(document.activeElement)) {
          return;
        }

        const key = e.key.toLowerCase();
        if (key === 't') {
          e.preventDefault();
          toggleThinking();
        } else if (key === 'o') {
          e.preventDefault();
          toggleToolOutputs();
        }
      });

      // Initial render
      // If URL has targetId, scroll to that specific message; otherwise stay at top
      if (leafId) {
        if (urlTargetId && byId.has(urlTargetId)) {
          // Deep link: navigate to leaf and scroll to target message
          navigateTo(leafId, 'target', urlTargetId);
        } else {
          navigateTo(leafId, 'none');
        }
      } else if (entries.length > 0) {
        // Fallback: use last entry if no leafId
        navigateTo(entries[entries.length - 1].id, 'none');
      }
    })();
