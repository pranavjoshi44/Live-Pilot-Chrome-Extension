// LivePilot content.js v5 — 15-strategy selector engine + deep DOM snapshot
'use strict';
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
        highlight(el); scrollIntoView(el); el.click();
        return {success:true};
      });
    }
    if(action==='type'){
      return waitForEl(target,6000).then(function(el){
        if(!el) return {error:'type: input not found — '+target};
        highlight(el); scrollIntoView(el); el.focus();
        setNativeValue(el, value||'');
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return {success:true};
      });
    }
    if(action==='press_enter'){
      return waitForEl(target,3000).then(function(el){
        var t=el||document.activeElement;
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
        return {success:true};
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

  function scrollIntoView(el){
    try{ el.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'}); }catch(_){}
  }

  function highlight(el){
    if(!el) return;
    var prev=el.style.outline;
    el.style.transition='outline .1s';
    el.style.outline='2px solid #5b52e8';
    setTimeout(function(){ el.style.outline=prev; },700);
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
    emit({action:'click', target:sel, description:'Click: '+(text||sel), value:'', sensitive:false});
  }

  function onInput(e){
    if(!isRecording) return;
    var el=e.target;
    if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'&&el.tagName!=='SELECT') return;
    lastInputEl=el;
    // Debounce — emit type after 800ms pause to capture full value
    clearTimeout(lastInputTimeout);
    lastInputTimeout=setTimeout(function(){
      if(!lastInputEl||!isRecording) return;
      var sel=bestSelector(lastInputEl);
      if(!sel) return;
      emit({action:'type', target:sel, value:lastInputEl.value, description:'Type "'+lastInputEl.value.slice(0,40)+'" in '+sel, sensitive:lastInputEl.type==='password'});
      lastInputEl=null;
    },800);
  }

  function onKeydown(e){
    if(!isRecording) return;
    if(e.key==='Enter'){
      // Flush any pending input first
      clearTimeout(lastInputTimeout);
      if(lastInputEl){
        var isel=bestSelector(lastInputEl);
        if(isel) emit({action:'type', target:isel, value:lastInputEl.value, description:'Type "'+lastInputEl.value.slice(0,40)+'" in '+isel, sensitive:lastInputEl.type==='password'});
        lastInputEl=null;
      }
      var el=e.target||document.activeElement;
      var sel=bestSelector(el);
      if(sel) emit({action:'press_enter', target:sel, description:'Press Enter on '+sel, value:'', sensitive:false});
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
      // Emit initial page as context
      emit({action:'navigate', target:window.location.href, description:'Recording started on '+window.location.href, value:'', sensitive:false});
      sendResponse({ok:true, url:window.location.href});
      return true;
    }
    if(msg.type==='STOP_RECORDING'){
      isRecording=false;
      clearTimeout(lastInputTimeout);
      // Flush pending input
      if(lastInputEl){
        var isel=bestSelector(lastInputEl);
        if(isel) emit({action:'type', target:isel, value:lastInputEl.value, description:'Type "'+lastInputEl.value.slice(0,40)+'"', sensitive:lastInputEl.type==='password'});
        lastInputEl=null;
      }
      if(handlers.mouseup) document.removeEventListener('mouseup', handlers.mouseup, true);
      if(handlers.input)   document.removeEventListener('input',   handlers.input,   true);
      if(handlers.keydown) document.removeEventListener('keydown', handlers.keydown, true);
      handlers={};
      sendResponse({ok:true});
      return true;
    }
  });

  // Detect page navigations (SPA)
  var lastHref=window.location.href;
  setInterval(function(){
    if(!isRecording) return;
    if(window.location.href!==lastHref){
      lastHref=window.location.href;
      emit({action:'navigate', target:lastHref, description:'Navigated to '+lastHref, value:'', sensitive:false});
    }
  },1000);
})();
