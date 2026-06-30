// LivePilot content.js v5 — 15-strategy selector engine + deep DOM snapshot
'use strict';

// ── CLICK MARKER (Scribehow-style red box + dot, baked into the live page so
// chrome.tabs.captureVisibleTab rasterizes it as part of the screenshot) ──
// Shared across the executor and recorder IIFEs below. Draws from a plain
// rect object, not an element — the geometry gets computed synchronously at
// the actual click/action moment (see __lpRectOf), then the marker itself is
// drawn later once it's this action's turn in the capture queue, without
// drifting from a re-queried, possibly-stale element position.
if(!window.__lpDrawMarker){
  (function(){
    var markers=[];
    function clear(){ markers.forEach(function(n){ try{ n.remove(); }catch(_){} }); markers=[]; }
    window.__lpDrawMarker=function(rect,x,y,ttlMs){
      clear();
      ttlMs=ttlMs||1800; // comfortably outlast the ~280ms pre-action pause + screenshot round-trip; still clearly visible live
      if(rect&&(rect.width||rect.height)){
        var box=document.createElement('div');
        box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;'+
          'left:'+(rect.left-4)+'px;top:'+(rect.top-4)+'px;width:'+(rect.width+8)+'px;height:'+(rect.height+8)+'px;'+
          'border:3px solid #ff3b30;border-radius:6px;'+
          'box-shadow:0 0 0 3px rgba(255,59,48,.22),0 0 14px rgba(255,59,48,.6);';
        document.documentElement.appendChild(box);
        markers.push(box);
      }
      if(typeof x==='number'&&typeof y==='number'){
        var dot=document.createElement('div');
        dot.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;'+
          'left:'+(x-9)+'px;top:'+(y-9)+'px;width:18px;height:18px;border-radius:50%;'+
          'background:rgba(255,59,48,.45);border:2px solid #ff3b30;box-shadow:0 0 0 6px rgba(255,59,48,.18);';
        document.documentElement.appendChild(dot);
        markers.push(dot);
      }
      setTimeout(clear,ttlMs);
    };
    window.__lpRectOf=function(el){
      if(!el) return null;
      try{ var r=el.getBoundingClientRect(); return (r&&(r.width||r.height)) ? {left:r.left,top:r.top,width:r.width,height:r.height} : null; }catch(_){ return null; }
    };
    // Back-compat shim — only used to CLEAR (WAIT_QUIET calls this with no args).
    window.__lpMark=function(el,x,y,ttlMs){ window.__lpDrawMarker(window.__lpRectOf(el),x,y,ttlMs); };
  })();
}

// Straight to background.js's CAPTURE_SCREENSHOT handler (no side-panel hop),
// resolving only once the screenshot bytes are actually in hand — shared by
// the executor (captures before a programmatic click/type) and the recorder
// (captures before the page can react to a real one) below.
//
// Recording an action must NEVER depend on a screenshot actually succeeding:
// chrome.tabs.captureVisibleTab is rate-limited (~2 calls/sec — back-to-back
// clicks can exceed it) and a freshly-woken MV3 service worker can in rare
// cases drop a message without ever invoking its callback at all. Either
// failure mode used to leave this promise hanging forever, which silently
// stalled every action recorded after it (the symptom: recording works for
// the first click or two, then nothing else ever gets logged again).
//
// Marking and capturing are one atomic, queued step — not two independent
// calls. They used to be separate: a marker was drawn immediately, then its
// capture queued behind the rate limit. If a SECOND action's marker got
// drawn while the FIRST action's capture was still waiting its turn, the
// first capture ended up photographing the second marker instead of its
// own — "Click A"'s screenshot showing "B" highlighted. Chaining the draw
// and the capture through the same queue guarantees nothing can draw a
// different marker in between.
if(!window.__lpCaptureQueue){
  window.__lpCaptureQueue=Promise.resolve();
  window.__lpMarkAndCapture=function(el,x,y){
    var rect=window.__lpRectOf(el); // computed NOW, before any queueing delay
    var run=window.__lpCaptureQueue.then(function(){
      return new Promise(function(resolveGate){
        var sinceLast=Date.now()-(window.__lpLastCaptureAt||0);
        if(sinceLast<550) setTimeout(resolveGate,550-sinceLast); else resolveGate();
      });
    }).then(function(){
      window.__lpDrawMarker(rect,x,y);
      window.__lpLastCaptureAt=Date.now();
      return new Promise(function(resolve){
        var done=false;
        function finish(v){ if(done) return; done=true; resolve(v); }
        var to=setTimeout(function(){ finish(null); },1500); // hard ceiling — a stuck capture can't block recording
        try{
          // Wait for two animation frames so the browser has time to paint
          // the newly-inserted marker into the compositor before we ask
          // the background to capture the visible tab. This reduces cases
          // where the screenshot misses the highlight due to paint races.
          requestAnimationFrame(function(){
            requestAnimationFrame(function(){
              try{
                chrome.runtime.sendMessage({type:'CAPTURE_SCREENSHOT'}, function(r){
                  clearTimeout(to);
                  if(chrome.runtime.lastError){ finish(null); return; }
                  finish(r&&r.url?r.url:null);
                });
              }catch(_){ clearTimeout(to); finish(null); }
            });
          });
        }catch(_){ clearTimeout(to); finish(null); }
      });
    });
    // Keep the queue moving even if this capture failed — never let one bad
    // link wedge every capture after it.
    window.__lpCaptureQueue=run.catch(function(){});
    return run;
  };
}

