/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* PNK — petits comportements d'amélioration progressive. Tout fonctionne aussi sans JavaScript. */
(function () {
  'use strict';

  // Confirmation avant action sensible : <form data-confirm="Sûr ?">
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  });

  // Boutons d'impression : <button data-print>
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-print]') : null;
    if (b) {
      e.preventDefault();
      window.print();
    }
  });

  // Envoi unique : désactive le bouton après le premier clic (évite les doubles commandes).
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-once') || e.defaultPrevented) return;
    var btn = f.querySelector('button[type=submit]');
    if (btn) setTimeout(function () { btn.disabled = true; }, 0);
  });

  // Retour arrière depuis la page de paiement : la page revient du cache avec le bouton grisé, on le réactive.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var btns = document.querySelectorAll('form[data-once] button[type=submit]');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = false;
  });

  // Sélecteurs de quantité et total en direct.
  var form = document.querySelector('form[data-cart]');
  if (form) {
    var locale = { fr: 'fr-BE', en: 'en-GB', nl: 'nl-BE' }[document.documentElement.lang] || 'fr-BE';
    var currency = form.dataset.currency || 'EUR';
    var fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: currency });
    var max = parseInt(form.dataset.max || '6', 10);
    var inputs = Array.prototype.slice.call(form.querySelectorAll('input.qty'));
    var totalEl = document.getElementById('total');
    var payBtn = document.getElementById('pay');

    var sum = function () { return inputs.reduce(function (n, i) { return n + (parseInt(i.value, 10) || 0); }, 0); };
    var refresh = function () {
      var cents = 0;
      inputs.forEach(function (i) {
        var q = Math.max(0, parseInt(i.value, 10) || 0);
        cents += q * parseInt(i.dataset.price || '0', 10);
      });
      if (totalEl) totalEl.textContent = fmt.format(cents / 100);
      if (payBtn) payBtn.disabled = sum() === 0;
    };
    form.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-step]') : null;
      if (!b) return;
      e.preventDefault();
      var input = form.querySelector('#' + b.dataset.for);
      if (!input) return;
      var step = parseInt(b.dataset.step, 10);
      var cur = parseInt(input.value, 10) || 0;
      var lim = Math.min(parseInt(input.max || '99', 10), max - (sum() - cur));
      input.value = String(Math.max(0, Math.min(lim, cur + step)));
      refresh();
    });
    inputs.forEach(function (i) { i.addEventListener('input', refresh); });
    refresh();
  }

  // Impression automatique : <body data-autoprint>
  if (document.body.dataset.autoprint) window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 300); });

  // Rafraîchissement automatique de la page "paiement en cours" : <body data-refresh="3">
  var r = parseInt(document.body.dataset.refresh || '0', 10);
  if (r > 0) setTimeout(function () { window.location.reload(); }, r * 1000);
})();
