/* SPDX-License-Identifier: AGPL-3.0-or-later */
(function () {
  'use strict';
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'tour-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    toast('Visite : ce bouton n’enregistre rien (c’est une page figée).');
  }, true);
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[data-tour-dead]') : null;
    if (a) { e.preventDefault(); toast('Cette page n’est pas incluse dans la visite.'); }
  });
})();
