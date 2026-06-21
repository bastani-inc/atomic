      // ============================================================
      // FILTERING (pure data)
      // ============================================================

      let filterMode = 'default';
      let searchQuery = '';

      function hasTextContent(content) {
        if (typeof content === 'string') return content.trim().length > 0;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text && c.text.trim().length > 0) return true;
          }
        }
        return false;
      }

      function extractContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('');
        }
        return '';
      }

      /**
       * Parse a skill block from message text.
       * Returns null if the text doesn't contain a skill block.
       * Matches the format: <skill name="..." location="...">\n...\n</skill>\n\nuser message
       */
      function parseSkillBlock(text) {
        const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
        if (!match) return null;
        return {
          name: match[1],
          location: match[2],
          content: match[3],
          userMessage: match[4]?.trim() || undefined,
        };
      }

      function getSearchableText(entry, label) {
        const parts = [];
        if (label) parts.push(label);

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            parts.push(msg.role);
            if (msg.content) parts.push(extractContent(msg.content));
            if (msg.role === 'bashExecution' && msg.command) parts.push(msg.command);
            break;
          }
          case 'custom_message':
            parts.push(entry.customType);
            parts.push(typeof entry.content === 'string' ? entry.content : extractContent(entry.content));
            break;
          case 'compaction':
            parts.push('compaction');
            break;
          case 'branch_summary':
            parts.push('branch summary', entry.summary);
            break;
          case 'model_change':
            parts.push('model', entry.modelId);
            break;
          case 'thinking_level_change':
            parts.push('thinking', entry.thinkingLevel);
            break;
          case 'context_window_change':
            parts.push('context window', String(entry.contextWindow));
            break;
        }

        return parts.join(' ').toLowerCase();
      }

      /**
       * Filter flat nodes based on current filterMode and searchQuery.
       */
      function filterNodes(flatNodes, currentLeafId) {
        const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

        const filtered = flatNodes.filter(flatNode => {
          const entry = flatNode.node.entry;
          const label = flatNode.node.label;
          const isCurrentLeaf = entry.id === currentLeafId;

          // Always show current leaf
          if (isCurrentLeaf) return true;

          // Hide assistant messages with only tool calls (no text) unless error/aborted
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            const msg = entry.message;
            const hasText = hasTextContent(msg.content);
            const isErrorOrAborted = msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
            if (!hasText && !isErrorOrAborted) return false;
          }

          // Apply filter mode
          const isSettingsEntry = ['label', 'custom', 'model_change', 'thinking_level_change', 'context_window_change'].includes(entry.type);
          let passesFilter;

          switch (filterMode) {
            case 'user-only':
              passesFilter = entry.type === 'message' && entry.message.role === 'user';
              break;
            case 'no-tools':
              passesFilter = !isSettingsEntry && !(entry.type === 'message' && entry.message.role === 'toolResult');
              break;
            case 'labeled-only':
              passesFilter = label !== undefined;
              break;
            case 'all':
              passesFilter = true;
              break;
            default: // 'default'
              passesFilter = !isSettingsEntry;
              break;
          }

          if (!passesFilter) return false;

          // Apply search filter
          if (searchTokens.length > 0) {
            const nodeText = getSearchableText(entry, label);
            if (!searchTokens.every(t => nodeText.includes(t))) return false;
          }

          return true;
        });

        // Recalculate visual structure based on visible tree
        recalculateVisualStructure(filtered, flatNodes);

        return filtered;
      }

      /**
       * Recompute indentation/connectors for the filtered view
       *
       * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
       * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
       */
      function recalculateVisualStructure(filteredNodes, allFlatNodes) {
        if (filteredNodes.length === 0) return;

        const visibleIds = new Set(filteredNodes.map(n => n.node.entry.id));

        // Build entry map for parent lookup (using full tree)
        const entryMap = new Map();
        for (const flatNode of allFlatNodes) {
          entryMap.set(flatNode.node.entry.id, flatNode);
        }

        // Find nearest visible ancestor for a node
        function findVisibleAncestor(nodeId) {
          let currentId = entryMap.get(nodeId)?.node.entry.parentId;
          while (currentId != null) {
            if (visibleIds.has(currentId)) {
              return currentId;
            }
            currentId = entryMap.get(currentId)?.node.entry.parentId;
          }
          return null;
        }

        // Build visible tree structure
        const visibleParent = new Map();
        const visibleChildren = new Map();
        visibleChildren.set(null, []); // root-level nodes

        for (const flatNode of filteredNodes) {
          const nodeId = flatNode.node.entry.id;
          const ancestorId = findVisibleAncestor(nodeId);
          visibleParent.set(nodeId, ancestorId);

          if (!visibleChildren.has(ancestorId)) {
            visibleChildren.set(ancestorId, []);
          }
          visibleChildren.get(ancestorId).push(nodeId);
        }

        // Update multipleRoots based on visible roots
        const visibleRootIds = visibleChildren.get(null);
        const multipleRoots = visibleRootIds.length > 1;

        // Build a map for quick lookup: nodeId → FlatNode
        const filteredNodeMap = new Map();
        for (const flatNode of filteredNodes) {
          filteredNodeMap.set(flatNode.node.entry.id, flatNode);
        }

        // DFS traversal of visible tree, applying same indentation rules as flattenTree()
        // Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add visible roots in reverse order (to process in forward order via stack)
        for (let i = visibleRootIds.length - 1; i >= 0; i--) {
          const isLast = i === visibleRootIds.length - 1;
          stack.push([
            visibleRootIds[i],
            multipleRoots ? 1 : 0,
            multipleRoots,
            multipleRoots,
            isLast,
            [],
            multipleRoots
          ]);
        }

        while (stack.length > 0) {
          const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          const flatNode = filteredNodeMap.get(nodeId);
          if (!flatNode) continue;

          // Update this node's visual properties
          flatNode.indent = indent;
          flatNode.showConnector = showConnector;
          flatNode.isLast = isLast;
          flatNode.gutters = gutters;
          flatNode.isVirtualRootChild = isVirtualRootChild;
          flatNode.multipleRoots = multipleRoots;

          // Get visible children of this node
          const children = visibleChildren.get(nodeId) || [];
          const multipleChildren = children.length > 1;

          // Calculate child indent using same rules as flattenTree():
          // - Parent branches (multiple children): children get +1
          // - Just branched and indent > 0: children get +1 for visual grouping
          // - Single-child chain: stay flat
          let childIndent;
          if (multipleChildren) {
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            childIndent = indent + 1;
          } else {
            childIndent = indent;
          }

          // Build gutters for children (same logic as flattenTree)
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order (to process in forward order via stack)
          for (let i = children.length - 1; i >= 0; i--) {
            const childIsLast = i === children.length - 1;
            stack.push([
              children[i],
              childIndent,
              multipleChildren,
              multipleChildren,
              childIsLast,
              childGutters,
              false
            ]);
          }
        }
      }

      // ============================================================
      // TREE DISPLAY TEXT (pure data -> string)
      // ============================================================

      function shortenPath(p) {
        if (typeof p !== 'string') return '';
        if (p.startsWith('/Users/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
        }
        if (p.startsWith('/home/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
        }
        return p;
      }

      function formatToolCall(name, args) {
        switch (name) {
          case 'read': {
            const path = shortenPath(String(args.path || args.file_path || ''));
            const offset = args.offset;
            const limit = args.limit;
            let display = path;
            if (offset !== undefined || limit !== undefined) {
              const start = offset ?? 1;
              const end = limit !== undefined ? start + limit - 1 : '';
              display += `:${start}${end ? `-${end}` : ''}`;
            }
            return `[read: ${display}]`;
          }
          case 'write':
            return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'edit':
            return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'bash': {
            const rawCmd = String(args.command || '');
            const cmd = rawCmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
            return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
          }
          case 'grep':
            return `[grep: /${args.pattern || ''}/ in ${shortenPath(String(args.path || '.'))}]`;
          case 'find':
            return `[find: ${args.pattern || ''} in ${shortenPath(String(args.path || '.'))}]`;
          case 'ls':
            return `[ls: ${shortenPath(String(args.path || '.'))}]`;
          default: {
            const argsStr = JSON.stringify(args).slice(0, 40);
            return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? '...' : ''}]`;
          }
        }
      }

      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function sanitizeMarkdownUrl(value) {
        const href = String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, '');
        if (!href) return href;

        const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
        if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) {
          return null;
        }

        return href;
      }

      /**
       * Truncate string to maxLen chars, append "..." if truncated.
       */
      function truncate(s, maxLen = 100) {
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen) + '...';
      }

      /**
       * Get display text for tree node (returns HTML string).
       */
      function getTreeNodeDisplayHtml(entry, label) {
        const normalize = s => s.replace(/[\n\t]/g, ' ').trim();
        const labelHtml = label ? `<span class="tree-label">[${escapeHtml(label)}]</span> ` : '';

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            if (msg.role === 'user') {
              const rawContent = extractContent(msg.content);
              const skillBlock = parseSkillBlock(rawContent);
              if (skillBlock) {
                let treeHtml = labelHtml + `<span class="tree-role-skill">skill:</span> ${escapeHtml(skillBlock.name)}`;
                if (skillBlock.userMessage) {
                  treeHtml += ` · <span class="tree-role-user">user:</span> ${escapeHtml(truncate(normalize(skillBlock.userMessage)))}`;
                }
                return treeHtml;
              }
              const content = truncate(normalize(rawContent));
              return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'assistant') {
              const textContent = truncate(normalize(extractContent(msg.content)));
              if (textContent) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(textContent)}`;
              }
              if (msg.stopReason === 'aborted') {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`;
              }
              if (msg.errorMessage) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtml(truncate(msg.errorMessage))}</span>`;
              }
              return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`;
            }
            if (msg.role === 'toolResult') {
              const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
              if (toolCall) {
                return labelHtml + `<span class="tree-role-tool">${escapeHtml(formatToolCall(toolCall.name, toolCall.arguments))}</span>`;
              }
              return labelHtml + `<span class="tree-role-tool">[${escapeHtml(msg.toolName || 'tool')}]</span>`;
            }
            if (msg.role === 'bashExecution') {
              const cmd = truncate(normalize(msg.command || ''));
              return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtml(cmd)}`;
            }
            return labelHtml + `<span class="tree-muted">[${escapeHtml(msg.role)}]</span>`;
          }
          case 'compaction':
            return labelHtml + `<span class="tree-compaction">[compaction: ${Math.round(entry.tokensBefore/1000)}k tokens]</span>`;
          case 'branch_summary': {
            const summary = truncate(normalize(entry.summary || ''));
            return labelHtml + `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtml(summary)}`;
          }
          case 'custom_message': {
            const content = typeof entry.content === 'string' ? entry.content : extractContent(entry.content);
            return labelHtml + `<span class="tree-custom">[${escapeHtml(entry.customType)}]:</span> ${escapeHtml(truncate(normalize(content)))}`;
          }
          case 'model_change':
            return labelHtml + `<span class="tree-muted">[model: ${escapeHtml(entry.modelId)}]</span>`;
          case 'thinking_level_change':
            return labelHtml + `<span class="tree-muted">[thinking: ${escapeHtml(entry.thinkingLevel)}]</span>`;
          case 'context_window_change':
            return labelHtml + `<span class="tree-muted">[context window: ${escapeHtml(String(entry.contextWindow))}]</span>`;
          default:
            return labelHtml + `<span class="tree-muted">[${escapeHtml(entry.type)}]</span>`;
        }
      }

