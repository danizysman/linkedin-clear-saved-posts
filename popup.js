const STORAGE_KEYS = {
  TARGET_URNS: 'targetUrns',
  UNSAVED_URNS: 'unsavedUrns',
  SETTINGS: 'settings'
};

const DEFAULT_SETTINGS = {
  maxPosts: 25,
  minDelay: 2.5,
  maxDelay: 4.5,
  dryRun: false
};

const elements = {
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
  scannedCount: document.getElementById('scannedCount'),
  matchedCount: document.getElementById('matchedCount'),
  unsavedCount: document.getElementById('unsavedCount'),
  skippedCount: document.getElementById('skippedCount'),
  statusBadge: document.getElementById('statusBadge'),
  statusMessage: document.getElementById('statusMessage')
};

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

function setRunningState(isRunning) {
  elements.startBtn.disabled = isRunning;
  elements.stopBtn.disabled = !isRunning;
  elements.jsonFiles.disabled = isRunning;
  elements.clearHistoryBtn.disabled = isRunning;
}

function updateProgressUI(stats = {}, status, message) {
  elements.scannedCount.textContent = String(stats.scanned ?? 0);
  elements.matchedCount.textContent = String(stats.matched ?? 0);
  elements.unsavedCount.textContent = String(stats.unsaved ?? 0);
  elements.skippedCount.textContent = String(stats.skipped ?? 0);

  if (status) {
    setStatusBadge(status);
    setRunningState(status === 'running');
  }
  if (message) {
    elements.statusMessage.textContent = message;
  }
}

async function refreshCounts() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TARGET_URNS,
    STORAGE_KEYS.UNSAVED_URNS
  ]);

  const targetUrns = Array.isArray(data[STORAGE_KEYS.TARGET_URNS]) ? data[STORAGE_KEYS.TARGET_URNS] : [];
  const unsavedUrns = Array.isArray(data[STORAGE_KEYS.UNSAVED_URNS]) ? data[STORAGE_KEYS.UNSAVED_URNS] : [];

  const unsavedSet = new Set(unsavedUrns);
  const remaining = targetUrns.filter((urn) => !unsavedSet.has(urn)).length;

  elements.targetCount.textContent = String(targetUrns.length);
  elements.historyCount.textContent = String(unsavedUrns.length);
  elements.remainingCount.textContent = String(remaining);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };

  elements.maxPosts.value = String(settings.maxPosts);
  elements.minDelay.value = String(settings.minDelay);
  elements.maxDelay.value = String(settings.maxDelay);
  elements.dryRun.checked = Boolean(settings.dryRun);
}

function readSettingsFromUI() {
  const maxPosts = Math.max(1, parseInt(elements.maxPosts.value, 10) || DEFAULT_SETTINGS.maxPosts);
  let minDelay = parseFloat(elements.minDelay.value);
  let maxDelay = parseFloat(elements.maxDelay.value);

  if (Number.isNaN(minDelay) || minDelay < 0.5) minDelay = DEFAULT_SETTINGS.minDelay;
  if (Number.isNaN(maxDelay) || maxDelay < minDelay) maxDelay = Math.max(minDelay, DEFAULT_SETTINGS.maxDelay);

  const settings = {
    maxPosts,
    minDelay,
    maxDelay,
    dryRun: elements.dryRun.checked
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
      updateProgressUI(response.stats, response.status, response.message);
    }
  } catch {
    // Content script is not active on the current tab; keep default idle UI.
  }
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
    elements.statusMessage.textContent = 'Load at least one JSON file with post_urn entries first.';
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
      'Cannot connect to page. Open https://www.linkedin.com/my-items/saved-posts/ and refresh the tab.';
  }
}

async function handleStop() {
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_UNSAVE' });
      elements.statusMessage.textContent = 'Stopping after current step...';
    }
  } catch {
    setRunningState(false);
    setStatusBadge('stopped');
  }
}

async function handleClearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.UNSAVED_URNS]: [] });
  await refreshCounts();
  elements.statusMessage.textContent = 'Cleared unsaved post history.';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'PROGRESS') {
    updateProgressUI(message.stats, message.status, message.message);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEYS.TARGET_URNS] || changes[STORAGE_KEYS.UNSAVED_URNS]) {
    refreshCounts();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadSettings(), refreshCounts()]);
  await syncWithContentScript();

  elements.jsonFiles.addEventListener('change', handleFileSelection);
  elements.maxPosts.addEventListener('change', saveSettings);
  elements.minDelay.addEventListener('change', saveSettings);
  elements.maxDelay.addEventListener('change', saveSettings);
  elements.dryRun.addEventListener('change', saveSettings);
  elements.startBtn.addEventListener('click', handleStart);
  elements.stopBtn.addEventListener('click', handleStop);
  elements.clearHistoryBtn.addEventListener('click', handleClearHistory);
});
