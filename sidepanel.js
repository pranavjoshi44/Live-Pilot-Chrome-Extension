// LivePilot sidepanel.js — persistent side panel, recording relay, CSV export
'use strict';

var G = {
  apiKey: '', model: 'llama-3.3-70b-versatile',
  running: false, aborted: false,
  plan: null, shots: [], workflows: [], history: [], recordings: [], log: [],
  extractedData: [],   // [{text, href}] accumulated across all extract steps
  settings: { hitl: true, screenshots: true, planning: true },
  vars: {}, done: 0, total: 0,
  planResolve: null, confResolve: null, varResolve: null, delResolve: null,
  timerInterval: null, startTime: null, currentTabId: null,
  isRecording: false, currentRecording: null, savingRecording: false,
  lastTask: '', pendingGuide: null, skipSavePrompt: false, confluence: null,
};

function q(id) { var e=document.getElementById(id); if(!e) console.warn('[LP] missing:',id); return e; }
function sleep(ms) { return new Promise(function(r){setTimeout(r,ms);}); }

// chrome.storage.local.set() returns a promise in MV3 — call it bare (no
// callback, no .catch) and a quota failure becomes an invisible "Uncaught
// (in promise)" console error instead of something the user ever sees.
// Recordings carry screenshots and are by far the most likely thing to hit
// the quota, so failures here get a real, visible log line.
function saveLocal(items){
  chrome.storage.local.set(items).catch(function(e){
    addLog('⚠ Could not save: '+e.message+' — try clearing old recordings.','err');
  });
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.local.get(['apiKey','model','workflows','settings','history','vars','recordings','onboarded','confluence'], function(d) {
    if (d.apiKey)     { G.apiKey=d.apiKey; bannerOk(true); }
    if (d.model)      { G.model=d.model; q('mdlSel').value=G.model; updateMdlPill(); }
    if (d.workflows)  { G.workflows=Array.isArray(d.workflows)?d.workflows:[]; }
    if (d.settings)   { G.settings=Object.assign({},G.settings,d.settings); }
    if (d.history)    { G.history=Array.isArray(d.history)?d.history:[]; }
    if (d.vars)       { G.vars=d.vars; loadVarInputs(); }
    if (d.recordings) { G.recordings=Array.isArray(d.recordings)?d.recordings:[]; }
    if (d.confluence) { G.confluence=d.confluence; loadConfluenceInputs(); }
    applyToggles(); renderHistory(); renderRecordings();
    if (!d.onboarded) startOnboarding(); else q('onboarding').classList.add('hide');
  });
  wireEvents();
});

function wireEvents() {
  // Onboarding
  q('btnObGroqLink').addEventListener('click', function(e){ e.preventDefault(); chrome.tabs.create({url:'https://console.groq.com/keys'}); });
  q('btnObS1Next').addEventListener('click', function(){ obGoStep(2); });
  q('btnObVerify').addEventListener('click', verifyApiKey);
  q('btnObSkipApi').addEventListener('click', function(){ obGoStep(3); });
  q('btnObFinish').addEventListener('click', finishOnboarding);
  q('obApiInp').addEventListener('keydown', function(e){ if(e.key==='Enter') verifyApiKey(); });
  // API
  q('apiBan').addEventListener('click', toggleApiBox);
  q('btnSaveKey').addEventListener('click', saveApiKey);
  q('apiInp').addEventListener('keydown', function(e){ if(e.key==='Enter') saveApiKey(); });
  // Task
  q('taskInput').addEventListener('input', detectVars);
  q('taskInput').addEventListener('keydown', function(e){ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();startTask();} });
  // Controls
  q('btnRun').addEventListener('click', startTask);
  q('btnStop').addEventListener('click', stopTask);
  q('btnRecord').addEventListener('click', toggleRecording);
  q('btnClearTask').addEventListener('click', clearTaskAndLog);
  q('btnCopyLog').addEventListener('click', copyLog);
  // Results
  q('btnGenDoc').addEventListener('click', function(){
    if(!G.shots.length){ addLog('No screenshots captured — enable Auto Screenshots in Settings, then re-run.','inf'); return; }
    openDocModal(LPDoc.fromRun(G.lastTask, G.plan, G.shots));
  });
  q('btnExportCSV').addEventListener('click', exportCSV);
  q('btnExportTxt').addEventListener('click', exportTxt);
  q('btnCopyResult').addEventListener('click', copyResult);
  document.querySelectorAll('.result-tab').forEach(function(t){
    t.addEventListener('click', function(){ switchResultTab(t.dataset.rt); });
  });
  // Plan
  q('btnApprove').addEventListener('click', function(){ resolvePlan(true); });
  q('btnCancelPlan').addEventListener('click', function(){ resolvePlan(false); });
  // Nav
  document.querySelectorAll('.nav-btn').forEach(function(b){ b.addEventListener('click', function(){ switchPane(b.dataset.pane,b); }); });
  q('mdlPill').addEventListener('click', function(){ switchPane('settings',q('navSettings')); });
  // SS modal
  q('btnCloseSS').addEventListener('click', function(){ q('ssModal').classList.remove('on'); });
  q('ssModal').addEventListener('click', function(e){ if(e.target===q('ssModal')) q('ssModal').classList.remove('on'); });
  // Confirm
  q('btnConfYes').addEventListener('click', function(){ resolveConf(true); });
  q('btnConfNo').addEventListener('click',  function(){ resolveConf(false); });
  // Var
  q('btnVarOk').addEventListener('click', function(){ resolveVar(q('varModalInp').value.trim()); });
  q('btnVarSkip').addEventListener('click', function(){ resolveVar(''); });
  q('varModalInp').addEventListener('keydown', function(e){ if(e.key==='Enter') resolveVar(q('varModalInp').value.trim()); });
  // Save
  q('btnSaveModalOk').addEventListener('click', doSaveModal);
  q('btnSaveModalCancel').addEventListener('click', function(){ q('saveModal').classList.remove('on'); });
  q('saveModalInp').addEventListener('keydown', function(e){ if(e.key==='Enter') doSaveModal(); });
  q('saveModal').addEventListener('click', function(e){ if(e.target===q('saveModal')) q('saveModal').classList.remove('on'); });
  // Delete
  q('btnDelYes').addEventListener('click', function(){ resolveDelModal(true); });
  q('btnDelNo').addEventListener('click',  function(){ resolveDelModal(false); });
  // Generate Document
  q('btnDocPdf').addEventListener('click', function(){ runDocGen(LPDoc.generatePDF, q('btnDocPdf')); });
  q('btnDocWord').addEventListener('click', function(){ runDocGen(LPDoc.generateDOCX, q('btnDocWord')); });
  q('btnDocGoogle').addEventListener('click', function(){ runDocGen(generateDocxAndOpenDrive, q('btnDocGoogle')); });
  q('btnDocConfluence').addEventListener('click', function(){
    if(!G.confluence){
      q('docModal').classList.remove('on');
      switchPane('settings',q('navSettings'));
      addLog('Set up Confluence in Settings first, then try publishing again.','inf');
      return;
    }
    runDocGen(publishToConfluence, q('btnDocConfluence'));
  });
  q('btnDocCancel').addEventListener('click', function(){ q('docModal').classList.remove('on'); });
  q('docModal').addEventListener('click', function(e){ if(e.target===q('docModal')) q('docModal').classList.remove('on'); });
  // Settings
  document.querySelectorAll('.tog').forEach(function(t){ t.addEventListener('click', function(){ t.classList.toggle('on'); G.settings[t.dataset.key]=t.classList.contains('on'); saveLocal({settings:G.settings}); }); });
  q('mdlSel').addEventListener('change', function(){ G.model=q('mdlSel').value; updateMdlPill(); saveLocal({model:G.model}); });
  document.querySelectorAll('.var-inp').forEach(function(inp){ inp.addEventListener('change', function(){ G.vars[inp.dataset.var]=inp.value.trim(); saveLocal({vars:G.vars}); detectVars(); }); });
  q('wfSearch').addEventListener('input', function(){ renderWfItems(q('wfSearch').value.trim()); });
  q('btnHistClear').addEventListener('click', function(){ showDel('Clear History','Remove all task history?').then(function(y){ if(!y) return; G.history=[]; saveLocal({history:G.history}); renderHistory(); }); });
  q('btnRecClear').addEventListener('click', function(){ showDel('Clear Recordings','Delete all recordings?').then(function(y){ if(!y) return; G.recordings=[]; saveLocal({recordings:G.recordings}); renderRecordings(); }); });
  q('btnEditRecBack').addEventListener('click', closeEditRecording);
  q('btnEditRecSave').addEventListener('click', saveEditedRecording);
  q('btnEditRecAdd').addEventListener('click', addEditStep);
  q('confType').addEventListener('change', updateConfluenceTypeUI);
  q('btnConfSave').addEventListener('click', saveConfluenceSettings);
  q('btnClear').addEventListener('click', clearAll);
}

