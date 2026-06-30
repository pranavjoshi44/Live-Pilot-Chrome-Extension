// LivePilot docgen.js — Scribehow-style step guide export (PDF + DOCX)
// Turns a recorded session or an AI Agent run into a detailed, screenshot-by-screenshot guide.
'use strict';

var LPDoc = (function(){

  var ACTION_LABELS = {
    click:'Clicked an item', type:'Typed some text', press_enter:'Pressed Enter', navigate:'Opened a page',
    extract:'Collected information from the page', wait:'Waited a moment', scroll:'Scrolled the page',
    get_text:'Read text from the page', get_url:'Checked the page address', get_title:'Checked the page title'
  };
  function humanizeAction(a){ return ACTION_LABELS[a] || (a ? (a.charAt(0).toUpperCase()+a.slice(1)) : 'Step'); }

  function pad2(n){ return n<10 ? '0'+n : ''+n; }
  function fmtDate(d){
    d = d || new Date();
    return d.toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}) + ' ' + pad2(d.getHours())+':'+pad2(d.getMinutes());
  }
  function safeName(s){
    return (s||'guide').toString().trim().replace(/[^a-z0-9\-_ ]/gi,'').replace(/\s+/g,'-').slice(0,60) || 'guide';
  }

  // Navigation still gets a secondary detail line with the full, precise
  // address (genuinely useful, unlike a raw CSS selector) — but only when it
  // says something the friendlier heading text above it didn't already.
  function detailLine(s){
    if(s.action !== 'navigate' || !s.target) return '';
    return s.target === s.description ? '' : s.target;
  }

  // Turns a CSS selector like `#email` or `input[name="email"]` into a plain
  // English field name like "email field" — never shown verbatim to the reader.
  function friendlyFieldName(target){
    if(!target) return '';
    var m;
    if((m = target.match(/^#([\w-]+)/))) return humanizeToken(m[1]) + ' field';
    if((m = target.match(/\[name=["']?([\w.-]+)["']?\]/))) return humanizeToken(m[1]) + ' field';
    if((m = target.match(/\[placeholder[*^$]?=["']?([^"'\]]+)["']?\]/))) return '"' + m[1] + '" field';
    if((m = target.match(/\[aria-label=["']?([^"'\]]+)["']?\]/))) return '"' + m[1] + '" field';
    return '';
  }
  function humanizeToken(s){
    return s.replace(/[-_]+/g,' ').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/\s+/g,' ').trim().toLowerCase();
  }

  // Turns a raw URL into something a reader can actually parse at a glance —
  // prefers a tab/section name from the query string (the UI component that
  // was actually switched to, for an SPA route change) over the path, and
  // falls back to just the hostname rather than ever showing a long URL with
  // query strings and UUIDs as the headline text.
  function friendlyPageName(url){
    if(!url) return 'a new page';
    try{
      var u=new URL(url);
      var tabHint=null;
      u.searchParams.forEach(function(v){
        if(!tabHint && v && v.length<30 && /^[a-z0-9-]+$/i.test(v)) tabHint=v;
      });
      if(tabHint) return '"'+humanizeToken(tabHint)+'" in '+u.hostname;
      var seg=u.pathname.replace(/\/+$/,'').split('/').filter(Boolean).pop();
      if(seg && seg.length<40 && !/^[0-9a-f-]{6,}$/i.test(seg)) return u.hostname+' — '+humanizeToken(seg);
      return u.hostname;
    }catch(e){ return url; }
  }

  // Plain-English fallback when no human-written description is available.
  function fallbackDescription(action,target,value){
    var field = friendlyFieldName(target);
    switch(action){
      case 'click': return field ? ('Clicked the ' + field) : 'Clicked an item on the page';
      case 'type': return value ? ('Typed "' + value + '"' + (field ? ' into the ' + field : '')) : ('Typed into ' + (field || 'a field'));
      case 'press_enter': return 'Pressed Enter';
      case 'navigate': return 'Opened ' + friendlyPageName(target);
      default: return humanizeAction(action);
    }
  }

  // The session recorder bakes a raw CSS selector straight into its
  // description text (e.g. Type "x" in input[name="email"]); rebuild a plain
  // sentence from the structured action fields instead of showing that to the
  // reader — UNLESS a person actually wrote this description themselves
  // (editing a step, or adding a freeform note step), in which case showing
  // anything other than their exact words would silently throw their edit away.
  function describeRecordedAction(a,value){
    if(a.edited || a.action === 'note') return a.description || '';
    if(a.action === 'click'){
      var suffix = (a.description||'').replace(/^Click:\s*/,'');
      if(suffix && suffix !== a.target) return 'Clicked "' + suffix + '"'; // real visible button/link text
      return fallbackDescription('click', a.target, value);
    }
    return fallbackDescription(a.action, a.target, value);
  }

  // ── GUIDE BUILDERS ──────────────────────────────────────────────────────────
  function fromRecording(rec){
    var shots = rec.screenshots || [];
    var steps = (rec.actions||[]).map(function(a,i){
      var value = a.sensitive ? '••••••' : (a.value || '');
      return {
        n: i+1,
        action: a.action,
        description: describeRecordedAction(a,value),
        target: a.target || '',
        value: value,
        screenshot: shots[i] || null
      };
    });
    return {
      title: rec.name || 'Recorded Workflow',
      subtitle: 'Step-by-step guide · ' + steps.length + ' step' + (steps.length===1?'':'s'),
      createdAt: rec.startedAt ? new Date(rec.startedAt) : new Date(),
      steps: steps
    };
  }

  function fromRun(task, plan, shots){
    plan = plan || []; shots = shots || [];
    var steps = plan.map(function(s,i){
      var shot = null;
      for(var j=0;j<shots.length;j++){ if(shots[j].step === i+1){ shot = shots[j].url; break; } }
      var value = s.sensitive ? '••••••' : (s.value || '');
      // Navigate descriptions always just restate the raw URL (the planner
      // is told to), so prefer our friendlier version over it; other actions
      // keep the planner's own (usually more meaningful) description.
      var description = s.action==='navigate' ? fallbackDescription('navigate', s.target, value) : (s.description || fallbackDescription(s.action, s.target, value));
      return {
        n: i+1,
        action: s.action,
        description: description,
        target: s.target || '',
        value: value,
        screenshot: shot
      };
    });
    return {
      title: task || 'Automated Task',
      subtitle: 'Step-by-step guide · ' + steps.length + ' step' + (steps.length===1?'':'s'),
      createdAt: new Date(),
      steps: steps
    };
  }

  // ── IMAGE HELPERS ────────────────────────────────────────────────────────────
  function loadImageSize(dataUrl){
    return new Promise(function(resolve){
      if(!dataUrl){ resolve(null); return; }
      var img = new Image();
      img.onload = function(){ resolve({w: img.naturalWidth||img.width, h: img.naturalHeight||img.height}); };
      img.onerror = function(){ resolve(null); };
      img.src = dataUrl;
    });
  }

  function dataUrlToBytes(dataUrl){
    var b64 = dataUrl.slice(dataUrl.indexOf(',')+1);
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // docx always packages images as "<id>.png" (image/png) regardless of source
  // format, so re-encode every screenshot (captured as JPEG) through a canvas
  // to a real PNG before handing it to ImageRun — avoids a mismatched
  // extension/content-type that some Word/LibreOffice builds refuse to open.
  function toPngBytes(dataUrl, maxW){
    return new Promise(function(resolve){
      if(!dataUrl){ resolve(null); return; }
      var img = new Image();
      img.onload = function(){
        var w = img.naturalWidth||img.width, h = img.naturalHeight||img.height;
        if(maxW && w > maxW){ h = Math.round(h*(maxW/w)); w = maxW; }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img,0,0,w,h);
        try{ resolve({ bytes: dataUrlToBytes(canvas.toDataURL('image/png')), w: w, h: h }); }
        catch(e){ resolve(null); }
      };
      img.onerror = function(){ resolve(null); };
      img.src = dataUrl;
    });
  }

  function downloadBlob(blob, filename){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  function generatePDF(guide){
    var jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if(!jsPDFCtor) return Promise.reject(new Error('jsPDF failed to load'));

    return Promise.all(guide.steps.map(function(s){
      return loadImageSize(s.screenshot).then(function(sz){ return {step:s, sz:sz}; });
    })).then(function(sized){
      var doc = new jsPDFCtor({unit:'pt', format:'a4'});
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = doc.internal.pageSize.getHeight();
      var margin = 40;
      var maxImgW = pageW - margin*2;
      var y = margin;

      function ensureSpace(h){
        if(y + h > pageH - margin){ doc.addPage(); y = margin; }
      }

      // Cover block
      doc.setFont('helvetica','bold'); doc.setFontSize(22); doc.setTextColor(20,20,30);
      var titleLines = doc.splitTextToSize(guide.title, pageW-margin*2);
      doc.text(titleLines, margin, y+18);
      y += 18 + titleLines.length*26;
      doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(110,114,140);
      doc.text(guide.subtitle, margin, y+4);
      y += 20;
      doc.text('Generated by LivePilot  ·  ' + fmtDate(guide.createdAt), margin, y+4);
      y += 26;
      doc.setDrawColor(225,227,239); doc.line(margin, y, pageW-margin, y);
      y += 28;

      sized.forEach(function(item){
        var s = item.step, sz = item.sz;
        var textW = pageW - margin*2 - 26;
        doc.setFont('helvetica','bold'); doc.setFontSize(12);
        var descLines = doc.splitTextToSize(s.description || ('Step '+s.n), textW);
        var meta = detailLine(s);
        doc.setFont('helvetica','normal'); doc.setFontSize(9);
        var metaLines = meta ? doc.splitTextToSize(meta, textW) : [];

        var headerH = Math.max(20, descLines.length*15) + metaLines.length*11 + 10;
        var imgW=0, imgH=0;
        if(s.screenshot && sz){
          imgW = maxImgW; imgH = sz.h*(imgW/sz.w);
          var maxH = pageH - margin*2 - 70;
          if(imgH > maxH){ imgH = maxH; imgW = sz.w*(imgH/sz.h); }
        }
        var blockH = headerH + (imgH ? imgH+22 : 8);
        ensureSpace(Math.min(blockH, pageH - margin*2));

        // Numbered badge
        doc.setFillColor(91,82,232);
        doc.circle(margin+8, y+7, 9, 'F');
        doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(255,255,255);
        doc.text(String(s.n), margin+8, y+10, {align:'center'});

        // Description
        doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(20,20,30);
        doc.text(descLines, margin+24, y+10);
        y += Math.max(20, descLines.length*15) + 2;

        // Meta line
        if(meta){
          doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(140,144,168);
          doc.text(metaLines, margin+24, y);
          y += metaLines.length*11 + 8;
        }

        // Screenshot
        if(s.screenshot && sz && imgW && imgH){
          doc.setDrawColor(225,227,239); doc.setLineWidth(1);
          doc.rect(margin-2, y-2, imgW+4, imgH+4);
          try{ doc.addImage(s.screenshot, 'JPEG', margin, y, imgW, imgH); }catch(e){}
          y += imgH + 24;
        } else {
          y += 10;
        }
      });

      doc.save('livepilot-' + safeName(guide.title) + '.pdf');
    });
  }

  // ── DOCX ──────────────────────────────────────────────────────────────────
  function generateDOCX(guide){
    var docx = window.docx;
    if(!docx) return Promise.reject(new Error('docx library failed to load'));
    var MAX_IMG_W = 560;

    return Promise.all(guide.steps.map(function(s){
      return toPngBytes(s.screenshot, MAX_IMG_W).then(function(img){ return {step:s, img:img}; });
    })).then(function(items){
      var children = [];
      children.push(new docx.Paragraph({ text: guide.title, heading: docx.HeadingLevel.TITLE }));
      children.push(new docx.Paragraph({
        spacing: { after: 320 },
        children: [ new docx.TextRun({ text: guide.subtitle + '  ·  Generated by LivePilot · ' + fmtDate(guide.createdAt), color: '8A8FA8', size: 18 }) ]
      }));

      items.forEach(function(item){
        var s = item.step;
        children.push(new docx.Paragraph({
          heading: docx.HeadingLevel.HEADING_2,
          spacing: { before: 280, after: 60 },
          children: [ new docx.TextRun({ text: 'Step ' + s.n + '. ' + (s.description || '') }) ]
        }));
        var meta = detailLine(s);
        if(meta){
          children.push(new docx.Paragraph({
            spacing: { after: 140 },
            children: [ new docx.TextRun({ text: meta, color: '8A8FA8', size: 18, italics: true }) ]
          }));
        }
        if(item.img){
          children.push(new docx.Paragraph({
            spacing: { after: 280 },
            children: [ new docx.ImageRun({ data: item.img.bytes, transformation: { width: item.img.w, height: item.img.h } }) ]
          }));
        }
      });

      var doc = new docx.Document({ sections: [ { properties: {}, children: children } ] });
      return docx.Packer.toBlob(doc);
    }).then(function(blob){
      downloadBlob(blob, 'livepilot-' + safeName(guide.title) + '.docx');
    });
  }

  function escHtml(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Confluence storage format (the XHTML-ish dialect its REST API expects for
  // a page body). Images can't be inlined — Confluence only renders them via
  // an <ac:image> macro pointing at an attachment already uploaded to the
  // page — so this just assigns each step a filename and returns the actual
  // bytes alongside the markup; the caller uploads them as attachments after
  // the page exists, then this body (which already references those
  // filenames) becomes the page's real content.
  function toConfluenceStorage(guide){
    var images = [];
    var html = '<p><em>' + escHtml(guide.subtitle) + ' &middot; Generated by LivePilot &middot; ' + escHtml(fmtDate(guide.createdAt)) + '</em></p>';
    guide.steps.forEach(function(s){
      html += '<h2>Step ' + s.n + '. ' + escHtml(s.description || '') + '</h2>';
      var meta = detailLine(s);
      if(meta) html += '<p><em>' + escHtml(meta) + '</em></p>';
      if(s.screenshot){
        var filename = 'step-' + s.n + '.jpg';
        images.push({ filename: filename, bytes: dataUrlToBytes(s.screenshot) });
        html += '<ac:image><ri:attachment ri:filename="' + filename + '" /></ac:image>';
      }
    });
    return { title: guide.title, html: html, images: images };
  }

  return {
    fromRecording: fromRecording,
    fromRun: fromRun,
    humanizeAction: humanizeAction,
    generatePDF: generatePDF,
    generateDOCX: generateDOCX,
    toConfluenceStorage: toConfluenceStorage
  };
})();
