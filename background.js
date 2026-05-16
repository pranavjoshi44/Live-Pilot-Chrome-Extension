// LivePilot background.js v2 — side panel + recording relay
'use strict';

// ── SIDE PANEL ────────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(function(tab) {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onInstalled.addListener(function() {
  chrome.sidePanel.setOptions({ enabled: true });
  console.log('[LivePilot] Installed v1.4.0');
});

// ── MESSAGE RELAY ─────────────────────────────────────────────────────────────
// Content scripts cannot message directly to side panel context.
// Background receives RECORDED_ACTION and re-broadcasts to all extension pages.
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

  // Relay recording actions to side panel
  if (msg.type === 'RECORDED_ACTION') {
    // sendResponse immediately so content script isn't blocked
    sendResponse({ ok: true });
    // Re-broadcast to all extension contexts (side panel receives this)
    chrome.runtime.sendMessage(msg).catch(function() {
      // Side panel may not be open — that's fine
    });
    return false;
  }

  // Screenshot capture (called by side panel, captured from background)
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 45 }, function(url) {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ url: url });
    });
    return true; // async
  }

  return false;
});

// Tab tracking removed — injection is on-demand only (avoids excessive script injection)
