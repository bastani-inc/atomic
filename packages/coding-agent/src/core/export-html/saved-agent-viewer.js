      // Main's row cache is already visited in branch order. Attach a painter only to the
      // first proven entry on each eligible branch, not to paths that may later contradict it.
      // Thus an unvisited fork costs no subtree walk, and an ordinary paint has no extra row lookups.
      let acceptedCards = null;
      let savedPrefixes;
      function acceptCard(card) {
        card.next = acceptedCards;
        acceptedCards = card;
      }
      function attachCard(id, card) {
        const entry = byId.get(id);
        // A receipt or bookkeeping marker has no node. A real turn that disambiguates a fork
        // must still return its ordinary row and cache it exactly once.
        let ordinary = entry.type === 'custom' || entry.message?.role === 'toolResult' ? null : undefined;
        entryCache.set(id, { cloneNode() {
          acceptCard(card);
          if (ordinary === undefined) {
            const template = document.createElement('template');
            template.innerHTML = renderEntry(entry);
            ordinary = template.content.firstElementChild;
          }
          return ordinary && ordinary.cloneNode(true);
        } });
      }
      for (const card of data.savedAgentCards) {
        if (card.branches) {
          for (const id of card.branches) attachCard(id, card);
          if (!savedPrefixes) savedPrefixes = new Map();
          for (const id of card.prefixes) savedPrefixes.set(id, card);
        } else {
          attachCard(card.receipt, card);
        }
      }
      function paintSavedAgentCards() {
        const prefix = savedPrefixes?.get(currentLeafId);
        if (prefix) acceptCard(prefix);
        while (acceptedCards) {
          const card = acceptedCards;
          acceptedCards = card.next;
          card.next = null;
          const entry = document.getElementById(`entry-${card.launch}`);
          const row = entry?.querySelector('.tool-execution');
          if (row) row.replaceWith(recordedAgentNode(card));
        }
      }

      function recordedAgentNode(card) {
        if (card.node) return card.node.cloneNode(true);
        const entry = byId.get(card.launch);
        const receipt = byId.get(card.receipt);

        // Render just the ordinary tool (not its enclosing assistant prose) with the receipt
        // for this branch. All raw arguments, nested calls and formatting come from the viewer.
        const call = entry.message.content.find(b => b?.type === 'toolCall');
        const args = call.arguments;
        const template = document.createElement('template');
        template.innerHTML = renderToolCall(call, receipt.message);
        const row = template.content.firstElementChild;
        const child = receipt.message.details.results[0];
        let history = 'Child history is not included in this export.';
        let answer;
        if (child) {
          const calls = [];
          if (Array.isArray(child.messages)) {
            for (const msg of child.messages) {
              if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
              for (const block of msg.content) {
                if (block?.type !== 'toolCall' || typeof block.name !== 'string') continue;
                const arg = block.arguments;
                calls.push(block.name === 'read' && typeof (arg?.path ?? arg?.file_path) === 'string'
                  ? `Read(${arg.path ?? arg.file_path})` : `${block.name}(${JSON.stringify(arg ?? {})})`);
              }
            }
          }
          if (!calls.length) {
            for (const summary of child.toolCalls) {
              const line = summary.expandedText || summary.text;
              calls.push(line.startsWith('read ') ? `Read(${line.slice(5)})` : line);
            }
          }
          history = calls.join('\n');
          answer = child.finalOutput ?? child.messages[child.messages.length - 1].content[card.answerBlock].text;
        }
        const title = args.task.split('\n', 1)[0];
        const details = document.createElement('details');
        details.innerHTML = '<summary>Recorded arguments and result</summary>';
        row.firstElementChild.remove(); // Replace only the ordinary tool title.
        while (row.firstChild) details.appendChild(row.firstChild);
        const images = receipt.message.content.filter(block => block.type === 'image');
        if (images.length) {
          const imageBlock = document.createElement('div');
          imageBlock.className = 'tool-images';
          imageBlock.innerHTML = images.map(img => `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="tool-image" />`).join('');
          details.appendChild(imageBlock);
        }
        row.innerHTML = `<div class="tool-header" style="overflow-wrap:anywhere"><span class="tool-name">Agent(${escapeHtml(args.agent)} · ${escapeHtml(title)})</span></div>` +
          `<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')"><div class="output-preview">${child ? 'Recorded result' : 'Recorded handoff'}<div class="expand-hint">Show recorded details</div></div><div class="output-full"><strong>Prompt</strong><pre>${escapeHtml(args.task)}</pre><strong>Tool calls (recorded)</strong><pre>${escapeHtml(history)}</pre>${answer === undefined ? '' : `<strong>Result</strong><pre>${escapeHtml(answer)}</pre>`}</div></div>`;
        row.appendChild(details);
        card.node = row.cloneNode(true);
        return row;
      }
