// LivePilot sidebar.js
'use strict';
var ssCount = 0;
function q(id){ return document.getElementById(id); }

document.addEventListener('DOMContentLoaded', function(){
  q('btnX').addEventListener('click', function(){ try{ chrome.runtime.sendMessage({type:'CLOSE_SIDEBAR'}); }catch(_){} });
  q('btnClr').addEventListener('click', clearTl);
  q('btnPop').addEventListener('click', function(){ try{ chrome.runtime.sendMessage({type:'OPEN_POPUP'}); }catch(_){} });
  q('btnPhX').addEventListener('click', function(){ q('phOv').classList.remove('on'); });
  q('phOv').addEventListener('click', function(e){ if(e.target===q('phOv')) q('phOv').classList.remove('on'); });

  chrome.storage.onChanged.addListener(function(changes){
    var v = changes.sidebarFeed && changes.sidebarFeed.newValue;
    if(!v) return;
    if(v.type==='step'){ addStep(v.text, v.status, v.time, v.screenshot); if(v.screenshot) addSs(v.screenshot); setCur(v.text, v.status==='run'); }
    else if(v.type==='progress'){ setProg(v.done, v.total); }
    else if(v.type==='complete'){ setCur('Task complete', false); if(v.total) setProg(v.total, v.total); }
    else if(v.type==='reset'){ clearTl(); }
  });
});

function addStep(text, status, time, screenshot){
  var icons={done:'&#x2713;',run:'&#x2192;',err:'&#x2717;',inf:'&middot;'};
  var tl=q('tl');
  var ph=tl.querySelector('[data-ph]'); if(ph) ph.remove();
  var item=document.createElement('div'); item.className='ti';
  var ic=document.createElement('div'); ic.className='ti-ic '+(status||'inf'); ic.innerHTML=icons[status]||'&middot;';
  var c=document.createElement('div'); c.className='ti-c';
  var tx=document.createElement('div'); tx.className='ti-tx'+(status==='inf'?' dim':''); tx.textContent=text;
  c.appendChild(tx);
  if(time){ var ts=document.createElement('div'); ts.className='ti-ts'; ts.textContent=time; c.appendChild(ts); }
  item.appendChild(ic); item.appendChild(c);
  if(screenshot){
    var th=document.createElement('div'); th.className='ti-th';
    var img=document.createElement('img'); img.src=screenshot; img.alt='';
    th.appendChild(img);
    (function(src){ th.addEventListener('click', function(){ openPhoto(src); }); })(screenshot);
    item.appendChild(th);
  }
  tl.appendChild(item);
  tl.scrollTop=tl.scrollHeight;
}

function setCur(text, live){
  var el=q('curAct'); el.textContent=text;
  el.className='cur'+(live?' live':'');
}

function setProg(done, total){
  var pct=total>0?Math.round(done/total*100):0;
  q('pf').style.width=pct+'%';
  q('stLbl').textContent=total>0?done+'/'+total+' steps':'Ready';
  q('pctLbl').textContent=pct+'%';
}

function addSs(url){
  ssCount++;
  q('ssSec').hidden=false;
  var t=document.createElement('div'); t.className='ss-t';
  var img=document.createElement('img'); img.src=url; img.alt='';
  var n=document.createElement('span'); n.className='ss-n'; n.textContent=ssCount;
  t.appendChild(img); t.appendChild(n);
  (function(src){ t.addEventListener('click', function(){ openPhoto(src); }); })(url);
  q('ssGrid').appendChild(t);
}

function openPhoto(src){ q('phImg').src=src; q('phOv').classList.add('on'); }

function clearTl(){
  ssCount=0;
  q('tl').innerHTML='<div data-ph style="text-align:center;padding:22px;color:var(--mut);font-size:11px">Timeline cleared.</div>';
  q('ssGrid').innerHTML=''; q('ssSec').hidden=true;
  setCur('Ready', false); setProg(0,0);
}
