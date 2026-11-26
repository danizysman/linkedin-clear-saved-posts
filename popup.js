const STORAGE_KEYS = {
  TARGET_URNS: 'targetUrns',
  UNSAVED_URNS: 'unsavedUrns',
  EXPORTED_POSTS: 'exportedPosts',
  SETTINGS: 'settings',
  ACTIVE_TAB: 'activeTab'
};

const DEFAULT_SETTINGS = {
  maxPosts: 25,
  minDelay: 0.8,
  maxDelay: 1.5,
  dryRun: false,
  settingsVersion: 2
};

const elements = {
  tabExportBtn: document.getElementById('tabExportBtn'),
  tabUnsaveBtn: document.getElementById('tabUnsaveBtn'),
  exportPanel: document.getElementById('exportPanel'),
  unsavePanel: document.getElementById('unsavePanel'),
  exportBtn: document.getElementById('exportBtn'),
  exportStopBtn: document.getElementById('exportStopBtn'),
  downloadJsonBtn: document.getElementById('downloadJsonBtn'),
  useExportedBtn: document.getElementById('useExportedBtn'),
  exportedCount: document.getElementById('exportedCount'),
  jsonFiles: document.getElementById('jsonFiles'),
  targetCount: document.getElementById('targetCount'),
  historyCount: document.getElementById('historyCount'),
  remainingCount: document.getElementById('remainingCount'),
  maxPosts: document.getElementById('maxPosts'),
  minDelay: document.getElementById('minDelay'),
  maxDelay: document.getElementById('maxDelay'),
  dryRun: document.getElementById('dryRun'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  clearWarning: document.getElementById('clearWarning'),
  confirmClearBtn: document.getElementById('confirmClearBtn'),
  cancelClearBtn: document.getElementById('cancelClearBtn'),
  scannedCount: document.getElementById('scannedCount'),
  matchedCount: document.getElementById('matchedCount'),
  unsavedCount: document.getElementById('unsavedCount'),
  skippedCount: document.getElementById('skippedCount'),
  statusBadge: document.getElementById('statusBadge'),
  statusMessage: document.getElementById('statusMessage')
};

let isRunningState = false;
let hasExportedPosts = false;

function switchTab(tabName) {
  const isExport = tabName !== 'unsave';
  elements.tabExportBtn.classList.toggle('active', isExport);
  elements.tabUnsaveBtn.classList.toggle('active', !isExport);
  elements.tabExportBtn.setAttribute('aria-selected', String(isExport));
  elements.tabUnsaveBtn.setAttribute('aria-selected', String(!isExport));
  elements.exportPanel.hidden = !isExport;
  elements.unsavePanel.hidden = isExport;
  chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_TAB]: isExport ? 'export' : 'unsave' });
}

function extractPostUrns(node, found = new Set()) {
  if (!node) return found;

  if (Array.isArray(node)) {
    for (const item of node) {
      extractPostUrns(item, found);
    }
    return found;
  }

  if (typeof node === 'object') {
    if (typeof node.post_urn === 'string' && node.post_urn.trim()) {
      found.add(node.post_urn.trim());
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        extractPostUrns(value, found);
      }
    }
  }

  return found;
}

function setStatusBadge(status) {
  const normalized = (status || 'idle').toLowerCase();
  elements.statusBadge.className = 'badge';
  switch (normalized) {
    case 'running':
      elements.statusBadge.classList.add('badge-running');
      elements.statusBadge.textContent = 'Running';
      break;
    case 'completed':
      elements.statusBadge.classList.add('badge-completed');
      elements.statusBadge.textContent = 'Completed';
      break;
    case 'stopped':
      elements.statusBadge.classList.add('badge-stopped');
      elements.statusBadge.textContent = 'Stopped';
      break;
    case 'error':
      elements.statusBadge.classList.add('badge-error');
      elements.statusBadge.textContent = 'Error';
      break;
    default:
      elements.statusBadge.classList.add('badge-idle');
      elements.statusBadge.textContent = 'Idle';
  }
}