// ── ONBOARDING ────────────────────────────────────────────────────────────────
function startOnboarding() { q('onboarding').classList.remove('hide'); obGoStep(1); }
function obGoStep(n) {
  ['ob-s1','ob-s2','ob-s3'].forEach(function(id,i){ q(id).style.display=(i+1===n)?'flex':'none'; q('obs'+(i+1)).classList.toggle('act',i+1<=n); });
}
function verifyApiKey() {
  var key=q('obApiInp').value.trim(); if(!key){ setObStatus('\u2717 Enter your API key','err'); return; }
  var btn=q('btnObVerify'); btn.disabled=true; btn.textContent='Verifying\u2026'; setObStatus('','');
  fetch('https://api.groq.com/openai/v1/models',{headers:{'Authorization':'Bearer '+key}}).then(function(r){
    if(r.ok){ G.apiKey=key; saveLocal({apiKey:key}); bannerOk(true); setObStatus('\u2713 Connected!','ok'); setTimeout(function(){obGoStep(3);},800); }
    else { setObStatus('\u2717 Invalid key — try again','err'); btn.disabled=false; btn.textContent='Verify & Continue \u2192'; }
  }).catch(function(){ setObStatus('\u2717 Network error','err'); btn.disabled=false; btn.textContent='Verify & Continue \u2192'; });
}
function setObStatus(txt,cls){ var el=q('obApiStatus'); el.textContent=txt; el.className='ob-api-status'+(cls?' '+cls:''); }
function finishOnboarding() { saveLocal({onboarded:true}); q('onboarding').classList.add('hide'); }

// ── API ───────────────────────────────────────────────────────────────────────
function toggleApiBox(){ var b=q('apiBox'); b.classList.toggle('on'); if(b.classList.contains('on')&&G.apiKey) q('apiInp').value=G.apiKey; }
function saveApiKey(){ var k=q('apiInp').value.trim(); if(!k) return; G.apiKey=k; saveLocal({apiKey:k}); bannerOk(true); q('apiBox').classList.remove('on'); }
function bannerOk(ok){ if(ok){q('apiBan').classList.add('ok');q('banTxt').textContent='\u2713 Groq API connected \u2014 Ready';}else{q('apiBan').classList.remove('ok');q('banTxt').textContent='Configure Groq API Key to start';} }

// ── CONFLUENCE ────────────────────────────────────────────────────────────────
function updateConfluenceTypeUI(){
  var isCloud=q('confType').value==='cloud';
  q('confEmailRow').style.display=isCloud?'':'none';
  q('confTokenLbl').textContent=isCloud?'API Token':'Personal Access Token';
  q('confToken').placeholder=isCloud?'from id.atlassian.com':'from your profile settings';
}
function loadConfluenceInputs(){
  var c=G.confluence; if(!c) return;
  q('confType').value=c.type||'cloud';
  q('confUrl').value=c.baseUrl||'';
  q('confEmail').value=c.email||'';
  q('confToken').value=c.token||'';
  q('confSpace').value=c.spaceKey||'';
  updateConfluenceTypeUI();
  q('confStatus').textContent='\u2713 Saved'; q('confStatus').className='conf-status ok';
}
function saveConfluenceSettings(){
  var type=q('confType').value;
  var baseUrl=q('confUrl').value.trim().replace(/\/+$/,'');
  var email=q('confEmail').value.trim();
  var token=q('confToken').value.trim();
  var spaceKey=q('confSpace').value.trim();
  var status=q('confStatus');
  if(!baseUrl||!/^https?:\/\//.test(baseUrl)){ status.textContent='Enter a full site URL (https://...)'; status.className='conf-status err'; return; }
  if(!token){ status.textContent='Enter your '+(type==='cloud'?'API token':'personal access token'); status.className='conf-status err'; return; }
  if(type==='cloud'&&!email){ status.textContent='Enter the email you use to sign in to Confluence'; status.className='conf-status err'; return; }
  if(!spaceKey){ status.textContent='Enter the space key to publish into'; status.className='conf-status err'; return; }
  G.confluence={type:type,baseUrl:baseUrl,email:email,token:token,spaceKey:spaceKey};
  saveLocal({confluence:G.confluence});
  status.textContent='\u2713 Saved'; status.className='conf-status ok';
}

// ── SMART VARIABLES ───────────────────────────────────────────────────────────
function detectVars() {
  var task=q('taskInput').value, found=[], matches=task.match(/\{\{([a-zA-Z0-9_]+)\}\}/g)||[];
  matches.forEach(function(m){var n=m.slice(2,-2);if(found.indexOf(n)===-1)found.push(n);});
  var row=q('varsRow'); row.innerHTML='';
  if(!found.length){row.classList.remove('on');return;} row.classList.add('on');
  found.forEach(function(name){var chip=document.createElement('span'),val=G.vars[name]; chip.className='var-chip'+(val?'':' unset'); chip.textContent='{{'+name+'}}'+(val?': '+val.slice(0,10):' (unset)'); chip.addEventListener('click',function(){promptVar(name);}); row.appendChild(chip);});
}
function promptVar(name){return new Promise(function(resolve){G.varResolve=resolve;q('varModalLabel').textContent='{{'+name+'}}';q('varModalInp').value=G.vars[name]||'';q('varModal').classList.add('on');q('varModalInp').focus();}).then(function(val){if(val){G.vars[name]=val;saveLocal({vars:G.vars});}loadVarInputs();detectVars();return val;});}
function resolveVar(val){q('varModal').classList.remove('on');if(G.varResolve){G.varResolve(val);G.varResolve=null;}}
function resolveTaskVars(task){var matches=task.match(/\{\{([a-zA-Z0-9_]+)\}\}/g)||[],unique=[];matches.forEach(function(m){if(unique.indexOf(m)===-1)unique.push(m);});if(!unique.length)return Promise.resolve(task);var chain=Promise.resolve(task);unique.forEach(function(m){var name=m.slice(2,-2);chain=chain.then(function(t){if(G.vars[name])return t.split(m).join(G.vars[name]);return promptVar(name).then(function(v){return v?t.split(m).join(v):t;});});});return chain;}
function loadVarInputs(){document.querySelectorAll('.var-inp').forEach(function(inp){inp.value=G.vars[inp.dataset.var]||'';});}

// ── HISTORY ───────────────────────────────────────────────────────────────────
function addToHistory(task){G.history=G.history.filter(function(h){return(typeof h==='string'?h:h.task)!==task;});G.history.unshift({task:task,time:new Date().toLocaleString()});if(G.history.length>20)G.history.length=20;saveLocal({history:G.history});renderHistory();}
function renderHistory(){var c=q('histList');if(!c)return;c.innerHTML='';if(!G.history.length){c.appendChild(mkEmpty('\uD83D\uDD51','No task history yet.'));return;}G.history.forEach(function(entry,idx){var text=typeof entry==='string'?entry:entry.task,time=typeof entry==='object'?entry.time:null;var row=document.createElement('div');row.className='hist-entry';var ico=document.createElement('div');ico.className='hist-ico';ico.textContent='\u26A1';var body=document.createElement('div');body.className='hist-body';var tx=document.createElement('div');tx.className='hist-text';tx.textContent=text;body.appendChild(tx);if(time){var ts=document.createElement('div');ts.className='hist-time';ts.textContent=time;body.appendChild(ts);}var del=document.createElement('button');del.className='hist-del';del.textContent='\u2715';del.addEventListener('click',function(e){e.stopPropagation();G.history.splice(idx,1);saveLocal({history:G.history});renderHistory();});row.appendChild(ico);row.appendChild(body);row.appendChild(del);row.addEventListener('click',function(){q('taskInput').value=text;switchPane('agent',q('navAgent'));q('taskInput').focus();detectVars();});c.appendChild(row);});}

// ── SESSION RECORDER ──────────────────────────────────────────────────────────
function toggleRecording(){if(G.isRecording)stopRecording();else startRecording();}

function startRecording(){
  G.isRecording=true;
  G.currentRecording={id:Date.now(),name:'Recording '+new Date().toLocaleTimeString(),actions:[],screenshots:[],startedAt:new Date().toISOString()};
  q('btnRecord').classList.add('rec-on');
  q('recIco').textContent='⏹';
  q('recLbl').textContent='Stop';
  q('recBadge').classList.add('on');
  q('feedBox').classList.add('on');
  addLog('Recording started. Interact with the page.','inf');
  // Clear the buffer in session storage
  chrome.runtime.sendMessage({type:'CLEAR_REC_BUFFER'});
  // Inject content script then START_RECORDING
  getActiveTab(function(tab){
    if(!tab) return;
    G.currentTabId=tab.id;
    // Always reinject to ensure latest recorder code is active
    chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']},function(){
      setTimeout(function(){
        chrome.tabs.sendMessage(tab.id,{type:'START_RECORDING'},function(){
          if(chrome.runtime.lastError) addLog('Warning: could not reach page (try refreshing)', 'err');
          else addLog('Recording active on: '+tab.url.slice(0,60), 'inf');
        });
      },200);
    });
  });
  // Poll session storage for new recorded actions (buffer written by background.js)
}

