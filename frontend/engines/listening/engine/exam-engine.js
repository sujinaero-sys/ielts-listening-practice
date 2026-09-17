/*
  BUYE-Online — IELTS Listening exam-style engine
  ------------------------------------------------
  Each test page defines window.TEST_DATA before loading this file.
  Note there is NO answer key here anymore — grading happens
  server-side (submitAttempt), so a test's correct answers are never
  shipped to the browser at all.

  window.TEST_DATA = {
    testId: "test-2",                   // must match a TestId row in the backend's Tests sheet
    title: "IELTS Listening — Test 2",
    audioSrc: "audio.mp3",              // relative to the test's own HTML file
    totalQuestions: 40,
    partBoundaries: [10, 20, 30, 40],   // last question number in each part
    partLabels: {
      1: "Part 1 — <short description>",
      2: "Part 2 — <short description>",
      3: "Part 3 — <short description>",
      4: "Part 4 — <short description>"
    }
  };

  Requires api.js and auth-gate.js loaded first (see tests/test-1/index.html
  for the exact <script> order). Requires an #auth-screen container in the
  page markup, shown before #sc-screen — see the reference test-1 page.

  The rest of the HTML around the question content must keep the same
  element IDs/classes this engine already expects: #sc-screen, #sc-vol,
  #sc-test-btn, #sc-confirm, #sc-err, #sc-start-btn, #sc-lock-msg,
  #test-screen, #part-tag, #time-wrap, #timer, #part-tabs,
  .part-panel[data-part], .flag-btn[data-flag],
  input.ans[data-q] / select.ans[data-q] / input[name=qN],
  #palette-parts, #ctrl-progress, #prev-part-btn, #next-part-btn,
  #go-review-btn, #palette-review-btn, #review-screen, #review-grid,
  #review-back-btn, #review-submit-btn,
  #rv-answered/#rv-unanswered/#rv-flagged/#rv-time,
  #results-screen, #band-score, #raw-score, #part-scores, #review-body,
  #retake-btn
*/
(function(){
  "use strict";

  var TD = window.TEST_DATA;
  if(!TD){ console.error("TEST_DATA is not defined — the test page must set it before loading exam-engine.js"); return; }
  if(!TD.testId){ console.error("TEST_DATA.testId is required — it must match a TestId in the backend's Tests sheet"); return; }

  var TOTAL_Q = TD.totalQuestions || 40;
  var BOUNDARIES = TD.partBoundaries || [10,20,30,40];
  var NUM_PARTS = BOUNDARIES.length;
  var PART_LABELS = TD.partLabels || {};
  var EXCLUDED = {};
  (TD.excludedQuestions || []).forEach(function(n){ EXCLUDED[n] = true; });

  document.title = TD.title || document.title;
  document.querySelectorAll('[data-bind="title"]').forEach(function(el){ el.textContent = TD.title || ''; });

  function PART_OF(n){
    for(var i=0;i<BOUNDARIES.length;i++){ if(n <= BOUNDARIES[i]) return i+1; }
    return BOUNDARIES.length;
  }
  function getAnswer(q){
    var t = document.querySelector('input.ans[data-q="'+q+'"]'); if(t) return t.value.trim();
    var s = document.querySelector('select.ans[data-q="'+q+'"]'); if(s) return s.value;
    var r = document.querySelector('input[name="q'+q+'"]:checked'); if(r) return r.value;
    return "";
  }
  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  var flagged = {};
  var token = "";
  var attemptId = "";
  var attemptStartedAt = 0;

  /* ---------- auth gate: must be logged in before anything else shows ---------- */
  var authScreen = document.getElementById('auth-screen');
  var scScreen = document.getElementById('sc-screen');
  var testScreen = document.getElementById('test-screen');

  BuyeApi.getTokenFromUrl() ? initWithToken(BuyeApi.getTokenFromUrl()) : showAuthScreen();

  function showAuthScreen(){
    authScreen.classList.remove('hidden');
    BuyeAuthGate.require(authScreen, {
      subtitle: 'Log in to take ' + (TD.title || 'this test') + '.',
      onReady: initWithToken
    });
  }
  function initWithToken(t){
    token = t;
    authScreen.classList.add('hidden');
    scScreen.classList.remove('hidden');
  }

  /* ---------- sound check ---------- */
  var scVol = document.getElementById('sc-vol');
  var scTestBtn = document.getElementById('sc-test-btn');
  var scConfirm = document.getElementById('sc-confirm');
  var scErr = document.getElementById('sc-err');
  var scStartBtn = document.getElementById('sc-start-btn');
  var scLockMsg = document.getElementById('sc-lock-msg');

  var audioCtx = null;
  function beep(){
    try{
      audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 440;
      g.gain.value = parseFloat(scVol.value) * 0.3;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.6);
    }catch(e){}
  }
  scTestBtn.addEventListener('click', beep);

  scStartBtn.addEventListener('click', function(){
    if(!scConfirm.checked){
      scErr.classList.add('show');
      return;
    }
    scErr.classList.remove('show');
    scStartBtn.disabled = true;
    scStartBtn.textContent = 'Checking access…';

    BuyeApi.startAttempt(token, TD.testId).then(function(r){
      if(!r.success){
        scStartBtn.disabled = false;
        scStartBtn.textContent = 'Start test';
        if(r.locked && r.upgradeUrl){
          scLockMsg.innerHTML = 'This test needs an active subscription. ' +
            '<a href="' + r.upgradeUrl + '" target="_blank">Unlock access</a>.';
        } else {
          scLockMsg.textContent = r.message || 'Could not start this test.';
        }
        scLockMsg.classList.add('show');
        return;
      }

      attemptId = r.attemptId;
      attemptStartedAt = Date.now();
      scScreen.classList.add('hidden');
      testScreen.classList.remove('hidden');
      window.scrollTo(0,0);
      player.volume = parseFloat(scVol.value);
      startTimer();
      player.play().catch(function(){});
      renderPalette();
      showPart(1);
    }).catch(function(){
      scStartBtn.disabled = false;
      scStartBtn.textContent = 'Start test';
      scLockMsg.textContent = 'Network error — please try again.';
      scLockMsg.classList.add('show');
    });
  });

  /* ---------- audio (locked, autoplay, no seek) ---------- */
  var player = document.createElement('audio');
  player.src = TD.audioSrc;
  player.preload = 'auto';
  document.body.appendChild(player);
  var lastKnownTime = 0;
  player.addEventListener('timeupdate', function(){ lastKnownTime = player.currentTime; });
  player.addEventListener('seeking', function(){
    if(Math.abs(player.currentTime - lastKnownTime) > 1){ player.currentTime = lastKnownTime; }
  });

  /* ---------- part tabs & panels ---------- */
  var currentPart = 1;
  var partTabsEl = document.getElementById('part-tabs');
  var partTag = document.getElementById('part-tag');
  for(var p=1;p<=NUM_PARTS;p++){
    (function(pn){
      var b = document.createElement('button');
      b.textContent = 'Part ' + pn;
      b.id = 'tab-' + pn;
      b.addEventListener('click', function(){ showPart(pn); });
      partTabsEl.appendChild(b);
    })(p);
  }
  function showPart(p){
    currentPart = p;
    document.querySelectorAll('.part-panel').forEach(function(sec){
      sec.classList.toggle('active', sec.getAttribute('data-part') === String(p));
    });
    for(var i=1;i<=NUM_PARTS;i++){ document.getElementById('tab-'+i).classList.toggle('active', i===p); }
    partTag.textContent = 'Part ' + p + ' of ' + NUM_PARTS;
    document.getElementById('prev-part-btn').disabled = (p===1);
    document.getElementById('next-part-btn').disabled = (p===NUM_PARTS);
    window.scrollTo(0,0);
    updatePaletteCurrent();
  }
  document.getElementById('prev-part-btn').addEventListener('click', function(){ if(currentPart>1) showPart(currentPart-1); });
  document.getElementById('next-part-btn').addEventListener('click', function(){ if(currentPart<NUM_PARTS) showPart(currentPart+1); });

  /* ---------- flags ---------- */
  document.querySelectorAll('.flag-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var q = btn.getAttribute('data-flag');
      flagged[q] = !flagged[q];
      btn.classList.toggle('on', !!flagged[q]);
      var badge = document.getElementById('badge-'+q);
      if(badge) badge.classList.toggle('flagged', !!flagged[q]);
      renderPalette();
    });
  });

  /* ---------- live answered styling ---------- */
  document.querySelectorAll('input.ans').forEach(function(el){
    el.addEventListener('input', function(){
      el.classList.toggle('answered', el.value.trim().length>0);
      renderPalette();
    });
  });
  document.querySelectorAll('select.ans').forEach(function(el){
    el.addEventListener('change', function(){
      el.classList.toggle('answered', !!el.value);
      renderPalette();
    });
  });
  document.querySelectorAll('.mcq-opt input[type=radio]').forEach(function(el){
    el.addEventListener('change', function(){
      var block = el.closest('.mcq-block');
      block.querySelectorAll('.mcq-opt').forEach(function(o){ o.classList.remove('checked'); });
      el.closest('.mcq-opt').classList.add('checked');
      renderPalette();
    });
  });

  /* ---------- side palette ---------- */
  var paletteParts = document.getElementById('palette-parts');
  function buildPalette(){
    paletteParts.innerHTML = '';
    for(var p=1;p<=NUM_PARTS;p++){
      var wrap = document.createElement('div');
      wrap.className = 'palette-part';
      var lbl = document.createElement('div');
      lbl.className = 'pl';
      lbl.textContent = 'Part ' + p;
      wrap.appendChild(lbl);
      var grid = document.createElement('div');
      grid.className = 'palette-grid';
      var start = (p===1) ? 1 : BOUNDARIES[p-2]+1;
      var end = BOUNDARIES[p-1];
      for(var q=start;q<=end;q++){
        (function(qn){
          var btn = document.createElement('button');
          btn.textContent = qn;
          btn.id = 'pal-' + qn;
          if(EXCLUDED[qn]) btn.classList.add('excluded');
          btn.addEventListener('click', function(){
            showPart(PART_OF(qn));
            setTimeout(function(){
              var f = document.querySelector('[data-q="'+qn+'"]');
              if(f && f.focus) f.focus();
            }, 50);
          });
          grid.appendChild(btn);
        })(q);
      }
      wrap.appendChild(grid);
      paletteParts.appendChild(wrap);
    }
  }
  buildPalette();

  function renderPalette(){
    var answered = 0;
    for(var q=1;q<=TOTAL_Q;q++){
      var pal = document.getElementById('pal-'+q);
      if(EXCLUDED[q]) continue; // stays styled via the .excluded class only
      var has = !!getAnswer(q);
      if(has) answered++;
      if(pal){ pal.classList.toggle('answered', has); pal.classList.toggle('flagged', !!flagged[q]); }
    }
    document.getElementById('ctrl-progress').textContent = answered + ' / ' + (TOTAL_Q - Object.keys(EXCLUDED).length) + ' answered';
    updatePaletteCurrent();
    return answered;
  }
  function updatePaletteCurrent(){
    for(var q=1;q<=TOTAL_Q;q++){
      var pal = document.getElementById('pal-'+q);
      if(pal) pal.classList.toggle('current', PART_OF(q)===currentPart);
    }
  }

  /* ---------- timer ---------- */
  var TOTAL_SECONDS = (TD.timeLimitMinutes || 30) * 60;
  var remaining = TOTAL_SECONDS, handle = null;
  var timerEl = document.getElementById('timer');
  var timeWrap = document.getElementById('time-wrap');
  function fmt(s){ var m=Math.floor(s/60), sec=s%60; return (m<10?'0':'')+m+':'+(sec<10?'0':'')+sec; }
  function tick(){
    remaining--;
    if(remaining<=0){ remaining=0; timerEl.textContent='00:00'; clearInterval(handle); doSubmit(); return; }
    timerEl.textContent = fmt(remaining);
    timeWrap.classList.toggle('low', remaining<=120);
  }
  function startTimer(){ timerEl.textContent = fmt(remaining); handle = setInterval(tick,1000); }

  /* ---------- review screen ---------- */
  var reviewScreen = document.getElementById('review-screen');
  var reviewGrid = document.getElementById('review-grid');
  for(var q=1;q<=TOTAL_Q;q++){
    (function(qn){
      var btn = document.createElement('button');
      btn.textContent = qn;
      btn.id = 'rv-' + qn;
      if(EXCLUDED[qn]) btn.classList.add('excluded');
      btn.addEventListener('click', function(){
        reviewScreen.classList.add('hidden');
        testScreen.classList.remove('hidden');
        showPart(PART_OF(qn));
        setTimeout(function(){
          var f = document.querySelector('[data-q="'+qn+'"]');
          if(f && f.focus) f.focus();
        }, 50);
      });
      reviewGrid.appendChild(btn);
    })(q);
  }
  function openReview(){
    var answered = renderPalette();
    var gradedTotal = TOTAL_Q - Object.keys(EXCLUDED).length;
    document.getElementById('rv-answered').textContent = answered + ' / ' + gradedTotal;
    document.getElementById('rv-unanswered').textContent = (gradedTotal-answered);
    document.getElementById('rv-flagged').textContent = Object.keys(flagged).filter(function(k){return flagged[k];}).length;
    document.getElementById('rv-time').textContent = fmt(remaining);
    for(var q=1;q<=TOTAL_Q;q++){
      if(EXCLUDED[q]) continue;
      var b = document.getElementById('rv-'+q);
      b.classList.toggle('answered', !!getAnswer(q));
      b.classList.toggle('flagged', !!flagged[q]);
    }
    testScreen.classList.add('hidden');
    reviewScreen.classList.remove('hidden');
    window.scrollTo(0,0);
  }
  document.getElementById('go-review-btn').addEventListener('click', openReview);
  document.getElementById('palette-review-btn').addEventListener('click', openReview);
  document.getElementById('review-back-btn').addEventListener('click', function(){
    reviewScreen.classList.add('hidden');
    testScreen.classList.remove('hidden');
  });
  document.getElementById('review-submit-btn').addEventListener('click', doSubmit);

  /* ---------- submit: grading now happens server-side ---------- */
  var resultsScreen = document.getElementById('results-screen');
  var submitInFlight = false;

  function doSubmit(){
    if(submitInFlight) return;
    submitInFlight = true;
    clearInterval(handle);
    player.pause();

    var responses = {};
    for(var q=1;q<=TOTAL_Q;q++){ responses[q] = getAnswer(q); }
    var durationSeconds = Math.round((Date.now() - attemptStartedAt) / 1000);

    BuyeApi.submitAttempt(token, attemptId, responses, durationSeconds).then(function(r){
      submitInFlight = false;
      if(!r.success){
        alert(r.message || 'Could not submit your attempt — please try again.');
        return;
      }
      renderResults(r);
    }).catch(function(){
      submitInFlight = false;
      alert('Network error while submitting — please try again.');
    });
  }

  function renderResults(r){
    var rows = "";
    for(var q=1;q<=TOTAL_Q;q++){
      var item = r.review && r.review[q] ? r.review[q] : { given:"", correct:false, correctAnswer:"" };
      if(item.excluded){
        rows += '<tr class="excluded">'+
          '<td class="mark">&#8212;</td>'+
          '<td>'+q+'</td>'+
          '<td class="ua">'+(item.given?escapeHtml(item.given):'<em>blank</em>')+'</td>'+
          '<td class="ca"><em>Pending content</em></td>'+
        '</tr>';
        continue;
      }
      rows += '<tr class="'+(item.correct?'correct':'wrong')+'">'+
        '<td class="mark">'+(item.correct?'&#10003;':'&#10007;')+'</td>'+
        '<td>'+q+'</td>'+
        '<td class="ua">'+(item.given?escapeHtml(item.given):'<em>blank</em>')+'</td>'+
        '<td class="ca">'+escapeHtml(item.correctAnswer)+'</td>'+
      '</tr>';
    }
    document.getElementById('review-body').innerHTML = rows;
    document.getElementById('raw-score').textContent = r.rawScore + ' / ' + r.totalQuestions;
    document.getElementById('band-score').textContent = String(r.bandScore).replace(/\.0$/,'');

    var ps = document.getElementById('part-scores'); ps.innerHTML = '';
    for(var p=1;p<=NUM_PARTS;p++){
      var partSize = (r.partTotals && r.partTotals[p] != null)
        ? r.partTotals[p]
        : (p===1 ? BOUNDARIES[0] : (BOUNDARIES[p-1]-BOUNDARIES[p-2]));
      var d = document.createElement('div');
      d.innerHTML = '<div class="pn">'+(PART_LABELS[p]||('Part '+p))+'</div><div class="pv">'+(r.partScores[p]||0)+' / '+partSize+'</div>';
      ps.appendChild(d);
    }

    testScreen.classList.add('hidden');
    reviewScreen.classList.add('hidden');
    resultsScreen.classList.remove('hidden');
    window.scrollTo(0,0);
  }
  document.getElementById('retake-btn').addEventListener('click', function(){ window.location.reload(); });

})();