function syncButtonStates() {
  elements.exportBtn.disabled = isRunningState;
  elements.exportStopBtn.disabled = !isRunningState;
  elements.startBtn.disabled = isRunningState;
  elements.stopBtn.disabled = !isRunningState;
  elements.jsonFiles.disabled = isRunningState;
  elements.clearHistoryBtn.disabled = isRunningState;
  elements.downloadJsonBtn.disabled = isRunningState || !hasExportedPosts;
  elements.useExportedBtn.disabled = isRunningState || !hasExportedPosts;
}

function setRunningState(isRunning) {
  isRunningState = Boolean(isRunning);
  syncButtonStates();
}

function updateProgressUI(stats = {}, status, message) {
  elements.scannedCount.textContent = String(stats.scanned ?? 0);
  elements.matchedCount.textContent = String(stats.matched ?? 0);
  elements.unsavedCount.textContent = String(stats.unsaved ?? 0);
  elements.skippedCount.textContent = String(stats.skipped ?? 0);

  if (typeof stats.exported === 'number' && stats.exported > 0) {
    elements.exportedCount.textContent = String(stats.exported);
    hasExportedPosts = true;
  }

  if (status) {
    setStatusBadge(status);
    setRunningState(status === 'running');
  } else {
    syncButtonStates();
  }

  if (message) {
    elements.statusMessage.textContent = message;
  }
}

async function refreshCounts() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TARGET_URNS,
    STORAGE_KEYS.UNSAVED_URNS,
    STORAGE_KEYS.EXPORTED_POSTS
  ]);

  const targetUrns = Array.isArray(data[STORAGE_KEYS.TARGET_URNS]) ? data[STORAGE_KEYS.TARGET_URNS] : [];
  const unsavedUrns = Array.isArray(data[STORAGE_KEYS.UNSAVED_URNS]) ? data[STORAGE_KEYS.UNSAVED_URNS] : [];
  const exportedPosts = Array.isArray(data[STORAGE_KEYS.EXPORTED_POSTS]) ? data[STORAGE_KEYS.EXPORTED_POSTS] : [];

  const unsavedSet = new Set(unsavedUrns);
  const remaining = targetUrns.filter((urn) => !unsavedSet.has(urn)).length;

  elements.targetCount.textContent = String(targetUrns.length);
  elements.historyCount.textContent = String(unsavedUrns.length);
  elements.remainingCount.textContent = String(remaining);
  elements.exportedCount.textContent = String(exportedPosts.length);

  hasExportedPosts = exportedPosts.length > 0;
  syncButtonStates();
}

async function loadSettings() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.ACTIVE_TAB]);
  const stored = data[STORAGE_KEYS.SETTINGS] || {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  if ((stored.settingsVersion ?? 1) < DEFAULT_SETTINGS.settingsVersion) {
    if (stored.minDelay === 2.5 && stored.maxDelay === 4.5) {
      settings.minDelay = DEFAULT_SETTINGS.minDelay;
      settings.maxDelay = DEFAULT_SETTINGS.maxDelay;
    }
    settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  }

  elements.maxPosts.value = String(settings.maxPosts);
  elements.minDelay.value = String(settings.minDelay);
  elements.maxDelay.value = String(settings.maxDelay);
  elements.dryRun.checked = Boolean(settings.dryRun);

  if (data[STORAGE_KEYS.ACTIVE_TAB]) {
    switchTab(data[STORAGE_KEYS.ACTIVE_TAB]);
  }
}