function flushRecBuffer(){} // no-op, replaced by direct message listener

// A full-page navigation (not just an SPA route change) tears down
// content.js's entire JS context — isRecording resets to false and its
// event listeners go with it. Without this, recording silently stops the
// moment the user clicks any link/button that does a real navigation (e.g.
// a "Home" link), even though the side panel still shows it as active.
// content.js's own START_RECORDING handler already no-ops if it's somehow
// already recording, so this can safely fire on every 'complete' with no
// extra dedup bookkeeping needed here.
chrome.tabs.onUpdated.addListener(function(tabId, info, tab){
  if(!G.isRecording || tabId!==G.currentTabId || info.status!=='complete') return;
  if(!tab.url || /^chrome(-extension)?:\/\//.test(tab.url)) return; // can't inject into privileged pages
  chrome.scripting.executeScript({target:{tabId:tabId},files:['content.js']},function(){
    if(chrome.runtime.lastError) return;
    setTimeout(function(){
      chrome.tabs.sendMessage(tabId,{type:'START_RECORDING',resumed:true},function(){});
    },250);
  });
});

// Receives RECORDED_ACTION re-broadcast from background.js
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type !== 'RECORDED_ACTION') return;
  if (!G.isRecording || !G.currentRecording) return;
  var action = msg.action;
  // Deduplicate rapid-fire events (same action+target within 100ms)
  var last = G.currentRecording._lastAction;
  if (last && last.action===action.action && last.target===action.target && (Date.now()-last.ts)<100) return;
  G.currentRecording._lastAction = {action:action.action, target:action.target, ts:Date.now()};
  // Don't record navigate if it's the same URL we already have
  if (action.action==='navigate') {
    var existing = G.currentRecording.actions.filter(function(a){return a.action==='navigate'&&a.target===action.target;});
    if (existing.length) return;
  }
  G.currentRecording.actions.push(action);
  var actionIndex = G.currentRecording.actions.length - 1;
  addLog('\u25CF [' + G.currentRecording.actions.length + '] ' + action.action + ': ' + (action.description||action.target||'').slice(0,50), 'inf');
  if (action.screenshot) {
    // content.js already captured this one itself, right after drawing the
    // marker and before the click/type could change anything \u2014 use it as-is.
    G.currentRecording.screenshots[actionIndex] = action.screenshot;
    return;
  }
  // No pre-captured shot (e.g. a standalone navigate with no recent
  // click/type behind it) \u2014 wait for the destination to settle before
  // capturing instead of grabbing one instantly, so this never coincidentally
  // shows a leftover click marker or a half-loaded page. Written by index
  // since a slow capture must not land out of order against a faster later one.
  var recAtCapture = G.currentRecording;
  var captureTabId = G.currentTabId;
  waitForPageQuiet(captureTabId).then(function(){
    chrome.runtime.sendMessage({type:'CAPTURE_SCREENSHOT', tabId:captureTabId}, function(r){
      if (chrome.runtime.lastError) return;
      if (r && r.url && recAtCapture) recAtCapture.screenshots[actionIndex] = r.url;
    });
  });
});

// Resolves once the recorded/automated tab's DOM has stopped mutating (or a
// hard ceiling elapses) \u2014 used to delay screenshot capture past loading
// skeletons/spinners instead of a flat guess. Falls back to resolving
// immediately if the content script can't be reached.
function waitForPageQuiet(tabId){
  return new Promise(function(resolve){
    if(!tabId){ resolve(); return; }
    var settled=false;
    var to=setTimeout(function(){ if(!settled){settled=true; resolve();} }, 3000);
    chrome.tabs.sendMessage(tabId,{type:'WAIT_QUIET',maxMs:2500,quietMs:500,minMs:600},function(){
      if(settled) return; settled=true; clearTimeout(to); resolve();
    });
  });
}

function stopRecording(){
  G.isRecording=false;
  q('btnRecord').classList.remove('rec-on');
  q('recIco').textContent='⏺';
  q('recLbl').textContent='Record';
  q('recBadge').classList.remove('on');
  // Final flush
  flushRecBuffer();
  getActiveTab(function(tab){
    if(tab) chrome.tabs.sendMessage(tab.id,{type:'STOP_RECORDING'},function(){if(chrome.runtime.lastError){}});
  });
  setTimeout(function(){
    if(!G.currentRecording||!G.currentRecording.actions.length){
      addLog('No actions captured.','inf'); G.currentRecording=null; return;
    }
    G.currentRecording.endedAt=new Date().toISOString();
    addLog('Done: '+G.currentRecording.actions.length+' actions captured.','done');
    G.savingRecording=true;
    q('saveModalTitle').textContent='Save Recording';
    q('saveModalDesc').textContent='Save it to replay later or generate a step-by-step document from it.';
    q('saveModalInp').value=G.currentRecording.name;
    q('saveModal').classList.add('on');
    setTimeout(function(){q('saveModalInp').focus();q('saveModalInp').select();},50);
  },600);
}

function saveRecording(name){
  G.currentRecording.name=name||G.currentRecording.name;
  var rec=Object.assign({},G.currentRecording);
  // Used to cap rec.screenshots at 15 without capping rec.actions to match \u2014
  // any recording past 15 steps then had more actions than screenshots, so
  // every later step's screenshot[i] silently pointed at the wrong action
  // (or nothing, for the last ones). Screenshots are downscaled at capture
  // time now and storage has unlimitedStorage, so the per-recording cap on
  // *recordings* below is the real defense \u2014 actions and screenshots just
  // stay the same length, always.
  G.recordings.unshift(rec);
  if(G.recordings.length>20) G.recordings.length=20;
  saveLocal({recordings:G.recordings});
  G.currentRecording=null;
  renderRecordings();
  addLog('\uD83D\uDCBE Recording saved: "'+rec.name+'"','done');
}

