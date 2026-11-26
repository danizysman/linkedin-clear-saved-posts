(() => {
  const STORAGE_KEYS = {
    TARGET_URNS: 'targetUrns',
    UNSAVED_URNS: 'unsavedUrns'
  };

  const URN_REGEX = /urn:li:(?:activity|ugcPost):\d+/;
  const UNSAVE_LABELS = ['unsave', 'dejar de guardar'];
  const MAX_EMPTY_SCROLL_ATTEMPTS = 3;
  const SCROLL_WAIT_MS = 1600;
  const MENU_TIMEOUT_MS = 4000;

  const state = {
    status: 'idle',
    shouldStop: false,
    message: 'Idle',
    stats: {
      scanned: 0,
      matched: 0,
      unsaved: 0,
      skipped: 0
    }
  };

  function log(...args) {
    console.log('[LinkedIn Unsave Automator]', ...args);
  }

  function emitProgress(status, message) {
    if (status) state.status = status;
    if (message) state.message = message;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'PROGRESS',
          status: state.status,
          message: state.message,
          stats: { ...state.stats }
        },
        () => {
          // Read lastError to avoid unchecked runtime.lastError warnings when popup is closed.
          void chrome.runtime.lastError;
        }
      );
    } catch {
      // Ignore messaging errors when popup is closed.
    }
  }

  function randomDelayMs(minMs, maxMs) {
    const low = Math.max(0, minMs);
    const high = Math.max(low, maxMs);
    return Math.floor(low + Math.random() * (high - low));
  }

  async function sleepInterruptible(ms) {
    const step = 150;
    let elapsed = 0;
    while (elapsed < ms && !state.shouldStop) {
      const wait = Math.min(step, ms - elapsed);
      await new Promise((resolve) => setTimeout(resolve, wait));
      elapsed += wait;
    }
  }

  function decodeSafely(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function extractCardUrn(card) {
    const directAttrs = ['data-urn', 'data-id', 'data-chameleon-result-urn'];
    for (const attr of directAttrs) {
      const val = card.getAttribute(attr);
      if (val) {
        const match = decodeSafely(val).match(URN_REGEX);
        if (match) return match[0];
      }
    }

    const attrNodes = card.querySelectorAll('[data-urn], [data-id], [data-chameleon-result-urn]');
    for (const node of attrNodes) {
      for (const attr of directAttrs) {
        const val = node.getAttribute(attr);
        if (val) {
          const match = decodeSafely(val).match(URN_REGEX);
          if (match) return match[0];
        }
      }
    }

    const links = card.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href) {
        const match = decodeSafely(href).match(URN_REGEX);
        if (match) return match[0];
      }
    }

    return null;
  }

  function findSavedPostCards() {
    const candidates = new Set();
    const primarySelectors = [
      'main ul > li',
      '.reusable-search__entity-result-list > li',
      '[data-chameleon-result-urn]',
      '.reusable-search__result-container'
    ];

    for (const selector of primarySelectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (extractCardUrn(node)) {
          candidates.add(node);
        }
      }
    }

    return Array.from(candidates);
  }

  function findOverflowButton(card) {
    const ariaSelectors = [
      'button[aria-label*="Open control menu" i]',
      'button[aria-label*="More actions" i]',
      'button[aria-label*="Más acciones" i]',
      'button[aria-label*="Abrir el menú" i]',
      'button.artdeco-dropdown__trigger'
    ];

    for (const selector of ariaSelectors) {
      const btn = card.querySelector(selector);
      if (btn) return btn;
    }

    const buttons = card.querySelectorAll('button');
    for (const btn of buttons) {
      const hasOverflowIcon = Boolean(
        btn.querySelector('svg[data-test-icon*="overflow"], li-icon[type*="ellipsis"]')
      );
      const text = (btn.textContent || '').trim();
      if (hasOverflowIcon || text === '...' || text === '…') {
        return btn;
      }
    }

    return null;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVisibleUnsaveItem(card) {
    const menuContainers = [
      ...card.querySelectorAll('.artdeco-dropdown__content--is-open, [role="menu"]'),
      ...document.querySelectorAll('body > div .artdeco-dropdown__content--is-open, [role="menu"]')
    ];

    const seenContainers = new Set();
    for (const container of menuContainers) {
      if (seenContainers.has(container) || !isElementVisible(container)) continue;
      seenContainers.add(container);

      const items = container.querySelectorAll('[role="menuitem"], .artdeco-dropdown__item, button, li, a');
      for (const item of items) {
        const text = (item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text) continue;
        if (UNSAVE_LABELS.some((label) => text === label || text.startsWith(`${label} `))) {
          return item;
        }
      }
    }

    return null;
  }

  function waitForUnsaveMenuItem(card, timeoutMs = MENU_TIMEOUT_MS) {
    const immediate = findVisibleUnsaveItem(card);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;

      const finish = (item) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(item);
      };

      const observer = new MutationObserver(() => {
        const item = findVisibleUnsaveItem(card);
        if (item) {
          finish(item);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-expanded', 'style', 'hidden']
      });

      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  async function appendUnsavedUrn(urn) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.UNSAVED_URNS);
    const existing = Array.isArray(data[STORAGE_KEYS.UNSAVED_URNS]) ? data[STORAGE_KEYS.UNSAVED_URNS] : [];
    if (!existing.includes(urn)) {
      existing.push(urn);
      await chrome.storage.local.set({ [STORAGE_KEYS.UNSAVED_URNS]: existing });
    }
  }

  function highlightCardDryRun(card) {
    card.style.outline = '3px solid #16a34a';
    card.style.outlineOffset = '-3px';
    card.style.borderRadius = '6px';
  }

  async function runUnsaveAutomation(config) {
    if (state.status === 'running') {
      log('Automation is already running.');
      return;
    }

    const maxPosts = Math.max(1, Number(config?.maxPosts) || 25);
    const minDelayMs = Number(config?.minDelayMs) || 2500;
    const maxDelayMs = Number(config?.maxDelayMs) || 4500;
    const dryRun = Boolean(config?.dryRun);

    state.shouldStop = false;
    state.stats = { scanned: 0, matched: 0, unsaved: 0, skipped: 0 };

    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.TARGET_URNS,
      STORAGE_KEYS.UNSAVED_URNS
    ]);

    const targetSet = new Set(
      Array.isArray(stored[STORAGE_KEYS.TARGET_URNS]) ? stored[STORAGE_KEYS.TARGET_URNS] : []
    );
    const unsavedSet = new Set(
      Array.isArray(stored[STORAGE_KEYS.UNSAVED_URNS]) ? stored[STORAGE_KEYS.UNSAVED_URNS] : []
    );

    if (targetSet.size === 0) {
      emitProgress('error', 'No target URNs loaded in storage.');
      return;
    }

    emitProgress(
      'running',
      dryRun ? 'Dry Run active: scanning saved posts...' : 'Live mode active: scanning saved posts...'
    );
    log(`Started (${dryRun ? 'Dry Run' : 'Live'}), maxPosts=${maxPosts}, targets=${targetSet.size}`);

    const processedCards = new WeakSet();
    const processedUrns = new Set();
    let emptyScrollAttempts = 0;

    while (!state.shouldStop) {
      const cards = findSavedPostCards();
      const newCards = cards.filter((card) => !processedCards.has(card));

      if (newCards.length === 0) {
        emptyScrollAttempts += 1;
        if (emptyScrollAttempts > MAX_EMPTY_SCROLL_ATTEMPTS) {
          emitProgress('completed', 'Finished: no more saved posts loaded.');
          log('Stopping: no new cards loaded after 3 scroll attempts.');
          break;
        }

        emitProgress(
          'running',
          `Scrolling for more posts (attempt ${emptyScrollAttempts}/${MAX_EMPTY_SCROLL_ATTEMPTS})...`
        );
        window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: 'smooth' });
        await sleepInterruptible(SCROLL_WAIT_MS);
        continue;
      }

      emptyScrollAttempts = 0;

      for (const card of newCards) {
        if (state.shouldStop) break;

        processedCards.add(card);
        state.stats.scanned += 1;

        const urn = extractCardUrn(card);
        if (!urn || processedUrns.has(urn)) {
          state.stats.skipped += 1;
          emitProgress('running');
          continue;
        }
        processedUrns.add(urn);

        if (!targetSet.has(urn) || unsavedSet.has(urn)) {
          state.stats.skipped += 1;
          emitProgress('running');
          continue;
        }

        state.stats.matched += 1;

        if (dryRun) {
          highlightCardDryRun(card);
          log(`[Dry Run] Matched ${urn}`);
          emitProgress('running', `[Dry Run] Highlighted ${urn}`);

          if (state.stats.matched >= maxPosts) {
            emitProgress('completed', `Dry Run reached max posts (${maxPosts}).`);
            log(`Dry Run reached maxPosts (${maxPosts}).`);
            return;
          }
          continue;
        }

        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleepInterruptible(300);
        if (state.shouldStop) break;

        const overflowBtn = findOverflowButton(card);
        if (!overflowBtn) {
          log(`Overflow button not found for ${urn}; skipping.`);
          state.stats.skipped += 1;
          emitProgress('running', `Skipped ${urn} (menu button not found).`);
          continue;
        }

        overflowBtn.click();
        const unsaveItem = await waitForUnsaveMenuItem(card, MENU_TIMEOUT_MS);
        if (!unsaveItem) {
          log(`Unsave menu item did not appear for ${urn}; skipping.`);
          state.stats.skipped += 1;
          emitProgress('running', `Skipped ${urn} (Unsave item not found).`);
          continue;
        }

        unsaveItem.click();
        unsavedSet.add(urn);
        await appendUnsavedUrn(urn);
        state.stats.unsaved += 1;
        log(`Unsaved ${urn} (${state.stats.unsaved}/${maxPosts})`);
        emitProgress('running', `Unsaved ${urn} (${state.stats.unsaved}/${maxPosts})`);

        if (state.stats.unsaved >= maxPosts) {
          emitProgress('completed', `Completed: reached max posts per run (${maxPosts}).`);
          log(`Reached maxPosts (${maxPosts}).`);
          return;
        }

        const delayMs = randomDelayMs(minDelayMs, maxDelayMs);
        await sleepInterruptible(delayMs);
      }

      if (state.shouldStop) break;

      window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: 'smooth' });
      await sleepInterruptible(SCROLL_WAIT_MS);
    }

    if (state.shouldStop) {
      emitProgress('stopped', 'Stopped by user.');
      log('Automation stopped by user.');
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_STATUS') {
      sendResponse({
        status: state.status,
        message: state.message,
        stats: { ...state.stats }
      });
      return false;
    }

    if (message?.type === 'START_UNSAVE') {
      runUnsaveAutomation(message.config);
      sendResponse({ started: true });
      return false;
    }

    if (message?.type === 'STOP_UNSAVE') {
      state.shouldStop = true;
      sendResponse({ stopping: true });
      return false;
    }

    return false;
  });
})();