(function(){
  if(window.__lp_injected) return;
  window.__lp_injected = true;
  var sidebar = null;

  chrome.runtime.onMessage.addListener(function(msg, _, sendResponse){
    switch(msg.type){
      case 'EXEC':
        var r = execAction(msg.step);
        if(r && typeof r.then==='function')
          r.then(sendResponse).catch(function(e){ sendResponse({error:e.message}); });
        else sendResponse(r);
        return true;
      case 'DOM_SNAPSHOT':
        sendResponse(getDOMSnapshot(msg.opts||{}));
        return false;
      case 'WAIT_QUIET':
        // This is always used to get a clean "page has settled" shot (navigate,
        // extract, etc.) — drop any leftover click marker so it can't bleed
        // into a screenshot it has nothing to do with. Queued behind
        // __lpCaptureQueue rather than cleared immediately: a click/type
        // capture can still be mid-flight (marker drawn, waiting on the
        // captureVisibleTab round trip) when this arrives — clearing right
        // away would erase that marker before its own screenshot is taken,
        // producing a clean-but-unhighlighted shot for that step.
        if(window.__lpCaptureQueue){
          window.__lpCaptureQueue = window.__lpCaptureQueue.then(function(){
            if(window.__lpMark) window.__lpMark();
          });
        } else if(window.__lpMark) window.__lpMark();
        waitForQuiet(msg.maxMs||2500, msg.quietMs||500, msg.minMs||600).then(function(){ sendResponse({ok:true}); });
        return true;
      case 'TOGGLE_SIDEBAR': toggleSidebar(); sendResponse({ok:true}); break;
      case 'PING': sendResponse({ok:true}); break;
    }
  });

  // ── ACTION EXECUTOR ──────────────────────────────────────────────────────
  function execAction(step){
    var action=step.action, target=step.target, value=step.value;

    if(action==='wait')
      return new Promise(function(r){ setTimeout(function(){ r({success:true}); }, Math.min(parseInt(value)||1000,8000)); });
    if(action==='scroll'){
      window.scrollBy({top:parseInt(value)||400,behavior:'smooth'});
      return {success:true};
    }
    if(action==='get_url')  return {success:true, url:window.location.href};
    if(action==='get_title')return {success:true, title:document.title};

    if(action==='click'){
      return waitForEl(target,6000).then(function(el){
        if(!el) return {error:'click: element not found — '+target};
        scrollIntoView(el);
        // Capture and WAIT for the actual screenshot bytes before touching
        // the element — a fire-and-forget "I'm about to click" signal isn't
        // enough, since the click can fire before that message even finishes
        // its round trip. Only once we're holding the captured image do we
        // know for certain the page still looks like it did pre-click.
        return captureNow(el).then(function(shot){
          return wait(120).then(function(){ el.click(); return {success:true, screenshot:shot}; });
        });
      });
    }
    if(action==='type'){
      return waitForEl(target,6000).then(function(el){
        if(!el) return {error:'type: input not found — '+target};
        scrollIntoView(el);
        return captureNow(el).then(function(shot){
          return wait(120).then(function(){
            el.focus();
            setNativeValue(el, value||'');
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            return {success:true, screenshot:shot};
          });
        });
      });
    }
    if(action==='press_enter'){
      return waitForEl(target,3000).then(function(el){
        var t=el||document.activeElement;
        if(t) scrollIntoView(t);
        var shotP = captureNow(t);
        return shotP.then(function(shot){
          return wait(120).then(function(){
            if(t){
              fireKey(t,'keydown');
              fireKey(t,'keypress');
              fireKey(t,'keyup');
              var form=t.closest?t.closest('form'):null;
              if(form){
                var sub=form.querySelector('[type="submit"]');
                if(sub) sub.click();
              }
            }
            return {success:true, screenshot:shot};
          });
        });
      });
    }
    if(action==='extract'){
      return waitForAny(target,6000).then(function(els){
        if(!els||!els.length) return {error:'extract: no elements — '+target, data:[]};
        var data=[];
        for(var i=0;i<els.length;i++){
          var txt=els[i].textContent.trim();
          if(txt) data.push({text:txt, href:els[i].href||getParentHref(els[i])});
        }
        return {success:true, data:data};
      });
    }
    if(action==='get_text'){
      return waitForEl(target,4000).then(function(el){
        if(!el) return {error:'get_text: not found — '+target};
        return {success:true, text:el.textContent.trim()};
      });
    }
    return {error:'Unknown action: '+action};
  }

  // ── 15-STRATEGY FINDER ───────────────────────────────────────────────────
  function findBest(sel){
    if(!sel||sel.trim()==='') return null;
    var s=sel.trim();

    // 1. Direct CSS selector (most specific)
    try{ var e=document.querySelector(s); if(e&&isUsable(e)) return e; }catch(_){}

    // 2. Exact aria-label match
    try{ var e=document.querySelector('[aria-label="'+escAttr(s)+'"]'); if(e&&isUsable(e)) return e; }catch(_){}

    // 3. Aria-label contains (case-insensitive via attribute selector)
    var lc=s.toLowerCase();
    try{
      var candidates=document.querySelectorAll('[aria-label]');
      for(var i=0;i<candidates.length;i++){
        var al=(candidates[i].getAttribute('aria-label')||'').toLowerCase();
        if(al===lc||al.indexOf(lc)!==-1){ if(isUsable(candidates[i])) return candidates[i]; }
      }
    }catch(_){}

    // 4. Exact placeholder match
    try{ var e=document.querySelector('[placeholder="'+escAttr(s)+'"]'); if(e&&isUsable(e)) return e; }catch(_){}

    // 5. Placeholder contains
    try{
      var inps=document.querySelectorAll('[placeholder]');
      for(var i=0;i<inps.length;i++){
        if((inps[i].getAttribute('placeholder')||'').toLowerCase().indexOf(lc)!==-1&&isUsable(inps[i])) return inps[i];
      }
    }catch(_){}

    // 6. Name attribute
    try{ var e=document.querySelector('[name="'+escAttr(s)+'"]'); if(e&&isUsable(e)) return e; }catch(_){}

    // 7. data-testid / data-cy / data-qa / data-id
    var dataAttrs=['data-testid','data-cy','data-qa','data-id','data-name'];
    for(var d=0;d<dataAttrs.length;d++){
      try{
        var e=document.querySelector('['+dataAttrs[d]+'="'+escAttr(s)+'"]');
        if(e&&isUsable(e)) return e;
        var e2=document.querySelector('['+dataAttrs[d]+'*="'+escAttr(lc)+'"]');
        if(e2&&isUsable(e2)) return e2;
      }catch(_){}
    }

    // 8. ID attribute (loose, not as CSS selector)
    try{ var e=document.getElementById(s); if(e&&isUsable(e)) return e; }catch(_){}

    // 9. EXACT visible text on interactive elements
    var interactive=document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],input[type="submit"],input[type="button"],label,[tabindex]');
    for(var i=0;i<interactive.length;i++){
      var t=interactive[i].textContent.trim().toLowerCase();
      if(t===lc&&isUsable(interactive[i])) return interactive[i];
    }

    // 10. PARTIAL text on interactive elements (shorter matches rank higher)
    var best=null, bestLen=99999;
    for(var i=0;i<interactive.length;i++){
      var t=interactive[i].textContent.trim().toLowerCase();
      if(t.indexOf(lc)!==-1&&isUsable(interactive[i])&&t.length<bestLen){
        best=interactive[i]; bestLen=t.length;
      }
    }
    if(best) return best;

    // 11. Input type hint (e.g. "input[type=search]" was rejected as CSS but retry explicitly)
    var typeMatch=s.match(/(?:^|input\[?)type[="\s]*['"]?([a-z]+)/i);
    if(typeMatch){
      var e=document.querySelector('input[type="'+typeMatch[1]+'"]');
      if(e&&isUsable(e)) return e;
    }

    // 12. Search/query box heuristic — find best visible text input
    if(lc.indexOf('search')!==-1||lc.indexOf('query')!==-1||lc.indexOf('#search')!==-1||lc==='q'){
      var searches=document.querySelectorAll('input[type="search"],input[name="q"],input[name="query"],input[name="search"],input[role="searchbox"],[role="searchbox"]');
      for(var i=0;i<searches.length;i++){ if(isUsable(searches[i])) return searches[i]; }
      // Fall back to any visible text input in a form
      var inputs=document.querySelectorAll('form input[type="text"],form input:not([type]),input[type="text"]');
      for(var i=0;i<inputs.length;i++){ if(isUsable(inputs[i])) return inputs[i]; }
    }

    // 13. Title attribute
    try{
      var e=document.querySelector('[title="'+escAttr(s)+'"]');
      if(e&&isUsable(e)) return e;
      var e2=document.querySelector('[title*="'+escAttr(s)+'"]');
      if(e2&&isUsable(e2)) return e2;
    }catch(_){}

    // 14. Value attribute (for buttons/inputs with value text)
    try{
      var e=document.querySelector('[value="'+escAttr(s)+'"]');
      if(e&&isUsable(e)) return e;
    }catch(_){}

    // 15. Class name fragment (last resort)
    try{
      var frag=s.replace(/^[.#]/,'').split(/[.\s\[]/)[0];
      if(frag&&frag.length>2){
        var e=document.querySelector('.'+frag);
        if(e&&isUsable(e)) return e;
      }
    }catch(_){}

    return null;
  }

  function isUsable(el){
    if(!el) return false;
    try{
      var r=el.getBoundingClientRect();
      // Allow zero-size for inputs hidden off-screen (still interactable)
      var s=window.getComputedStyle(el);
      if(s.display==='none'||s.visibility==='hidden') return false;
      // Check not in a hidden parent
      var p=el.parentElement;
      while(p&&p!==document.body){
        var ps=window.getComputedStyle(p);
        if(ps.display==='none'||ps.visibility==='hidden') return false;
        p=p.parentElement;
      }
      return true;
    }catch(_){ return true; }
  }

  // Resolves once the page has stopped mutating for `quietMs`, or after
  // `maxMs` regardless — so a screenshot taken right after isn't capturing a
  // half-loaded "Loading…" skeleton on slower, AJAX-heavy pages.
  // `minMs` is a settle floor: most clicks kick off an XHR/fetch that takes a
  // beat before its *first* DOM update even lands, which can easily exceed
  // quietMs on its own — without a floor, "nothing has mutated yet" gets
  // misread as "already settled" and we'd resolve before the load even starts.
  function waitForQuiet(maxMs,quietMs,minMs){
    return new Promise(function(resolve){
      var done=false, quietTimer=null, maxTimer=null, obs=null, start=Date.now();
      function finish(){
        if(done) return; done=true;
        if(obs){ try{ obs.disconnect(); }catch(_){} }
        clearTimeout(quietTimer); clearTimeout(maxTimer);
        setTimeout(resolve,50); // tiny trailing pause to let the final paint flush
      }
      function resetQuiet(){
        clearTimeout(quietTimer);
        var remaining = Math.max(quietMs, minMs-(Date.now()-start));
        quietTimer = setTimeout(finish,remaining);
      }
      try{ obs=new MutationObserver(resetQuiet); obs.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true}); }catch(_){}
      maxTimer=setTimeout(finish,maxMs);
      resetQuiet();
    });
  }

  function waitForEl(sel,timeout){
    var found=findBest(sel);
    if(found) return Promise.resolve(found);
    return new Promise(function(resolve){
      var elapsed=0,interval=150;
      var timer=setInterval(function(){
        var el=findBest(sel);
        if(el){ clearInterval(timer); resolve(el); return; }
        elapsed+=interval;
        if(elapsed>=timeout){ clearInterval(timer); resolve(null); }
      },interval);
    });
  }

  function waitForAny(sel,timeout){
    try{ var els=document.querySelectorAll(sel); if(els.length) return Promise.resolve(Array.from(els)); }catch(_){}
    return new Promise(function(resolve){
      var elapsed=0,interval=200;
      var timer=setInterval(function(){
        try{
          var els=document.querySelectorAll(sel);
          if(els.length){ clearInterval(timer); resolve(Array.from(els)); return; }
        }catch(_){}
        elapsed+=interval;
        if(elapsed>=timeout){ clearInterval(timer); resolve([]); }
      },interval);
    });
  }

  function setNativeValue(el,val){
    try{
      var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      var desc=Object.getOwnPropertyDescriptor(proto,'value');
      if(desc&&desc.set) desc.set.call(el,val);
      else el.value=val;
    }catch(_){ el.value=val; }
  }

  function fireKey(el,type){
    el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
  }

  function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }

  function captureNow(el,x,y){ return window.__lpMarkAndCapture(el,x,y); }

  function scrollIntoView(el){
    // Instant, not smooth — the highlight marker snapshots el's rect right after
    // this call, so an animated scroll would leave the box trailing behind
    // (and stale) while the page is still settling into place.
    try{ el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); }catch(_){
      try{ el.scrollIntoView(); }catch(__){}
    }
  }

  function getParentHref(el){
    var p=el;
    while(p&&p!==document.body){ if(p.href) return p.href; p=p.parentElement; }
    return null;
  }

  function escAttr(s){
    return String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  }

  // ── DEEP DOM SNAPSHOT ─────────────────────────────────────────────────────
  // Returns rich, structured snapshot for AI to pick real selectors from
  function getDOMSnapshot(opts){
    var limit=opts.limit||80;
    var snapshot={
      url: window.location.href,
      title: document.title,
      headings: [],
      forms: [],
      inputs: [],
      buttons: [],
      links: [],
      landmarks: []
    };

    // Headings
    document.querySelectorAll('h1,h2,h3').forEach(function(h){
      var t=h.textContent.trim().slice(0,80);
      if(t) snapshot.headings.push(t);
    });
    snapshot.headings=snapshot.headings.slice(0,6);

    // All inputs/textareas
    var inpSeen=0;
    document.querySelectorAll('input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"]').forEach(function(el){
      if(inpSeen>=20||!isUsable(el)) return;
      inpSeen++;
      snapshot.inputs.push({
        sel: buildSelector(el),
        tag: el.tagName.toLowerCase(),
        type: el.type||el.getAttribute('role')||'',
        name: el.name||'',
        id: el.id||'',
        placeholder: el.placeholder||'',
        ariaLabel: el.getAttribute('aria-label')||'',
        value: el.tagName==='INPUT'&&el.type!=='password'?(el.value||'').slice(0,30):'',
        testid: el.getAttribute('data-testid')||''
      });
    });

    // Buttons
    var btnSeen=0;
    document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],[type="submit"]').forEach(function(el){
      if(btnSeen>=20||!isUsable(el)) return;
      btnSeen++;
      snapshot.buttons.push({
        sel: buildSelector(el),
        text: el.textContent.trim().slice(0,50)||el.value||'',
        ariaLabel: el.getAttribute('aria-label')||'',
        type: el.type||''
      });
    });

    // Key links (nav-style)
    var lnkSeen=0;
    document.querySelectorAll('a[href],[role="link"]').forEach(function(el){
      if(lnkSeen>=15||!isUsable(el)) return;
      var t=el.textContent.trim().slice(0,40);
      if(!t) return;
      lnkSeen++;
      snapshot.links.push({sel:buildSelector(el), text:t, href:(el.href||'').slice(0,80)});
    });

    // Form structure
    document.querySelectorAll('form').forEach(function(form,fi){
      if(fi>=3) return;
      var fields=[];
      form.querySelectorAll('input,textarea,select,button,[type="submit"]').forEach(function(el){
        if(!isUsable(el)) return;
        fields.push({sel:buildSelector(el),tag:el.tagName.toLowerCase(),type:el.type||'',name:el.name||'',placeholder:el.placeholder||''});
      });
      if(fields.length) snapshot.forms.push({id:form.id||'',action:form.action||'',fields:fields.slice(0,10)});
    });

    // ARIA landmarks for context
    document.querySelectorAll('[role="main"],[role="navigation"],[role="search"],[role="banner"]').forEach(function(el){
      snapshot.landmarks.push(el.getAttribute('role'));
    });

    return snapshot;
  }

  function buildSelector(el){
    if(!el) return '';
    // Priority order for most reliable selectors
    if(el.id&&/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id)) return '#'+el.id;
    var testid=el.getAttribute('data-testid')||el.getAttribute('data-cy')||el.getAttribute('data-qa');
    if(testid) return '[data-testid="'+testid+'"]';
    var al=el.getAttribute('aria-label');
    if(al&&al.length<60) return '[aria-label="'+escAttr(al)+'"]';
    if(el.name&&/^[a-zA-Z]/.test(el.name)) return el.tagName.toLowerCase()+'[name="'+escAttr(el.name)+'"]';
    if(el.placeholder&&el.placeholder.length<50) return el.tagName.toLowerCase()+'[placeholder*="'+escAttr(el.placeholder.slice(0,25))+'"]';
    var role=el.getAttribute('role');
    if(role) return '[role="'+role+'"]';
    if(el.type&&el.tagName==='INPUT') return 'input[type="'+el.type+'"]';
    // Class-based as last resort
    if(el.className&&typeof el.className==='string'){
      var cls=el.className.trim().split(/\s+/).filter(function(c){
        return c&&c.length>2&&!/^\d/.test(c)&&c.indexOf('__')===-1&&c.indexOf('--')===-1;
      });
      if(cls.length) return el.tagName.toLowerCase()+'.'+cls[0];
    }
    return el.tagName.toLowerCase();
  }

  // ── SIDEBAR ───────────────────────────────────────────────────────────────
  function toggleSidebar(){
    if(sidebar){ sidebar.remove(); sidebar=null; return; }
    sidebar=document.createElement('iframe');
    sidebar.src=chrome.runtime.getURL('sidebar.html');
    sidebar.style.cssText='position:fixed;top:0;right:0;width:320px;height:100vh;border:none;z-index:2147483646;box-shadow:-4px 0 24px rgba(0,0,0,.18);';
    document.body.appendChild(sidebar);
  }
})();