function renderRecordings(){
  var c=q('recList');if(!c)return;c.innerHTML='';
  if(!G.recordings.length){c.appendChild(mkEmpty('\uD83C\uDFAC','No recordings yet.\nPress \u23FA to record a session.'));return;}
  G.recordings.forEach(function(rec,ri){
    var item=document.createElement('div');item.className='rec-item';
    var hd=document.createElement('div');hd.className='rec-item-hd';
    var ico=document.createElement('div');ico.className='rec-item-ico';ico.textContent='\uD83C\uDFAC';
    var info=document.createElement('div');info.className='rec-item-info';
    var nm=document.createElement('div');nm.className='rec-item-name';nm.textContent=rec.name;
    var mt=document.createElement('div');mt.className='rec-item-meta';mt.textContent=rec.actions.length+' steps \u00B7 '+new Date(rec.startedAt).toLocaleDateString();
    info.appendChild(nm);info.appendChild(mt);
    var acts=document.createElement('div');acts.className='rec-item-acts';
    function mkB(txt,cls,title,fn){var b=document.createElement('button');b.className='wf-btn'+(cls?' '+cls:'');b.textContent=txt;b.title=title;b.addEventListener('click',function(e){e.stopPropagation();fn();});return b;}
    acts.appendChild(mkB('\u25B6','play','Play this recording',function(){openPlayUI(rec,item);}));
    acts.appendChild(mkB('\u270E','edit','Edit steps \u2014 rewrite text, reorder, delete, or add new ones',function(){openEditRecording(ri);}));
    acts.appendChild(mkB('\uD83D\uDCC4','doc','Generate a PDF or Word document with screenshots',function(){openDocModal(LPDoc.fromRecording(rec));}));
    acts.appendChild(mkB('\u2715','del','Delete this recording',function(){G.recordings.splice(ri,1);saveLocal({recordings:G.recordings});renderRecordings();}));
    hd.addEventListener('click',function(){var tl=item.querySelector('.rec-tl');tl.classList.toggle('open');});
    hd.appendChild(ico);hd.appendChild(info);hd.appendChild(acts);
    var tl=document.createElement('div');tl.className='rec-tl';
    rec.actions.forEach(function(a,ai){
      var row=document.createElement('div');row.className='rtl-step';
      var n=document.createElement('div');n.className='rtl-n';n.textContent=ai+1;
      var at=document.createElement('div');at.className='rtl-act';at.textContent=a.action;
      var tgt=document.createElement('div');tgt.className='rtl-tgt';tgt.textContent=a.target||a.value||'';
      row.appendChild(n);row.appendChild(at);row.appendChild(tgt);
      if(rec.screenshots&&rec.screenshots[ai]){var ss=document.createElement('div');ss.className='rtl-ss';var img=document.createElement('img');img.src=rec.screenshots[ai];img.alt='';ss.appendChild(img);ss.addEventListener('click',function(){openSsModal('Step '+(ai+1),rec.screenshots[ai]);});row.appendChild(ss);}
      tl.appendChild(row);
    });
    item.appendChild(hd);item.appendChild(tl);c.appendChild(item);
  });
}

// ── EDIT RECORDING ──────────────────────────────────────────────────────────
// Works on a scratch copy (EDIT.actions/screenshots) so closing without
// saving leaves the stored recording untouched.
var EDIT={recIndex:-1,actions:[],screenshots:[]};

function openEditRecording(ri){
  var rec=G.recordings[ri]; if(!rec) return;
  EDIT.recIndex=ri;
  EDIT.actions=rec.actions.map(function(a){return Object.assign({},a);});
  EDIT.screenshots=(rec.screenshots||[]).slice();
  q('editRecTitle').textContent='Edit: '+rec.name;
  renderEditSteps();
  q('editRecOv').classList.add('on');
}

function closeEditRecording(){
  q('editRecOv').classList.remove('on');
  EDIT.recIndex=-1;EDIT.actions=[];EDIT.screenshots=[];
}

function saveEditedRecording(){
  if(EDIT.recIndex<0) return;
  var rec=G.recordings[EDIT.recIndex]; if(!rec) return;
  rec.actions=EDIT.actions;
  rec.screenshots=EDIT.screenshots;
  saveLocal({recordings:G.recordings});
  addLog('💾 Recording updated: "'+rec.name+'"','done');
  renderRecordings();
  closeEditRecording();
}

function renderEditSteps(){
  var c=q('editRecList'); c.innerHTML='';
  if(!EDIT.actions.length){ c.appendChild(mkEmpty('📝','No steps yet — add one below.')); return; }
  EDIT.actions.forEach(function(a,i){
    var card=document.createElement('div'); card.className='edit-step';

    var thumb=document.createElement('div'); thumb.className='edit-step-thumb';
    if(EDIT.screenshots[i]){
      var img=document.createElement('img'); img.src=EDIT.screenshots[i]; img.alt='';
      thumb.appendChild(img); thumb.title='Click to view full size';
      thumb.addEventListener('click',function(){openSsModal('Step '+(i+1),EDIT.screenshots[i]);});
    } else {
      thumb.textContent='📷'; thumb.title='Capture the current tab for this step';
      thumb.addEventListener('click',function(){
        chrome.runtime.sendMessage({type:'CAPTURE_SCREENSHOT'},function(r){
          if(r&&r.url){ EDIT.screenshots[i]=r.url; renderEditSteps(); }
        });
      });
    }

    var body=document.createElement('div'); body.className='edit-step-body';
    var badge=document.createElement('div'); badge.className='edit-step-badge';
    badge.textContent=(i+1)+' · '+(LPDoc.humanizeAction(a.action)||a.action);
    var txt=document.createElement('textarea'); txt.className='edit-step-txt'; txt.rows=2;
    txt.value=a.description||''; txt.placeholder='Describe this step…';
    txt.addEventListener('input',function(){ a.description=txt.value; a.edited=true; });
    body.appendChild(badge); body.appendChild(txt);

    var stepActs=document.createElement('div'); stepActs.className='edit-step-acts';
    function mkB(label,title,fn){ var b=document.createElement('button'); b.className='edit-step-btn'; b.textContent=label; b.title=title; b.addEventListener('click',fn); return b; }
    if(i>0) stepActs.appendChild(mkB('▲','Move up',function(){ moveEditStep(i,-1); }));
    if(i<EDIT.actions.length-1) stepActs.appendChild(mkB('▼','Move down',function(){ moveEditStep(i,1); }));
    var delBtn=mkB('✕','Delete this step',function(){ deleteEditStep(i); }); delBtn.classList.add('del');
    stepActs.appendChild(delBtn);

    card.appendChild(thumb); card.appendChild(body); card.appendChild(stepActs);
    c.appendChild(card);
  });
}

function moveEditStep(i,dir){
  var j=i+dir; if(j<0||j>=EDIT.actions.length) return;
  var a=EDIT.actions, s=EDIT.screenshots;
  var ta=a[i]; a[i]=a[j]; a[j]=ta;
  var ts=s[i]; s[i]=s[j]; s[j]=ts;
  renderEditSteps();
}

function deleteEditStep(i){
  EDIT.actions.splice(i,1);
  EDIT.screenshots.splice(i,1);
  renderEditSteps();
}

function addEditStep(){
  EDIT.actions.push({action:'note',target:'',value:'',sensitive:false,description:'',edited:true});
  EDIT.screenshots.push(null);
  renderEditSteps();
  var areas=q('editRecList').querySelectorAll('.edit-step-txt');
  if(areas.length) areas[areas.length-1].focus();
}

function openPlayUI(rec,item){
  var old=item.querySelector('.play-ctrl');if(old){old.remove();return;}
  var ctrl=document.createElement('div');ctrl.className='play-ctrl';
  var ir=document.createElement('div');ir.className='iter-row';
  var il=document.createElement('span');il.textContent='Iterations:';
  var ii=document.createElement('input');ii.className='iter-inp';ii.type='number';ii.value='1';ii.min='1';ii.max='100';
  var dl=document.createElement('span');dl.textContent='Delay (ms):';
  var di=document.createElement('input');di.className='iter-inp';di.type='number';di.value='400';di.min='0';di.max='5000';
  ir.appendChild(il);ir.appendChild(ii);ir.appendChild(dl);ir.appendChild(di);
  var pr=document.createElement('div');pr.className='play-row';
  var slider=document.createElement('input');slider.type='range';slider.className='play-slider';slider.min='0';slider.max=rec.actions.length-1;slider.value='0';
  var timeEl=document.createElement('span');timeEl.className='play-time';timeEl.textContent='0/'+rec.actions.length;
  slider.addEventListener('input',function(){timeEl.textContent=parseInt(slider.value)+'/'+rec.actions.length;});
  var pb=document.createElement('button');pb.className='btn-play';pb.textContent='\u25B6 Play';
  pb.addEventListener('click',function(){
    var iters=Math.max(1,parseInt(ii.value)||1),delay=Math.max(0,parseInt(di.value)||400),from=parseInt(slider.value)||0;
    pb.disabled=true;pb.textContent='\u23F3\u2026';
    playRecording(rec,iters,delay,from,slider,timeEl).then(function(){pb.disabled=false;pb.textContent='\u25B6 Play';});
  });
  pr.appendChild(slider);pr.appendChild(timeEl);pr.appendChild(pb);
  ctrl.appendChild(ir);ctrl.appendChild(pr);item.appendChild(ctrl);
}

