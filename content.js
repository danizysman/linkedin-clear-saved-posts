(() => {
  const STORAGE_KEYS = {
    TARGET_URNS: 'targetUrns',
    UNSAVED_URNS: 'unsavedUrns',
    EXPORTED_POSTS: 'exportedPosts'
  };

  const URN_REGEX = /urn:li:(?:activity|ugcPost):\d+/;
  const UNSAVE_LABELS = ['unsave', 'dejar de guardar'];
  const MAX_EMPTY_SCROLL_ATTEMPTS = 5;
  const SCROLL_WAIT_MS = 3500;
  const MENU_TIMEOUT_MS = 4000;

  const state = {
    status: 'idle',
    mode: null,
    shouldStop: false,
    message: 'Idle',
    stats: {
      scanned: 0,
      matched: 0,
      unsaved: 0,
      skipped: 0,
      exported: 0
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
          mode: state.mode,
          status: state.status,
          message: state.message,
          stats: { ...state.stats }
        },
        () => {
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

  function extractDateFromActivityUrn(urn) {
    const match = urn.match(/urn:li:activity:(\d+)/);
    if (!match) return null;
    try {
      const ms = Number(BigInt(match[1]) >> 22n);
      const date = new Date(ms);
      if (Number.isNaN(date.getTime()) || date.getFullYear() < 2015 || date.getFullYear() > 2100) {
        return null;
      }
      return date.toISOString();
    } catch {
      return null;
    }
  }

  function extractCardData(card, urn) {
    let postUrl = `https://www.linkedin.com/feed/update/${urn}/`;
    const postLinks = card.querySelectorAll('a[href]');
    for (const link of postLinks) {
      const href = link.getAttribute('href') || '';
      if (decodeSafely(href).includes(urn) || href.includes('/feed/update/') || href.includes('/posts/')) {
        postUrl = link.href;
        break;
      }
    }

    const authorLinks = Array.from(card.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'));
    const authorLink = authorLinks[0] || null;
    const authorProfileUrl = authorLink ? authorLink.href : null;
    const isCompanyPost = Boolean(authorProfileUrl && authorProfileUrl.includes('/company/'));

    const avatarImg =
      card.querySelector('img.presence-entity__image, .entity-result__content-image img') ||
      authorLink?.querySelector('img') ||
      null;
    const authorProfileImageUrl = avatarImg?.src || null;

    const ignoredNamePattern = /^(?:status is\b|view\b|ver\b)/i;
    let authorName = null;
    for (const link of authorLinks) {
      const candidates = [
        ...link.querySelectorAll('span[aria-hidden="true"]'),
        link
      ];
      for (const node of candidates) {
        const raw = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!raw || ignoredNamePattern.test(raw) || /^\d+(?:st|nd|rd|th|\.?º)$/i.test(raw)) {
          continue;
        }
        authorName = raw;
        break;
      }
      if (authorName) break;
    }
    if (!authorName && avatarImg?.alt) {
      const altText = avatarImg.alt.trim();
      if (altText && !ignoredNamePattern.test(altText)) {
        authorName = altText;
      }
    }

    const timeTokenPattern = /^\d+\s*(?:s|m|h|d|w|mo|yr|sem|mes)\s*•?$/i;
    const headlineEl = card.querySelector(
      '.entity-result__primary-subtitle, .entity-result__content-actor .t-12.t-black--light'
    );
    const rawHeadline = headlineEl?.textContent?.replace(/\s+/g, ' ').trim() || null;
    const authorHeadline = rawHeadline && !timeTokenPattern.test(rawHeadline) ? rawHeadline : null;

    let connectionDegree = null;
    const badgeEl = card.querySelector('.entity-result__badge-text, .distance-and-badge');
    if (badgeEl?.textContent) {
      const match = badgeEl.textContent.match(/\b(1st|2nd|3rd\+?|[123]\.º)\b/i);
      if (match) connectionDegree = match[1];
    }

    let postText = '';
    const textSelectors = [
      '.entity-result__content-summary',
      'p.entity-result__summary',
      '[class*="entity-result__summary"]',
      '.feed-shared-update-v2__description',
      '.update-components-text',
      '.entity-result__content-container p',
      '.entity-result__content-container span[dir="ltr"]'
    ];
    for (const selector of textSelectors) {
      const candidates = card.querySelectorAll(selector);
      for (const el of candidates) {
        if (el.closest('.entity-result__content-actor')) continue;
        const cleaned = (el.textContent || '')
          .replace(/\s+/g, ' ')
          .replace(/\s*…?\s*(?:see more|ver más)\s*$/i, '')
          .trim();
        if (
          !cleaned ||
          timeTokenPattern.test(cleaned) ||
          cleaned === authorName ||
          /^(?:1st|2nd|3rd\+?|[123]\.º)$/i.test(cleaned)
        ) {
          continue;
        }
        postText = cleaned;
        break;
      }
      if (postText) break;
    }

    const mediaImgs = Array.from(card.querySelectorAll('img')).filter((img) => {
      if (img === avatarImg) return false;
      if (img.classList.contains('presence-entity__image')) return false;
      if (img.closest('.entity-result__content-image')) return false;
      return Boolean(img.src);
    });
    const postImageEl =
      card.querySelector(
        '.entity-result__embedded-object-image img, .feed-shared-image__image, .update-components-image__image'
      ) ||
      mediaImgs[0] ||
      null;

    const postImageUrl = postImageEl?.src || null;
    const postImageAlt = postImageEl?.alt?.trim() || null;
    const hasImage = Boolean(postImageUrl);
    const hasVideo = Boolean(
      card.querySelector('video, .video-s-loader, [data-test-id*="video" i], [aria-label*="video" i]')
    );

    let postedTime = null;
    const timeCandidates = card.querySelectorAll(
      'time, .entity-result__content-subtext, .entity-result__content-actor .t-12.t-black--light, .entity-result__primary-subtitle'
    );
    for (const el of timeCandidates) {
      const text = el.textContent?.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const match = text.match(/\b(\d+\s*(?:s|m|h|d|w|mo|yr|sem|mes))\b/i);
      if (match) {
        postedTime = match[1];
        break;
      }
    }

    return {
      author_headline: authorHeadline,
      author_name: authorName,
      author_profile_image_url: authorProfileImageUrl,
      author_profile_url: authorProfileUrl,
      connection_degree: connectionDegree,
      has_image: hasImage,
      has_video: hasVideo,
      is_company_post: isCompanyPost,
      post_image_alt: postImageAlt,
      post_image_url: postImageUrl,
      post_text: postText,
      post_url: postUrl,
      post_urn: urn,
      posted_date: extractDateFromActivityUrn(urn),
      posted_time: postedTime
    };
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

  function findShowMoreButton() {
    const specificBtn = document.querySelector('button.scaffold-finite-scroll__load-button');
    if (specificBtn && isElementVisible(specificBtn) && !specificBtn.disabled) {
      return specificBtn;
    }

    const buttons = document.querySelectorAll('main button');
    for (const btn of buttons) {
      if (!isElementVisible(btn) || btn.disabled) continue;
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (/^(?:show more results|show more|load more|mostrar más resultados|ver más)$/.test(text)) {
        return btn;
      }
    }

    return null;
  }

  function isFeedLoading() {
    const spinner = document.querySelector(
      'main .artdeco-loader, main .scaffold-finite-scroll__spinner, main [role="progressbar"]'
    );
    return isElementVisible(spinner);
  }

  async function loadMoreSavedPosts(processedCards, attempt = 1) {
    const showMoreBtn = findShowMoreButton();
    if (showMoreBtn) {
      showMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleepInterruptible(200);
      if (state.shouldStop) return false;
      showMoreBtn.click();
      log('Clicked "Show more results" button.');
    } else {
      if (attempt >= 2) {
        window.scrollBy({ top: -300, behavior: 'instant' });
        await sleepInterruptible(150);
      }
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    }

    const step = 250;
    let elapsed = 0;
    const maxWait = isFeedLoading() ? SCROLL_WAIT_MS + 2000 : SCROLL_WAIT_MS;

    while (elapsed < maxWait && !state.shouldStop) {
      await sleepInterruptible(step);
      elapsed += step;

      const hasNew = findSavedPostCards().some((card) => !processedCards.has(card));
      if (hasNew) return true;

      if (elapsed >= SCROLL_WAIT_MS && !isFeedLoading()) {
        break;
      }
    }

    return findSavedPostCards().some((card) => !processedCards.has(card));
  }

  async function runExportAutomation(config) {
    if (state.status === 'running') {
      log('Automation is already running.');
      return;
    }

    const maxPosts = Math.max(0, Number(config?.maxPosts) || 0);
    state.mode = 'export';
    state.shouldStop = false;
    state.stats = { scanned: 0, matched: 0, unsaved: 0, skipped: 0, exported: 0 };

    emitProgress('running', 'Exporting saved posts from page...');
    log(`Started Export, maxPosts=${maxPosts || 'unlimited'}`);

    const processedCards = new WeakSet();
    const seenUrns = new Set();
    const exportedPosts = [];
    let emptyScrollAttempts = 0;

    while (!state.shouldStop) {
      const cards = findSavedPostCards();
      const newCards = cards.filter((card) => !processedCards.has(card));

      if (newCards.length === 0) {
        emptyScrollAttempts += 1;
        if (emptyScrollAttempts > MAX_EMPTY_SCROLL_ATTEMPTS) {
          await chrome.storage.local.set({ [STORAGE_KEYS.EXPORTED_POSTS]: exportedPosts });
          emitProgress('completed', `Export finished: ${exportedPosts.length} post(s) collected.`);
          log(`Export finished: ${exportedPosts.length} post(s) collected.`);
          return;
        }

        emitProgress(
          'running',
          `Loading more posts (${exportedPosts.length} exported, attempt ${emptyScrollAttempts}/${MAX_EMPTY_SCROLL_ATTEMPTS})...`
        );
        await loadMoreSavedPosts(processedCards, emptyScrollAttempts);
        continue;
      }

      emptyScrollAttempts = 0;

      for (const card of newCards) {
        if (state.shouldStop) break;

        processedCards.add(card);
        state.stats.scanned += 1;

        const urn = extractCardUrn(card);
        if (!urn || seenUrns.has(urn)) {
          state.stats.skipped += 1;
          emitProgress('running');
          continue;
        }

        seenUrns.add(urn);
        exportedPosts.push(extractCardData(card, urn));
        state.stats.exported = exportedPosts.length;
        emitProgress('running', `Exported ${exportedPosts.length} post(s)...`);

        if (maxPosts > 0 && exportedPosts.length >= maxPosts) {
          await chrome.storage.local.set({ [STORAGE_KEYS.EXPORTED_POSTS]: exportedPosts });
          emitProgress('completed', `Export reached max posts (${maxPosts}).`);
          log(`Export reached maxPosts (${maxPosts}).`);
          return;
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.EXPORTED_POSTS]: exportedPosts });
      if (state.shouldStop) break;

      await loadMoreSavedPosts(processedCards, 1);
    }

    if (state.shouldStop) {
      await chrome.storage.local.set({ [STORAGE_KEYS.EXPORTED_POSTS]: exportedPosts });
      emitProgress('stopped', `Export stopped (${exportedPosts.length} post(s) saved).`);
      log(`Export stopped by user (${exportedPosts.length} post(s) saved).`);
    }
  }

  async function runUnsaveAutomation(config) {
    if (state.status === 'running') {
      log('Automation is already running.');
      return;
    }

    const maxPosts = Math.max(1, Number(config?.maxPosts) || 25);
    const minDelayMs = Number(config?.minDelayMs) || 800;
    const maxDelayMs = Number(config?.maxDelayMs) || 1500;
    const dryRun = Boolean(config?.dryRun);

    state.mode = 'unsave';
    state.shouldStop = false;
    state.stats = { scanned: 0, matched: 0, unsaved: 0, skipped: 0, exported: 0 };

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
          log(`Stopping: no new cards loaded after ${MAX_EMPTY_SCROLL_ATTEMPTS} attempts.`);
          break;
        }

        emitProgress(
          'running',
          `Loading more posts (attempt ${emptyScrollAttempts}/${MAX_EMPTY_SCROLL_ATTEMPTS})...`
        );
        await loadMoreSavedPosts(processedCards, emptyScrollAttempts);
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

      await loadMoreSavedPosts(processedCards, 1);
    }

    if (state.shouldStop) {
      emitProgress('stopped', 'Stopped by user.');
      log('Automation stopped by user.');
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_STATUS') {
      sendResponse({
        mode: state.mode,
        status: state.status,
        message: state.message,
        stats: { ...state.stats }
      });
      return false;
    }

    if (message?.type === 'START_EXPORT') {
      runExportAutomation(message.config);
      sendResponse({ started: true });
      return false;
    }

    if (message?.type === 'START_UNSAVE') {
      runUnsaveAutomation(message.config);
      sendResponse({ started: true });
      return false;
    }

    if (message?.type === 'STOP_UNSAVE' || message?.type === 'STOP_AUTOMATION') {
      state.shouldStop = true;
      sendResponse({ stopping: true });
      return false;
    }

    return false;
  });
})();
