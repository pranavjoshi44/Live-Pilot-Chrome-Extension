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

  // Screenshot capture (called directly by content.js right after drawing a
  // click marker, and by the side panel itself for steps that don't draw one
  // — navigate/extract/etc, or the recorder's "no marker yet" fallback).
  // Always resolve a specific window rather than "whatever's currently
  // focused": a content-script sender already carries its own tab, but a
  // side-panel sender doesn't (extension pages aren't tied to a tab), and
  // without this, those calls silently fell back to the focused window —
  // capturing the wrong tab (or failing outright with "Cannot access a
  // chrome:// URL") the moment that focus wasn't the tab being recorded.
  // The one exception: a caller can omit tabId on purpose to mean "whatever
  // I'm looking at right now" (e.g. the editor's manual "capture this tab"
  // button), so only resolve a tabId when one was actually given.
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    var capture = function(windowId){
      chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 }, function(url) {
        if (chrome.runtime.lastError) { sendResponse({ error: chrome.runtime.lastError.message }); return; }
        // Captured at full (often retina, 2x+) display resolution — way more
        // pixels than any document or thumbnail needs, and the dominant reason
        // a handful of recordings can blow past chrome.storage.local's quota.
        // Downscale before it ever reaches storage.
        downscale(url, 1280).then(function(small){ sendResponse({ url: small }); });
      });
    };
    if (msg.tabId) {
      chrome.tabs.get(msg.tabId, function(tab) {
        if (chrome.runtime.lastError || !tab) { sendResponse({ error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Tab not found' }); return; }
        capture(tab.windowId);
      });
    } else {
      capture((sender && sender.tab) ? sender.tab.windowId : null);
    }
    return true; // async
  }

  // Publish a generated guide to Confluence: create the page, then upload
  // each screenshot as an attachment. The page body (built in docgen.js)
  // already references those attachments by filename via <ac:image> macros —
  // Confluence resolves that reference by filename whenever the page is
  // *viewed*, not at save time, so there's no need to create the page, then
  // come back and patch its body once the attachments exist.
  if (msg.type === 'CONFLUENCE_PUBLISH') {
    publishToConfluence(msg.config, msg.doc)
      .then(function(result){ sendResponse({ ok: true, url: result.url }); })
      .catch(function(e){ sendResponse({ error: e.message }); });
    return true; // async
  }

  return false;
});

function publishToConfluence(config, doc) {
  var isCloud = config.type === 'cloud';
  var base = config.baseUrl + (isCloud ? '/wiki/rest/api' : '/rest/api');
  var authHeader = isCloud
    ? 'Basic ' + btoa(config.email + ':' + config.token)
    : 'Bearer ' + config.token;

  function apiJson(path, method, bodyObj) {
    return fetch(base + path, {
      method: method,
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    }).then(function(res){
      if (!res.ok) {
        return res.text().then(function(t){
          throw new Error('Confluence ' + res.status + ': ' + (t || res.statusText).slice(0, 300));
        });
      }
      return res.json();
    });
  }

  return apiJson('/content', 'POST', {
    type: 'page',
    title: doc.title,
    space: { key: config.spaceKey },
    body: { storage: { value: doc.html, representation: 'storage' } }
  }).then(function(page){
    var uploads = doc.images.reduce(function(chain, img){
      return chain.then(function(){
        var form = new FormData();
        form.append('file', new Blob([img.bytes], { type: 'image/jpeg' }), img.filename);
        return fetch(base + '/content/' + page.id + '/child/attachment', {
          method: 'POST',
          headers: { 'Authorization': authHeader, 'X-Atlassian-Token': 'nocheck' },
          body: form
        }).then(function(res){
          if (!res.ok) throw new Error('Attachment "' + img.filename + '" failed to upload (' + res.status + ')');
        });
      });
    }, Promise.resolve());

    return uploads.then(function(){
      var webui = page._links && page._links.webui;
      var siteBase = (page._links && page._links.base) || config.baseUrl;
      return { url: webui ? siteBase + webui : config.baseUrl };
    });
  });
}

function downscale(dataUrl, maxW) {
  return fetch(dataUrl).then(function(r){ return r.blob(); })
    .then(function(blob){ return createImageBitmap(blob); })
    .then(function(bitmap){
      if (bitmap.width <= maxW) { bitmap.close(); return dataUrl; }
      var scale = maxW / bitmap.width;
      var w = maxW, h = Math.round(bitmap.height * scale);
      var canvas = new OffscreenCanvas(w, h);
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }).then(function(outBlob){
        return outBlob.arrayBuffer();
      }).then(function(buf){
        var bytes = new Uint8Array(buf), binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return 'data:image/jpeg;base64,' + btoa(binary);
      });
    })
    .catch(function(){ return dataUrl; }); // resizing is an optimization, not a requirement — never let it block the capture
}

// Tab tracking removed — injection is on-demand only (avoids excessive script injection)