function playRecording(rec,iterations,delay,from,slider,timeEl){
  addLog('\u25B6 Playing "'+rec.name+'" \u00D7'+iterations,'done');
  q('feedBox').classList.add('on');
  var chain=Promise.resolve();
  for(var it=0;it<iterations;it++){
    (function(i){
      chain=chain.then(function(){
        if(iterations>1) addLog('Iteration '+(i+1)+'/'+iterations,'inf');
        return playSteps(rec,from,delay,slider,timeEl);
      });
      if(i<iterations-1&&delay>0) chain=chain.then(function(){return sleep(delay);});
    })(it);
  }
  return chain.then(function(){addLog('\u2713 Playback complete.','done');});
}

function playSteps(rec,from,delay,slider,timeEl){
  var chain=Promise.resolve();
  rec.actions.forEach(function(action,ai){
    if(ai<from) return;
    chain=chain.then(function(){
      if(slider){slider.value=ai;if(timeEl)timeEl.textContent=(ai+1)+'/'+rec.actions.length;}
      addLog('\u2192 ['+(ai+1)+'] '+action.action+': '+(action.target||'').slice(0,40),'run');
      return doAction(G.currentTabId||0,action).then(function(r){
        if(r&&r.error){
          addLog('\u2717 '+r.error,'err');
          return healStep(G.currentTabId,action,r.error,'playback').then(function(h){
            if(h&&!h.error) addLog('\u2713 Healed','heal'); else addLog('\u26A0 Heal failed','inf');
          });
        } else { addLog('\u2713 '+(action.description||action.action),'done'); }
        return delay>0?sleep(delay):Promise.resolve();
      });
    });
  });
  return chain;
}

// ── DOCUMENT GENERATION (PDF / DOCX step guide) ───────────────────────────────
function openDocModal(guide){
  G.pendingGuide=guide;
  q('docModalTitle').textContent='Generate Document — '+(guide.steps.length)+' step'+(guide.steps.length===1?'':'s');
  q('docModal').classList.add('on');
}

function runDocGen(genFn,btn){
  if(!G.pendingGuide) return;
  var orig=btn.innerHTML;
  btn.disabled=true; btn.textContent='⏳ Generating…';
  genFn(G.pendingGuide).then(function(){
    q('docModal').classList.remove('on');
    addLog('📄 Document generated: "'+G.pendingGuide.title+'"','done');
  }).catch(function(e){
    addLog('✗ Document generation failed: '+e.message,'err');
  }).then(function(){
    btn.disabled=false; btn.innerHTML=orig;
  });
}

// No Drive API / OAuth wired up (that needs a Google Cloud Client ID this
// extension doesn't have) — the practical alternative: download the .docx
// and open Drive so the user can just drag it in. Drive auto-converts a
// dropped .docx into a native, editable Google Doc.
function generateDocxAndOpenDrive(guide){
  return LPDoc.generateDOCX(guide).then(function(){
    chrome.tabs.create({url:'https://drive.google.com/drive/my-drive'});
    addLog('📤 Drag the downloaded .docx into the new Google Drive tab — it\'ll convert it to a Google Doc automatically.','inf');
  });
}

// Confluence (unlike Google Docs) takes a real API token with no OAuth app
// needed, so this is an actual publish — not a download-and-drag workaround.
// All the network calls happen in background.js (CONFLUENCE_PUBLISH), since
// host_permissions already cover any origin and a service worker isn't
// bound by page-level CORS the way this side panel's own fetch would be.
function publishToConfluence(guide){
  var doc = LPDoc.toConfluenceStorage(guide);
  return new Promise(function(resolve,reject){
    chrome.runtime.sendMessage({type:'CONFLUENCE_PUBLISH', config:G.confluence, doc:doc}, function(r){
      if(chrome.runtime.lastError){ reject(new Error(chrome.runtime.lastError.message)); return; }
      if(r&&r.error){ reject(new Error(r.error)); return; }
      if(r&&r.url) chrome.tabs.create({url:r.url});
      resolve();
    });
  });
}

// ── TIMER ─────────────────────────────────────────────────────────────────────
function startTimer(){G.startTime=Date.now();G.timerInterval=setInterval(function(){q('feedTimer').textContent=((Date.now()-G.startTime)/1000).toFixed(0)+'s';},1000);}
function stopTimer(){clearInterval(G.timerInterval);G.timerInterval=null;if(G.startTime)q('feedTimer').textContent=((Date.now()-G.startTime)/1000).toFixed(1)+'s';}

// ── COPY / EXPORT ─────────────────────────────────────────────────────────────
function copyLog(){navigator.clipboard.writeText(G.log.map(function(l){return '['+l.time+'] '+l.text;}).join('\n')).then(function(){q('btnCopyLog').textContent='Copied!';setTimeout(function(){q('btnCopyLog').textContent='Copy';},1500);});}

