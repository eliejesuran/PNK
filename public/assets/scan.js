/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* PNK — scanner d'entrée : caméra (BarcodeDetector, sinon jsQR), saisie manuelle, retour visuel/sonore. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var eventSel = $('#event');
  var video = $('#video');
  var panel = $('#result');
  var title = $('#result-title');
  var detail = $('#result-detail');
  var counter = $('#count');
  var log = $('#log');
  var camBtn = $('#cam');
  var manual = $('#manual');
  var code = $('#code');
  var camMsg = $('#cam-msg');
  var last = { code: '', at: 0 };
  var busy = false;
  var running = false;
  var detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var audio = null;
  if (!eventSel || !camBtn) return; // aucun concert à scanner : rien à brancher

  function beep(ok) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator();
      var g = audio.createGain();
      o.type = ok ? 'sine' : 'sawtooth';
      o.frequency.value = ok ? 880 : 180;
      g.gain.value = 0.15;
      o.connect(g);
      g.connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + (ok ? 0.12 : 0.45));
    } catch (e) { /* le son est un bonus */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 60, 120]);
  }

  var LABELS = {
    ok: ['OK', 'ok'],
    already: ['DÉJÀ ENTRÉ', 'warn'],
    void: ['BILLET ANNULÉ', 'bad'],
    wrong_event: ['AUTRE CONCERT', 'bad'],
    unknown: ['INCONNU', 'bad'],
    invalid: ['PAS UN BILLET PNK', 'bad'],
  };

  function show(res) {
    var l = LABELS[res.result] || ['ERREUR', 'bad'];
    panel.className = 'scan-result ' + l[1];
    title.textContent = l[0];
    var parts = [];
    if (res.type) parts.push(res.type);
    if (res.holder) parts.push(res.holder);
    if (res.result === 'already' && res.checkedInAt) {
      parts.push('entré à ' + new Date(res.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }
    if (res.result === 'wrong_event' && res.eventTitle) parts.push(res.eventTitle);
    detail.textContent = parts.join(' · ');
    if (typeof res.checkedIn === 'number') counter.textContent = res.checkedIn + ' / ' + res.total;
    var li = document.createElement('li');
    li.className = l[1];
    li.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '  ' + l[0] + (res.code ? '  ' + res.code : '');
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 12) log.removeChild(log.lastChild);
    beep(res.result === 'ok');
  }

  function submit(raw, force) {
    var now = Date.now();
    if (!force && raw === last.code && now - last.at < 4000) return Promise.resolve();
    last = { code: raw, at: now };
    busy = true;
    return fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: raw, eventId: parseInt(eventSel.value, 10) }),
    })
      .then(function (r) { return r.json(); })
      .then(show)
      .catch(function () { show({ result: 'error' }); })
      .then(function () { busy = false; });
  }

  // Compteur d'entrées : chargé à l'ouverture, au changement de concert, et rafraîchi (autres portes / autres scanners).
  function loadStats() {
    fetch('/api/scan/stats?event=' + encodeURIComponent(eventSel.value))
      .then(function (r) { return r.json(); })
      .then(function (r) { if (typeof r.checkedIn === 'number') counter.textContent = r.checkedIn + ' / ' + r.total; })
      .catch(function () { /* hors ligne : on garde l'ancien chiffre */ });
  }
  eventSel.addEventListener('change', loadStats);
  setInterval(loadStats, 15000);
  loadStats();

  function tick() {
    if (!running) return;
    if (video.readyState >= 2 && !busy) {
      var p;
      if (detector) {
        p = detector.detect(video).then(function (r) { return r.length ? r[0].rawValue : null; });
      } else {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var q = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
        p = Promise.resolve(q ? q.data : null);
      }
      p.then(function (text) { if (text) return submit(text, false); }).catch(function () {}).then(function () { setTimeout(tick, 150); });
    } else {
      setTimeout(tick, 150);
    }
  }

  camBtn.addEventListener('click', function () {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camMsg.textContent = 'Caméra indisponible (il faut HTTPS). Utilise la saisie manuelle.';
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        running = true;
        camBtn.hidden = true;
        video.hidden = false;
        tick();
      })
      .catch(function () { camMsg.textContent = 'Caméra refusée ou introuvable. Utilise la saisie manuelle.'; });
  });

  manual.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = code.value.trim();
    if (v) submit(v, true).then(function () { code.value = ''; code.focus(); });
  });
})();