function readSettingsFromUI() {
  const maxPosts = Math.max(1, parseInt(elements.maxPosts.value, 10) || DEFAULT_SETTINGS.maxPosts);
  let minDelay = parseFloat(elements.minDelay.value);
  let maxDelay = parseFloat(elements.maxDelay.value);

  if (Number.isNaN(minDelay) || minDelay < 0.2) minDelay = DEFAULT_SETTINGS.minDelay;
  if (Number.isNaN(maxDelay) || maxDelay < minDelay) maxDelay = Math.max(minDelay, DEFAULT_SETTINGS.maxDelay);

  const settings = {
    maxPosts,
    minDelay,
    maxDelay,
    dryRun: elements.dryRun.checked,
    settingsVersion: DEFAULT_SETTINGS.settingsVersion
  };

  elements.maxPosts.value = String(settings.maxPosts);
  elements.minDelay.value = String(settings.minDelay);
  elements.maxDelay.value = String(settings.maxDelay);

  return settings;
}

async function saveSettings() {
  const settings = readSettingsFromUI();
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

async function handleFileSelection(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  const urnSet = new Set();
  let parsedFiles = 0;

  for (const file of files) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      extractPostUrns(json, urnSet);
      parsedFiles += 1;
    } catch (err) {
      setStatusBadge('error');
      elements.statusMessage.textContent = `Failed to parse "${file.name}": ${err.message}`;
      return;
    }
  }

  const targetUrns = Array.from(urnSet);
  await chrome.storage.local.set({ [STORAGE_KEYS.TARGET_URNS]: targetUrns });
  await refreshCounts();

  setStatusBadge('idle');
  elements.statusMessage.textContent = `Loaded ${targetUrns.length} unique post URN(s) from ${parsedFiles} file(s).`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function syncWithContentScript() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
    if (response) {
      if (response.status === 'running' && response.mode) {
        switchTab(response.mode === 'export' ? 'export' : 'unsave');
      }
      updateProgressUI(response.stats, response.status, response.message);
    }
  } catch {
    // Content script is not active on the current tab; keep default idle UI.
  }
}

async function handleExport() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatusBadge('error');
    elements.statusMessage.textContent = 'No active browser tab found.';
    return;
  }

  try {
    setRunningState(true);
    setStatusBadge('running');
    elements.statusMessage.textContent = 'Scraping saved posts on active tab...';

    await chrome.tabs.sendMessage(tab.id, {
      type: 'START_EXPORT',
      config: { maxPosts: 0 }
    });
  } catch {
    setRunningState(false);
    setStatusBadge('error');
    elements.statusMessage.textContent =
      'Open https://www.linkedin.com/my-items/saved-posts/ and refresh the tab.';
  }
}