function exportCSV(){
  if(!G.extractedData.length){copyResult();return;}
  var rows=['#,Text,URL'];
  G.extractedData.forEach(function(d,i){
    var txt='"'+(d.text||'').replace(/"/g,'""')+'"';
    var url='"'+(d.href||'').replace(/"/g,'""')+'"';
    rows.push((i+1)+','+txt+','+url);
  });
  var blob=new Blob([rows.join('\n')],{type:'text/csv'});
  var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='livepilot-extract.csv';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}

function exportTxt(){
  var lines=[];
  if(G.extractedData.length){
    G.extractedData.forEach(function(d,i){var line=(i+1)+'. '+d.text;if(d.href)line+=' <'+d.href+'>';lines.push(line);});
  } else {
    lines.push(q('rtSummary').textContent||'No data');
  }
  var blob=new Blob([lines.join('\n')],{type:'text/plain'});
  var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='livepilot-extract.txt';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}

function copyResult(){
  var txt=G.extractedData.length?G.extractedData.map(function(d,i){return(i+1)+'. '+d.text+(d.href?' <'+d.href+'>':'');}).join('\n'):(q('rtSummary').textContent||'');
  navigator.clipboard.writeText(txt).then(function(){q('btnCopyResult').textContent='Copied!';setTimeout(function(){q('btnCopyResult').textContent='Copy';},1500);});
}

function switchResultTab(tab){
  document.querySelectorAll('.result-tab').forEach(function(t){t.classList.toggle('on',t.dataset.rt===tab);});
  ['summary','table','raw'].forEach(function(id){
    var el=q('rt'+id.charAt(0).toUpperCase()+id.slice(1)); if(el) el.style.display=id===tab?'block':'none';
  });
}

function showResultPanel(summary){
  var count = G.extractedData.length;
  // Summary tab
  q('rtSummary').textContent = summary || 'Task completed.';
  // Update count badge
  var badge = q('resultCount');
  if (badge) badge.textContent = count ? '(' + count + ' item' + (count===1?'':'s') + ')' : '';
  // Table tab — render ALL rows
  var tbody = q('rtTbody');
  tbody.innerHTML = '';
  G.extractedData.forEach(function(d, i){
    var tr  = document.createElement('tr');
    var td0 = document.createElement('td'); td0.textContent = i + 1;
    var td1 = document.createElement('td'); td1.textContent = d.text;
    var td2 = document.createElement('td');
    if(d.href){
      var a = document.createElement('a');
      a.href = d.href; a.textContent = 'link'; a.target = '_blank';
      a.title = d.href;
      td2.appendChild(a);
    }
    tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2);
    tbody.appendChild(tr);
  });
  // Raw tab — ALL items
  var rawLines = G.extractedData.map(function(d, i){
    return (i+1) + '. ' + d.text + (d.href ? ' <' + d.href + '>' : '');
  });
  if(summary) rawLines.unshift('=== SUMMARY ===\n' + summary + '\n\n=== EXTRACTED DATA (' + count + ' items) ===');
  q('rtRawEl').textContent = rawLines.join('\n');
  switchResultTab('summary');
  q('resultBox').classList.add('on');
}

// ── TASK START ────────────────────────────────────────────────────────────────
function startTask(){
  if(!G.apiKey){toggleApiBox();return;}
  var raw=q('taskInput').value.trim();if(!raw){q('taskInput').focus();return;}
  if(G.running) return;
  resolveTaskVars(raw).then(function(task){
    if(!task) return;
    G.running=true;G.aborted=false;G.shots=[];G.log=[];G.done=0;G.total=0;G.plan=null;G.extractedData=[];G.lastTask=task;
    resetFeed();setRunning(true);
    q('feedBox').classList.add('on');q('feedLive').hidden=false;q('btnStop').hidden=false;q('btnCopyLog').hidden=false;
    startTimer();addLog('Planning\u2026','inf');addToHistory(raw);
    getActiveTab(function(tab){
      if(!tab){addLog('No active tab.','err');onFinish(null);return;}
      G.currentTabId=tab.id;planWithContext(task,tab);
    });
  });
}

function getActiveTab(cb){chrome.tabs.query({active:true,currentWindow:true},function(tabs){cb(tabs&&tabs.length?tabs[0]:null);});}

// ── PLANNING ──────────────────────────────────────────────────────────────────
function planWithContext(task,tab){
  getDOMSnapshot(tab.id,function(snap){
    var ctx=buildCtx(snap);
    generatePlan(task,ctx).then(function(plan){
      if(!plan||G.aborted){onAbort();return;}
      G.plan=plan;G.total=plan.length;
      var next=G.settings.planning?showPlan(plan):Promise.resolve(true);
      next.then(function(ok){
        if(!ok||G.aborted){onAbort();return;}
        q('progWrap').hidden=false;setProgress(0,plan.length);
        addLog('\u25B6 '+plan.length+' steps','inf');
        runSteps(task,plan,tab.id,0);
      });
    });
  });
}

function getDOMSnapshot(tabId,cb){chrome.tabs.sendMessage(tabId,{type:'DOM_SNAPSHOT',opts:{limit:60}},function(r){if(chrome.runtime.lastError||!r){cb(null);return;}cb(r);});}

function buildCtx(snap){
  if(!snap) return '';
  var lines=['','PAGE CONTEXT (use these selectors):','URL: '+snap.url,'Title: '+snap.title];
  if(snap.inputs&&snap.inputs.length){lines.push('INPUTS:');snap.inputs.forEach(function(el){var p='sel="'+el.sel+'"';if(el.type)p+=' type="'+el.type+'"';if(el.placeholder)p+=' ph="'+el.placeholder+'"';if(el.ariaLabel)p+=' aria="'+el.ariaLabel+'"';lines.push('  <'+el.tag+' '+p+'/>');});}
  if(snap.buttons&&snap.buttons.length){lines.push('BUTTONS:');snap.buttons.forEach(function(b){lines.push('  sel="'+b.sel+'" text="'+b.text+'"');});}
  if(snap.forms&&snap.forms.length){lines.push('FORMS:');snap.forms.forEach(function(f){f.fields.forEach(function(fi){lines.push('  <'+fi.tag+' sel="'+fi.sel+'"'+(fi.placeholder?' ph="'+fi.placeholder+'"':'')+'/>')});});}
  return lines.join('\n');
}

function generatePlan(task,ctx){
  var sys=['You are LivePilot, a browser automation AI. Return ONLY a raw JSON array, no markdown, no fences.','Each item: step(int), action(navigate|click|type|press_enter|scroll|extract|wait|get_text|get_url), description(str), target(str), value(str), sensitive(bool)','Rules: navigate=full https URL; after navigate add wait 2000; after type in search add press_enter; use selectors from PAGE CONTEXT; for extract use CSS selectors that match multiple items; description is a short imperative instruction like "Click the search button", not past tense like "Clicked the search button".',ctx||''].join('\n');
  return groq(sys,task).then(function(raw){
    if(!raw) return null;
    try{var clean=raw.replace(/```json|```/gi,'').trim();var m=clean.match(/\[[\s\S]*\]/);if(!m)throw new Error('No array');var plan=JSON.parse(m[0]);if(!Array.isArray(plan)||!plan.length)throw new Error('Empty');plan.forEach(function(s){if(s.target===undefined)s.target='';if(s.value===undefined)s.value='';if(s.sensitive===undefined)s.sensitive=false;});return plan;}
    catch(e){addLog('Plan parse: '+e.message,'err');return null;}
  });
}

function showPlan(plan){return new Promise(function(resolve){G.planResolve=resolve;var c=q('planSteps');c.innerHTML='';plan.forEach(function(s){var row=document.createElement('div');row.className='ps';var n=document.createElement('div');n.className='ps-n';n.textContent=s.step;var d=document.createElement('div');d.style.flex='1';d.textContent=s.description+(s.target?' ['+s.target.slice(0,25)+']':'');row.appendChild(n);row.appendChild(d);if(s.sensitive){var w=document.createElement('span');w.className='ps-warn';w.textContent='\u26A0';row.appendChild(w);}c.appendChild(row);});q('planBox').classList.add('on');});}
function resolvePlan(ok){q('planBox').classList.remove('on');if(G.planResolve){G.planResolve(ok);G.planResolve=null;}}

// ── STEP EXECUTION ────────────────────────────────────────────────────────────
function runSteps(task,plan,tabId,i){
  if(G.aborted){onAbort();return;}
  if(i>=plan.length){finalizeSummary(task,plan);return;}
  var step=plan[i];
  addLog('\u2192 '+(i+1)+'/'+plan.length+': '+step.description,'run');
  if(step.sensitive&&G.settings.hitl){askConf(step.description).then(function(ok){if(!ok){addLog('\u21B7 Skipped','inf');G.done=i+1;setProgress(G.done,G.total);runSteps(task,plan,tabId,i+1);return;}execStep(task,plan,tabId,i,step);});}
  else execStep(task,plan,tabId,i,step);
}

// Actions where content.js highlights a specific element before acting on it
// and, as part of the same EXEC call, captures+returns the screenshot taken
// the instant before the click/type fires — see captureNow() in content.js.
var HIGHLIGHT_ACTIONS = {click:1, type:1, press_enter:1};

function execStep(task,plan,tabId,i,step){
  doAction(tabId,step).then(function(r){
    if(r&&r.screenshot){G.shots[i]={step:i+1,url:r.screenshot};addThumb(r.screenshot,i+1);}
    if(r&&r.error){
      addLog('\u2717 '+r.error,'err');
      healStep(tabId,step,r.error,task).then(function(h){
        if(h&&!h.error){
          addLog('\u2713 Healed','heal');accumulateData(h);
          // The healed retry re-runs the same click/type — its own pre-action
          // screenshot is the correct one for this step (the original attempt
          // never got far enough to capture one). Without this, the slot for
          // this step stays empty, which previously could misalign every
          // later step's screenshot when matched up against the document.
          if(h.screenshot){G.shots[i]={step:i+1,url:h.screenshot};addThumb(h.screenshot,i+1);}
        }
        else addLog('\u26A0 Heal failed','inf');
        afterStep(task,plan,tabId,i);
      });
    } else {addLog('\u2713 '+step.description,'done');accumulateData(r);afterStep(task,plan,tabId,i);}
  }).catch(function(e){addLog('\u2717 '+e.message,'err');afterStep(task,plan,tabId,i);});
}

// Accumulate extracted data globally so export works
function accumulateData(r){
  if(!r) return;
  if(r.data && r.data.length){
    r.data.forEach(function(d){ if(d && d.text) G.extractedData.push(d); });
    // Log summary for large results, individual items for small ones
    if(r.data.length > 10){
      addLog('\u00B7 Extracted ' + r.data.length + ' items (showing first 5 in log)', 'inf');
      r.data.slice(0,5).forEach(function(d){ if(d&&d.text) addLog('  ' + d.text.slice(0,80), 'inf'); });
      addLog('  \u2026 and ' + (r.data.length-5) + ' more — see Table/Raw view below', 'inf');
    } else {
      r.data.forEach(function(d){ if(d&&d.text) addLog('\u00B7 '+d.text.slice(0,90)+(d.href?' \u2192'+d.href.slice(0,40):''),'inf'); });
    }
  }
  if(r.text){ G.extractedData.push({text:r.text}); addLog('\u00B7 '+r.text.slice(0,90),'inf'); }
}

function afterStep(task,plan,tabId,i){
  G.done=i+1;setProgress(G.done,G.total);
  if(!G.settings.screenshots){runSteps(task,plan,tabId,i+1);return;}
  var step=plan[i];
  if(HIGHLIGHT_ACTIONS[step.action]){
    // Screenshot was already captured pre-action inside the EXEC call itself
    // (see execStep above) — capturing again here would just show whatever
    // the click/type led to (possibly mid-navigation or mid-AJAX-reload),
    // overwriting the correct one.
    runSteps(task,plan,tabId,i+1);
    return;
  }
  waitForPageQuiet(tabId).then(function(){
    chrome.runtime.sendMessage({type:'CAPTURE_SCREENSHOT', tabId:tabId},function(r){
      if(r&&r.url){G.shots[i]={step:i+1,url:r.url};addThumb(r.url,i+1);}
      runSteps(task,plan,tabId,i+1);
    });
  });
}

function finalizeSummary(task,plan){
  addLog('Generating summary\u2026','inf');
  var extracted=G.extractedData.map(function(d,i){return(i+1)+'. '+d.text+(d.href?' <'+d.href+'>':'');}).slice(0,20).join('\n');
  var prompt='Task: '+task+'\nSteps: '+G.done+'/'+plan.length+(extracted?'\nExtracted:\n'+extracted:'');
  groq('Summarise what was accomplished in 2-3 sentences. List key extracted items if any.',prompt).then(function(sum){onFinish(sum);});
}

// ── AI HEALING ────────────────────────────────────────────────────────────────
function healStep(tabId,failedStep,errorMsg,task){
  addLog('\u27F3 Healing\u2026','heal');
  return new Promise(function(resolve){
    getDOMSnapshot(tabId,function(snap){
      if(!snap){chrome.scripting.executeScript({target:{tabId:tabId},files:['content.js']},function(){setTimeout(function(){getDOMSnapshot(tabId,function(s2){doHeal(tabId,failedStep,errorMsg,task,s2,resolve);});},500);});return;}
      doHeal(tabId,failedStep,errorMsg,task,snap,resolve);
    });
  });
}

function doHeal(tabId,failedStep,errorMsg,task,snap,resolve){
  var lines=['URL: '+(snap?snap.url:'unknown'),'Title: '+(snap?snap.title:'')];
  if(snap){
    try{lines.push('SITE: '+new URL(snap.url).hostname);}catch(e){}
    if(snap.inputs&&snap.inputs.length){lines.push('INPUTS:');snap.inputs.forEach(function(el){var p=['sel="'+el.sel+'"'];if(el.type)p.push('type="'+el.type+'"');if(el.placeholder)p.push('ph="'+el.placeholder+'"');if(el.ariaLabel)p.push('aria="'+el.ariaLabel+'"');if(el.name)p.push('name="'+el.name+'"');lines.push('  <'+el.tag+' '+p.join(' ')+'/>');});}
    if(snap.buttons&&snap.buttons.length){lines.push('BUTTONS:');snap.buttons.forEach(function(b){lines.push('  sel="'+b.sel+'" text="'+b.text+'"');});}
    if(snap.forms&&snap.forms.length){lines.push('FORMS:');snap.forms.forEach(function(f){f.fields.forEach(function(fi){lines.push('  <'+fi.tag+' sel="'+fi.sel+'"'+(fi.placeholder?' ph="'+fi.placeholder+'"':'')+'>');});});}
    if(snap.links&&snap.links.length){lines.push('LINKS:');snap.links.slice(0,6).forEach(function(l){lines.push('  sel="'+l.sel+'" text="'+l.text+'"');});}
  }
  var prompt=['Task: '+task,'Failed: '+JSON.stringify(failedStep),'Error: '+errorMsg,'','DOM:',lines.join('\n'),'','Return ONE fixed JSON step (step,action,description,target,value,sensitive).','Use a selector from DOM above. No markdown. JSON only.'].join('\n');
  groq('Fix browser automation selectors using real DOM. Return JSON only.',prompt).then(function(raw){
    if(!raw){resolve({error:'No response'});return;}
    try{var clean=raw.replace(/```json|```/gi,'').trim();var m=clean.match(/\{[\s\S]*?\}/);if(!m){resolve({error:'No JSON'});return;}var h=JSON.parse(m[0]);if(!h.action){resolve({error:'Bad step'});return;}addLog('\u27F3 Retry: "'+h.target+'"','heal');
    doAction(tabId,h).then(function(r){if(r&&r.error){var alt={step:h.step,action:h.action,description:h.description,target:failedStep.description,value:h.value||'',sensitive:false};doAction(tabId,alt).then(resolve).catch(function(e){resolve({error:e.message});});}else resolve(r);}).catch(function(e){resolve({error:e.message});});}catch(e){resolve({error:'Parse: '+e.message});}
  });
}

// ── ACTION DISPATCH ───────────────────────────────────────────────────────────
function doAction(tabId,step){
  if(!tabId) return Promise.resolve({error:'No tab'});
  if(step.action==='navigate') return doNavigate(tabId,step.target);
  if(step.action==='wait') return sleep(Math.min(parseInt(step.value)||1500,8000)).then(function(){return{success:true};});
  return new Promise(function(resolve){
    chrome.tabs.sendMessage(tabId,{type:'EXEC',step:step},function(r){
      if(chrome.runtime.lastError){
        chrome.scripting.executeScript({target:{tabId:tabId},files:['content.js']},function(){
          if(chrome.runtime.lastError){resolve({error:chrome.runtime.lastError.message});return;}
          setTimeout(function(){chrome.tabs.sendMessage(tabId,{type:'EXEC',step:step},function(r2){if(chrome.runtime.lastError)resolve({error:chrome.runtime.lastError.message});else resolve(r2||{error:'Empty'});});},350);
        });
      } else resolve(r||{error:'Empty'});
    });
  });
}

function doNavigate(tabId,url){
  return new Promise(function(resolve){
    chrome.tabs.update(tabId,{url:url},function(){
      if(chrome.runtime.lastError){resolve({error:chrome.runtime.lastError.message});return;}
      var done=false;
      var to=setTimeout(function(){if(done)return;done=true;chrome.tabs.onUpdated.removeListener(fn);chrome.scripting.executeScript({target:{tabId:tabId},files:['content.js']},function(){resolve({success:true});});},12000);
      function fn(id,info){if(id===tabId&&info.status==='complete'&&!done){done=true;clearTimeout(to);chrome.tabs.onUpdated.removeListener(fn);setTimeout(function(){chrome.scripting.executeScript({target:{tabId:tabId},files:['content.js']},function(){resolve({success:true});});},800);}}
      chrome.tabs.onUpdated.addListener(fn);
    });
  });
}

// ── GROQ ──────────────────────────────────────────────────────────────────────
function groq(sys,user){
  if(!G.apiKey) return Promise.resolve(null);
  return fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+G.apiKey},body:JSON.stringify({model:G.model,messages:[{role:'system',content:sys},{role:'user',content:user}],temperature:0.1,max_tokens:2048})})
  .then(function(res){if(!res.ok)return res.json().then(function(e){throw new Error(e&&e.error&&e.error.message?e.error.message:'HTTP '+res.status);});return res.json();})
  .then(function(d){return(d&&d.choices&&d.choices[0]&&d.choices[0].message)?d.choices[0].message.content.trim():null;})
  .catch(function(e){addLog('Groq: '+e.message,'err');return null;});
}