// ── SESSION RECORDER ──────────────────────────────────────────────────────────
(function(){
  if(window.__lp_recorder) return;
  window.__lp_recorder = true;

  var isRecording = false;
  var handlers = {};
  var lastInputEl = null;
  var lastInputTimeout = null;
  var lastInteractionAt = 0; // set whenever a click/type/press_enter is recorded

  function emit(action){
    chrome.runtime.sendMessage({type:'RECORDED_ACTION', action:action}, function(){
      if(chrome.runtime.lastError){}  // ignore if side panel not open
    });
  }

  function bestSelector(el){
    if(!el || el===document.body || el===document.documentElement) return null;
    // Skip invisible elements
    try{var r=el.getBoundingClientRect();if(r.width===0&&r.height===0)return null;}catch(_){}
    if(el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id)) return '#'+el.id;
    var testid=el.getAttribute('data-testid')||el.getAttribute('data-cy');
    if(testid) return '[data-testid="'+testid.replace(/"/g,'\"')+'"]';
    var aria=el.getAttribute('aria-label');
    if(aria&&aria.length<60) return '[aria-label="'+aria.replace(/"/g,'\"')+'"]';
    if(el.name&&/^[a-zA-Z]/.test(el.name)) return el.tagName.toLowerCase()+'[name="'+el.name+'"]';
    if(el.placeholder&&el.placeholder.length<50) return el.tagName.toLowerCase()+'[placeholder*="'+el.placeholder.slice(0,25).replace(/"/g,'\"')+'"]';
    if(el.type&&el.tagName==='INPUT'&&el.type!=='text') return 'input[type="'+el.type+'"]';
    var role=el.getAttribute('role');
    if(role&&['button','link','textbox','searchbox','combobox','tab','menuitem'].indexOf(role)!==-1) return '[role="'+role+'"]';
    if(el.className&&typeof el.className==='string'){
      var cls=el.className.trim().split(/\s+/).filter(function(c){
        return c&&c.length>2&&!/^\d/.test(c)&&c.indexOf('__')===-1&&c.indexOf('--')===-1;
      });
      if(cls.length) return el.tagName.toLowerCase()+'.'+cls.slice(0,2).join('.');
    }
    // Walk up to find a better parent
    if(el.parentElement && el.parentElement!==document.body){
      var parentSel=bestSelector(el.parentElement);
      if(parentSel) return parentSel+' '+el.tagName.toLowerCase();
    }
    return el.tagName.toLowerCase();
  }

  function getDescText(el){
    var t=el.textContent.trim().slice(0,60)||el.value||el.placeholder||el.getAttribute('aria-label')||'';
    return t.replace(/\s+/g,' ');
  }

  function onMouseup(e){
    // Only record actual user-initiated clicks on meaningful elements
    if(!isRecording) return;
    var el=e.target;
    // Skip if inside an input (handled by input/keydown)
    if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT') return;
    // Skip text-only elements (spans with no role)
    var isInteractive = el.tagName==='A'||el.tagName==='BUTTON'||el.getAttribute('role')||
                        el.getAttribute('href')||el.getAttribute('onclick')||
                        window.getComputedStyle(el).cursor==='pointer';
    if(!isInteractive) return;
    var sel=bestSelector(el);
    if(!sel) return;
    var text=getDescText(el);
    // The real click event has already fired by the time this resolves (it's
    // dispatched synchronously right after mouseup, before any async code of
    // ours can run) — there's no way to get strictly "before" for a human's
    // own click. Capturing as the very first thing we do, with no relay hop,
    // is the closest achievable: it's racing the click's own effects rather
    // than something that waited for them to finish first. Marking and
    // capturing happen as one atomic queued step (see __lpMarkAndCapture) so
    // a later click's marker can never overwrite this one before it's captured.
    window.__lpMarkAndCapture(el,e.clientX,e.clientY).then(function(shot){
      lastInteractionAt=Date.now();
      emit({action:'click', target:sel, description:'Click: '+(text||sel), value:'', sensitive:false, screenshot:shot});
    });
  }

  // Marks + captures + emits whatever's pending in lastInputEl, if anything.
  // Shared by the debounced input flush, the Enter-key flush, and the
  // STOP_RECORDING flush so all three get the same "screenshot before
  // anything else can change" treatment as a real click.
  function flushPendingInput(){
    if(!lastInputEl) return Promise.resolve();
    var el=lastInputEl, val=lastInputEl.value, sensitive=lastInputEl.type==='password';
    lastInputEl=null;
    var sel=bestSelector(el);
    if(!sel) return Promise.resolve();
    return window.__lpMarkAndCapture(el).then(function(shot){
      lastInteractionAt=Date.now();
      emit({action:'type', target:sel, value:val, description:'Type "'+val.slice(0,40)+'" in '+sel, sensitive:sensitive, screenshot:shot});
    });
  }

  function onInput(e){
    if(!isRecording) return;
    var el=e.target;
    if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'&&el.tagName!=='SELECT') return;
    lastInputEl=el;
    // Debounce — emit type after 800ms pause to capture full value
    clearTimeout(lastInputTimeout);
    lastInputTimeout=setTimeout(function(){
      if(!isRecording) return;
      flushPendingInput();
    },800);
  }

  function onKeydown(e){
    if(!isRecording) return;
    if(e.key==='Enter'){
      // Flush any pending input first
      clearTimeout(lastInputTimeout);
      flushPendingInput().then(function(){
        var el=e.target||document.activeElement;
        var sel=bestSelector(el);
        if(!sel) return;
        return window.__lpMarkAndCapture(el).then(function(shot){
          lastInteractionAt=Date.now();
          emit({action:'press_enter', target:sel, description:'Press Enter on '+sel, value:'', sensitive:false, screenshot:shot});
        });
      });
    }
    // Capture Cmd/Ctrl+A (select all) for awareness
  }

  function onScroll(){
    // Debounce scroll recording — only emit scroll if page moved significantly
    // Skipping scroll recording to avoid noise in most use cases
  }

  function onNavigation(){
    if(!isRecording) return;
    emit({action:'navigate', target:window.location.href, description:'Navigate to '+window.location.href, value:'', sensitive:false});
  }

  // Listen for control messages
  chrome.runtime.onMessage.addListener(function(msg, _, sendResponse){
    if(msg.type==='START_RECORDING'){
      if(isRecording){ sendResponse({ok:true}); return; }
      isRecording=true; lastInputEl=null;
      handlers.mouseup  = onMouseup;
      handlers.input    = onInput;
      handlers.keydown  = onKeydown;
      document.addEventListener('mouseup',  handlers.mouseup,  true);
      document.addEventListener('input',    handlers.input,    true);
      document.addEventListener('keydown',  handlers.keydown,  true);
      // Emit initial page as context — for a resumed recording (the side
      // panel re-sends this after a full navigation tore down the previous
      // content.js instance) this is really just "you ended up here", so
      // word it as a destination rather than implying recording just began.
      emit({action:'navigate', target:window.location.href, description:(msg.resumed?'Page loaded: ':'Recording started on ')+window.location.href, value:'', sensitive:false});
      sendResponse({ok:true, url:window.location.href});
      return true;
    }
    if(msg.type==='STOP_RECORDING'){
      isRecording=false;
      clearTimeout(lastInputTimeout);
      flushPendingInput();
      if(handlers.mouseup) document.removeEventListener('mouseup', handlers.mouseup, true);
      if(handlers.input)   document.removeEventListener('input',   handlers.input,   true);
      if(handlers.keydown) document.removeEventListener('keydown', handlers.keydown, true);
      handlers={};
      sendResponse({ok:true});
      return true;
    }
  });

  // Detect page navigations (SPA route changes — e.g. clicking a tab that
  // updates the URL without a full reload)
  var lastHref=window.location.href;
  setInterval(function(){
    if(!isRecording) return;
    if(window.location.href!==lastHref){
      lastHref=window.location.href;
      // A click/type/press_enter recorded moments ago almost always *caused*
      // this URL change (an SPA tab/route switch) — that step already shows
      // what was clicked, so adding a second "Opened <url>" step here would
      // just be a near-duplicate of the same interaction, with a screenshot
      // that's really just whatever marker happened to still be on screen.
      if(Date.now()-lastInteractionAt < 1500) return;
      emit({action:'navigate', target:lastHref, description:'Navigated to '+lastHref, value:'', sensitive:false});
    }
  },1000);
})();
