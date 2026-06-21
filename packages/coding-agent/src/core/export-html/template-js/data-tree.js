    (function() {
      'use strict';

      // ============================================================
      // DATA LOADING
      // ============================================================

      const base64 = document.getElementById('session-data').textContent;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      const { header, entries, leafId: defaultLeafId, systemPrompt, tools, renderedTools } = data;

      // ============================================================
      // URL PARAMETER HANDLING
      // ============================================================

      // Parse URL parameters for deep linking: leafId and targetId
      // Check for injected params (when loaded in iframe via srcdoc) or use window.location
      const injectedParams = document.querySelector('meta[name="pi-url-params"]');
      const searchString = injectedParams ? injectedParams.content : window.location.search.substring(1);
      const urlParams = new URLSearchParams(searchString);
      const urlLeafId = urlParams.get('leafId');
      const urlTargetId = urlParams.get('targetId');
      // Use URL leafId if provided, otherwise fall back to session default
      const leafId = urlLeafId || defaultLeafId;

      // ============================================================
      // DATA STRUCTURES
      // ============================================================

      // Entry lookup by ID
      const byId = new Map();
      for (const entry of entries) {
        byId.set(entry.id, entry);
      }

      // Tool call lookup (toolCallId -> {name, arguments})
      const toolCallMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'toolCall') {
                toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
              }
            }
          }
        }
      }

      // Label lookup (entryId -> label string)
      // Labels are stored in 'label' entries that reference their target via targetId
      const labelMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'label' && entry.targetId && entry.label) {
          labelMap.set(entry.targetId, entry.label);
        }
      }

      // ============================================================
      // TREE DATA PREPARATION (no DOM, pure data)
      // ============================================================

      /**
       * Build tree structure from flat entries.
       * Returns array of root nodes, each with { entry, children, label }.
       */
      function buildTree() {
        const nodeMap = new Map();
        const roots = [];

        // Create nodes
        for (const entry of entries) {
          nodeMap.set(entry.id, {
            entry,
            children: [],
            label: labelMap.get(entry.id)
          });
        }

        // Build parent-child relationships
        for (const entry of entries) {
          const node = nodeMap.get(entry.id);
          if (entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id) {
            roots.push(node);
          } else {
            const parent = nodeMap.get(entry.parentId);
            if (parent) {
              parent.children.push(node);
            } else {
              roots.push(node);
            }
          }
        }

        // Sort children by timestamp
        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }
        roots.forEach(sortChildren);

        return roots;
      }

      /**
       * Build set of entry IDs on path from root to target.
       */
      function buildActivePathIds(targetId) {
        const ids = new Set();
        let current = byId.get(targetId);
        while (current) {
          ids.add(current.id);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return ids;
      }

      /**
       * Get array of entries from root to target (the conversation path).
       */
      function getPath(targetId) {
        const path = [];
        let current = byId.get(targetId);
        while (current) {
          path.unshift(current);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return path;
      }

      // Tree node lookup for finding leaves
      let treeNodeMap = null;

      /**
       * Find the newest leaf node reachable from a given node.
       * This allows clicking any node in a branch to show the full branch.
       * Children are sorted by timestamp, so the newest is always last.
       */
      function findNewestLeaf(nodeId) {
        // Build tree node map lazily
        if (!treeNodeMap) {
          treeNodeMap = new Map();
          const tree = buildTree();
          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);
        }

        const node = treeNodeMap.get(nodeId);
        if (!node) return nodeId;

        // Follow the newest (last) child at each level
        let current = node;
        while (current.children.length > 0) {
          current = current.children[current.children.length - 1];
        }
        return current.entry.id;
      }

      /**
       * Flatten tree into list with indentation and connector info.
       * Returns array of { node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots }.
       * Matches tree-selector.ts logic exactly.
       */
      function flattenTree(roots, activePathIds) {
        const result = [];
        const multipleRoots = roots.length > 1;

        // Mark which subtrees contain the active leaf
        const containsActive = new Map();
        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }
        roots.forEach(markActive);

        // Stack: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add roots (prioritize branch containing active leaf)
        const orderedRoots = [...roots].sort((a, b) =>
          Number(containsActive.get(b)) - Number(containsActive.get(a))
        );
        for (let i = orderedRoots.length - 1; i >= 0; i--) {
          const isLast = i === orderedRoots.length - 1;
          stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
        }

        while (stack.length > 0) {
          const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });

          const children = node.children;
          const multipleChildren = children.length > 1;

          // Order children (active branch first)
          const orderedChildren = [...children].sort((a, b) =>
            Number(containsActive.get(b)) - Number(containsActive.get(a))
          );

          // Calculate child indent (matches tree-selector.ts)
          let childIndent;
          if (multipleChildren) {
            // Parent branches: children get +1
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            // First generation after a branch: +1 for visual grouping
            childIndent = indent + 1;
          } else {
            // Single-child chain: stay flat
            childIndent = indent;
          }

          // Build gutters for children
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order for stack
          for (let i = orderedChildren.length - 1; i >= 0; i--) {
            const childIsLast = i === orderedChildren.length - 1;
            stack.push([orderedChildren[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
          }
        }

        return result;
      }

      /**
       * Build ASCII prefix string for tree node.
       */
      function buildTreePrefix(flatNode) {
        const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } = flatNode;
        const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connector = showConnector && !isVirtualRootChild ? (isLast ? '└─ ' : '├─ ') : '';
        const connectorPosition = connector ? displayIndent - 1 : -1;

        const totalChars = displayIndent * 3;
        const prefixChars = [];
        for (let i = 0; i < totalChars; i++) {
          const level = Math.floor(i / 3);
          const posInLevel = i % 3;

          const gutter = gutters.find(g => g.position === level);
          if (gutter) {
            prefixChars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ');
          } else if (connector && level === connectorPosition) {
            if (posInLevel === 0) {
              prefixChars.push(isLast ? '└' : '├');
            } else if (posInLevel === 1) {
              prefixChars.push('─');
            } else {
              prefixChars.push(' ');
            }
          } else {
            prefixChars.push(' ');
          }
        }
        return prefixChars.join('');
      }