// ── UI ────────────────────────────────────────────────────────────────────────
function addLog(text,type){var icons={done:'\u2713',run:'\u2192',err:'\u2717',inf:'\u00B7',heal:'\u27F3'};var time=new Date().toTimeString().slice(0,8);var el=document.createElement('div');el.className='fi '+type;var ic=document.createElement('span');ic.className='fi-ic';ic.textContent=icons[type]||'\u00B7';var tx=document.createElement('span');tx.className='fi-tx';tx.textContent=text;var ts=document.createElement('span');ts.className='fi-ts';ts.textContent=time;el.appendChild(ic);el.appendChild(tx);el.appendChild(ts);var log=q('feedLog');log.appendChild(el);log.scrollTop=log.scrollHeight;G.log.push({text:text,type:type,time:time});}
function addThumb(url,num){var s=q('ssStrip');s.hidden=false;var d=document.createElement('div');d.className='ss-th';var img=document.createElement('img');img.src=url;img.alt='step '+num;var n=document.createElement('span');n.className='ss-n';n.textContent=num;d.appendChild(img);d.appendChild(n);d.addEventListener('click',function(){openSsModal('Step '+num,url);});s.appendChild(d);s.scrollLeft=s.scrollWidth;}
function resetFeed(){q('feedLog').innerHTML='';q('ssStrip').innerHTML='';q('ssStrip').hidden=true;q('progFill').style.width='0%';q('progWrap').hidden=true;q('planBox').classList.remove('on');q('feedBox').classList.remove('on');q('resultBox').classList.remove('on');q('feedTimer').textContent='';q('btnCopyLog').hidden=true;q('btnStop').hidden=true;}
function clearTaskAndLog(){
  // Clear the textarea
  q('taskInput').value = '';
  q('taskInput').focus();
  q('varsRow').innerHTML = '';
  q('varsRow').classList.remove('on');
  // Reset feed, results, plan
  resetFeed();
  // Clear in-memory state so next run starts fresh
  G.log = [];
  G.shots = [];
  G.extractedData = [];
  G.plan = null;
  G.done = 0;
  G.total = 0;
  // Clear extracted data display
  if (q('rtTbody')) q('rtTbody').innerHTML = '';
  if (q('rtRawEl')) q('rtRawEl').textContent = '';
  if (q('rtSummary')) q('rtSummary').textContent = '';
}