async function handleDownloadJson() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.EXPORTED_POSTS);
  const exportedPosts = Array.isArray(data[STORAGE_KEYS.EXPORTED_POSTS]) ? data[STORAGE_KEYS.EXPORTED_POSTS] : [];
  if (exportedPosts.length === 0) {
    elements.statusMessage.textContent = 'No exported posts available to download.';
    return;
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(exportedPosts, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `linkedin-saved-posts-${dateStamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  elements.statusMessage.textContent = `Downloaded ${exportedPosts.length} post(s) as JSON.`;
}

async function handleUseExportedAsTargets() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.EXPORTED_POSTS);
  const exportedPosts = Array.isArray(data[STORAGE_KEYS.EXPORTED_POSTS]) ? data[STORAGE_KEYS.EXPORTED_POSTS] : [];
  const urns = Array.from(extractPostUrns(exportedPosts));

  if (urns.length === 0) {
    elements.statusMessage.textContent = 'No post URNs found in exported posts.';
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.TARGET_URNS]: urns });
  await refreshCounts();
  switchTab('unsave');
  setStatusBadge('idle');
  elements.statusMessage.textContent = `Loaded ${urns.length} exported URN(s) as unsave targets.`;
}

async function handleStart() {
  const settings = await saveSettings();
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TARGET_URNS,
    STORAGE_KEYS.UNSAVED_URNS
  ]);

  const targetUrns = Array.isArray(data[STORAGE_KEYS.TARGET_URNS]) ? data[STORAGE_KEYS.TARGET_URNS] : [];
  if (targetUrns.length === 0) {
    setStatusBadge('error');
    elements.statusMessage.textContent = 'Load a JSON file or scrape posts and click "Send to Unsave" first.';
    return;
  }

  const unsavedSet = new Set(Array.isArray(data[STORAGE_KEYS.UNSAVED_URNS]) ? data[STORAGE_KEYS.UNSAVED_URNS] : []);
  const remaining = targetUrns.filter((urn) => !unsavedSet.has(urn)).length;
  if (remaining === 0) {
    setStatusBadge('completed');
    elements.statusMessage.textContent = 'All loaded target URNs are already in your unsaved history.';
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatusBadge('error');
    elements.statusMessage.textContent = 'No active browser tab found.';
    return;
  }

  try {
    setRunningState(true);
    setStatusBadge('running');
    elements.statusMessage.textContent = settings.dryRun
      ? 'Starting Dry Run on active LinkedIn Saved Posts tab...'
      : 'Starting Live Unsave on active LinkedIn Saved Posts tab...';

    await chrome.tabs.sendMessage(tab.id, {
      type: 'START_UNSAVE',
      config: {
        maxPosts: settings.maxPosts,
        minDelayMs: Math.round(settings.minDelay * 1000),
        maxDelayMs: Math.round(settings.maxDelay * 1000),
        dryRun: settings.dryRun
      }
    });
  } catch {
    setRunningState(false);
    setStatusBadge('error');
    elements.statusMessage.textContent =
      'Open https://www.linkedin.com/my-items/saved-posts/ and refresh the tab.';
  }
}

async function handleStop() {
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTOMATION' });
      elements.statusMessage.textContent = 'Stopping after current step...';
    }
  } catch {
    setRunningState(false);
    setStatusBadge('stopped');
  }
}

function handleClearHistory() {
  elements.clearWarning.hidden = false;
}

function handleCancelClear() {
  elements.clearWarning.hidden = true;
}

async function handleConfirmClear() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.UNSAVED_URNS]: [],
    [STORAGE_KEYS.TARGET_URNS]: [],
    [STORAGE_KEYS.EXPORTED_POSTS]: [],
    [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS }
  });
  elements.jsonFiles.value = '';
  elements.clearWarning.hidden = true;
  await Promise.all([loadSettings(), refreshCounts()]);
  updateProgressUI(
    { scanned: 0, matched: 0, unsaved: 0, skipped: 0, exported: 0 },
    'idle',
    'Cleared all exported posts, target URNs, and unsaved history.'
  );
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'PROGRESS') {
    updateProgressUI(message.stats, message.status, message.message);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (
    changes[STORAGE_KEYS.TARGET_URNS] ||
    changes[STORAGE_KEYS.UNSAVED_URNS] ||
    changes[STORAGE_KEYS.EXPORTED_POSTS]
  ) {
    refreshCounts();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadSettings(), refreshCounts()]);
  await syncWithContentScript();

  elements.tabExportBtn.addEventListener('click', () => switchTab('export'));
  elements.tabUnsaveBtn.addEventListener('click', () => switchTab('unsave'));
  elements.exportBtn.addEventListener('click', handleExport);
  elements.exportStopBtn.addEventListener('click', handleStop);
  elements.downloadJsonBtn.addEventListener('click', handleDownloadJson);
  elements.useExportedBtn.addEventListener('click', handleUseExportedAsTargets);
  elements.jsonFiles.addEventListener('change', handleFileSelection);
  elements.maxPosts.addEventListener('change', saveSettings);
  elements.minDelay.addEventListener('change', saveSettings);
  elements.maxDelay.addEventListener('change', saveSettings);
  elements.dryRun.addEventListener('change', saveSettings);
  elements.startBtn.addEventListener('click', handleStart);
  elements.stopBtn.addEventListener('click', handleStop);
  elements.clearHistoryBtn.addEventListener('click', handleClearHistory);
  elements.confirmClearBtn.addEventListener('click', handleConfirmClear);
  elements.cancelClearBtn.addEventListener('click', handleCancelClear);
});