function setProgress(done,total){if(total>0)q('progFill').style.width=Math.round(done/total*100)+'%';}
function setRunning(on){q('btnRun').disabled=on;var ico=q('runIco');ico.textContent=on?'\u21BB':'\u25B6';ico.style.animation=on?'spin .7s linear infinite':'none';q('runLbl').textContent=on?'Running\u2026':'Run Task';q('dot').className='dot'+(on?' run':'');}
function onFinish(summary){
  G.running=false;stopTimer();setRunning(false);q('feedLive').hidden=true;q('btnStop').hidden=true;q('dot').className='dot done';q('progFill').style.width='100%';addLog('Done.','done');showResultPanel(summary);
  var shouldPrompt=G.plan&&G.plan.length&&!G.skipSavePrompt;
  G.skipSavePrompt=false;
  if(shouldPrompt) setTimeout(promptSaveWorkflow,700); // let the result panel render first
}
function onAbort(){G.running=false;stopTimer();setRunning(false);q('feedLive').hidden=true;q('btnStop').hidden=true;addLog('Cancelled.','inf');G.skipSavePrompt=false;}
function stopTask(){G.aborted=true;resolvePlan(false);resolveConf(false);resolveDelModal(false);}
function openSsModal(title,src){q('ssMtitle').textContent=title;q('ssMimg').src=src;q('ssModal').classList.add('on');}
function mkEmpty(icon,text){var e=document.createElement('div');e.className='empty';var ei=document.createElement('div');ei.className='empty-i';ei.textContent=icon;var et=document.createElement('div');et.className='empty-t';et.textContent=text;e.appendChild(ei);e.appendChild(et);return e;}

// ── CONFIRM MODALS ────────────────────────────────────────────────────────────
function askConf(desc){return new Promise(function(resolve){G.confResolve=resolve;q('confDesc').textContent='"'+desc+'" \u2014 Proceed?';q('confModal').classList.add('on');});}
function resolveConf(yes){q('confModal').classList.remove('on');if(G.confResolve){G.confResolve(yes);G.confResolve=null;}}
function showDel(title,desc){return new Promise(function(resolve){G.delResolve=resolve;q('delModalTitle').textContent=title;q('delModalDesc').textContent=desc;q('delModal').classList.add('on');});}
function resolveDelModal(yes){q('delModal').classList.remove('on');if(G.delResolve){G.delResolve(yes);G.delResolve=null;}}

// ── SAVE MODAL ────────────────────────────────────────────────────────────────
function promptSaveWorkflow(){
  G.savingRecording=false;
  q('saveModalTitle').textContent='Save this as a workflow?';
  q('saveModalDesc').textContent='Give it a name to re-run this task anytime from the Flows tab.';
  q('saveModalInp').value=q('taskInput').value.trim().slice(0,50)||'Untitled workflow';
  q('saveModal').classList.add('on');
  setTimeout(function(){q('saveModalInp').focus();q('saveModalInp').select();},50);
}
function doSaveModal(){
  var name=q('saveModalInp').value.trim()||'Untitled';
  q('saveModal').classList.remove('on');
  if(G.savingRecording){saveRecording(name);G.savingRecording=false;return;}
  // Carry the run's screenshots along too (capped like recordings) so a
  // saved Flow can generate its own PDF/DOCX later, not just replay the task.
  var wf={id:Date.now(),name:name,task:q('taskInput').value.trim(),plan:G.plan,shots:(G.shots||[]).slice(0,15),steps:G.plan?G.plan.length:0,createdAt:new Date().toISOString(),runs:1};
  G.workflows.unshift(wf);
  if(G.workflows.length>20) G.workflows.length=20;
  saveLocal({workflows:G.workflows});
  addLog('\uD83D\uDCBE Saved "'+name+'"','done');renderWorkflows();
}

// ── WORKFLOWS ─────────────────────────────────────────────────────────────────
function renderWorkflows(){renderWfItems('');q('wfSearch').value='';}
function renderWfItems(filter){
  var c=q('wfItems');c.innerHTML='';
  var list=filter?G.workflows.filter(function(w){return w.name.toLowerCase().indexOf(filter.toLowerCase())!==-1||w.task.toLowerCase().indexOf(filter.toLowerCase())!==-1;}):G.workflows;
  if(!list.length){c.appendChild(mkEmpty('\uD83D\uDCC2',filter?'No match.':'No workflows yet.'));return;}
  list.forEach(function(wf){
    var item=document.createElement('div');item.className='wf-item';
    var ico=document.createElement('div');ico.className='wf-ico';ico.textContent='\u26A1';
    var info=document.createElement('div');info.className='wf-info';
    var nm=document.createElement('div');nm.className='wf-name';nm.textContent=wf.name;
    var mt=document.createElement('div');mt.className='wf-meta';mt.textContent=(wf.steps||'?')+' steps \u00B7 '+new Date(wf.createdAt).toLocaleDateString()+' \u00B7 '+(wf.runs||1)+'\u00D7';
    info.appendChild(nm);info.appendChild(mt);info.title='Click to run this task again';info.addEventListener('click',function(){replayWf(wf.id);});
    var btns=document.createElement('div');btns.className='wf-btns';
    function mkB(txt,cls,title,fn){var b=document.createElement('button');b.className='wf-btn'+(cls?' '+cls:'');b.textContent=txt;b.title=title;b.addEventListener('click',function(e){e.stopPropagation();fn();});return b;}
    btns.appendChild(mkB('\u25B6','play','Run this task again',function(){replayWf(wf.id);}));
    btns.appendChild(mkB('\uD83D\uDCC4','doc','Generate a PDF or Word document with screenshots',function(){
      if(!wf.shots||!wf.shots.length){addLog('This Flow has no saved screenshots yet \u2014 run it again to capture some, then it\u2019ll be available here.','inf');return;}
      openDocModal(LPDoc.fromRun(wf.task,wf.plan,wf.shots));
    }));
    btns.appendChild(mkB('\u2715','del','Delete this workflow',function(){G.workflows=G.workflows.filter(function(w){return w.id!==wf.id;});saveLocal({workflows:G.workflows});renderWfItems(q('wfSearch').value);}));
    item.appendChild(ico);item.appendChild(info);item.appendChild(btns);c.appendChild(item);
  });
}
function replayWf(id){var wf=G.workflows.find(function(w){return w.id===id;});if(!wf)return;wf.runs=(wf.runs||1)+1;saveLocal({workflows:G.workflows});q('taskInput').value=wf.task;switchPane('agent',q('navAgent'));detectVars();G.skipSavePrompt=true;startTask();}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function applyToggles(){document.querySelectorAll('.tog[data-key]').forEach(function(t){t.classList.toggle('on',G.settings[t.dataset.key]!==false);});}
function clearAll(){showDel('Clear All Data','Remove all data?').then(function(yes){if(!yes)return;G.workflows=[];G.shots=[];G.log=[];G.apiKey='';G.history=[];G.vars={};G.recordings=[];G.extractedData=[];chrome.storage.local.clear();bannerOk(false);renderWorkflows();resetFeed();renderHistory();renderRecordings();document.querySelectorAll('.var-inp').forEach(function(inp){inp.value='';});});}

// ── NAV ───────────────────────────────────────────────────────────────────────
function switchPane(name,btn){document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('on');});document.querySelectorAll('.nav-btn').forEach(function(b){b.classList.remove('on');});var pane=document.getElementById('pane-'+name);if(pane)pane.classList.add('on');if(btn)btn.classList.add('on');if(name==='workflows')renderWorkflows();if(name==='history')renderHistory();if(name==='recordings')renderRecordings();}
function updateMdlPill(){q('mdlPill').textContent=G.model.split('-').slice(0,3).join('-');}  
