#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Génère le site de démonstration statique de PNK (pour GitHub Pages) à partir d'une instance LOCALE remplie avec seed/dev.sql.

Les vraies pages sont capturées, les liens internes réécrits vers les pages capturées, les formulaires neutralisés.

Usage :
    npm run db:reset:local            # données de démo (organisation FICTIVE)
    npm run dev                       # dans un autre terminal
    python3 scripts/build-demo-site.py <dossier-de-sortie> [--forbid mot1,mot2]

--forbid : mots qui ne doivent apparaître nulle part dans le site généré (ex. le nom réel de l'organisation) ;
la génération échoue s'il en reste un. « localhost » est toujours interdit.
"""
import argparse, html, re, shutil, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://localhost:8787'
EXCLUDE = ('/api', '/webhooks', '/pay', '/q/', '/admin/export', '/assets', '/healthz', '/favicon', '/robots')
LINK_RE = re.compile(r'(href|src|action)="([^"]*)"')


def norm(url):
    p = urllib.parse.urlsplit(url)
    path = p.path or '/'
    q = urllib.parse.parse_qs(p.query)
    lang = q.get('lang', [''])[0]
    keep = {'lang': lang} if lang in ('en', 'nl') and (path == '/' or path.startswith('/e/')) else {}
    return path + (('?' + urllib.parse.urlencode(keep)) if keep else '')


def fname(key):
    path, _, query = key.partition('?')
    lang = ('-' + query.split('=')[1]) if query else ''
    if path == '/':
        return 'home' + lang + '.html'
    parts = [x for x in path.strip('/').split('/') if x]
    if parts[0] == 'o':
        parts[1] = parts[1][:8].lower()
    return '-'.join(parts) + lang + '.html'


def fetch(key):
    req = urllib.request.Request(BASE + key, headers={'Accept-Language': 'fr'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8')


def strip_origin(v):
    return re.sub(r'^https?://localhost:\d+', '', v)


def internal_links(text):
    out = []
    for attr, val in LINK_RE.findall(text):
        if attr != 'action':
            v = strip_origin(html.unescape(val))
            if v.startswith('/') and not v.startswith('//'):
                out.append(v)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--forbid', default='')
    args = ap.parse_args()
    out = Path(args.out).resolve()

    # ---- capture (parcours en largeur depuis quelques pages de départ)
    queue = [norm(s) for s in ['/', '/?lang=en', '/?lang=nl', '/admin', '/scan']]
    pages = {}
    while queue:
        key = queue.pop(0)
        if key in pages or any(key.startswith(e) for e in EXCLUDE):
            continue
        try:
            pages[key] = fetch(key)
        except Exception as e:
            print('ignoré', key, e, file=sys.stderr)
            continue
        queue += [k for k in map(norm, internal_links(pages[key])) if k not in pages]
    if '/admin' not in pages:
        sys.exit("Impossible de joindre l'appli locale (http://localhost:8787) : lance « npm run dev » d'abord.")
    files = {k: fname(k) for k in pages}

    # ---- commandes d'exemple pour la page d'accueil de la visite
    ticket = guest = None
    for k, t in sorted(pages.items()):
        m = re.fullmatch(r'/admin/orders/(\d+)', k)
        if not m:
            continue
        tok = re.search(r'/o/([A-Za-z0-9_-]{32})', t)
        if not tok:
            continue
        if guest is None and 'invité · gratuit' in html.unescape(t):
            guest = tok.group(1)[:8].lower()
        if ticket is None and 'en ligne · en ligne' in html.unescape(t):
            ticket = tok.group(1)[:8].lower()
    if not ticket or not guest:
        sys.exit("Données de démo incomplètes : relance « npm run db:reset:local ».")

    def rewrite(text):
        def sub(m):
            attr, val = m.group(1), html.unescape(m.group(2))
            if attr == 'action':
                return 'action="#" data-tour-form'
            val = strip_origin(val)
            if val.startswith(('#', 'http', 'mailto:', '//')):
                return f'{attr}="{html.escape(val)}"' if val != html.unescape(m.group(2)) else m.group(0)
            if val.startswith('/assets/'):
                return f'{attr}="assets/{val[len("/assets/"):]}"'
            if val.startswith('/favicon.svg'):
                return f'{attr}="favicon.svg"'
            if val.startswith('/'):
                k = norm(val)
                return f'{attr}="{files[k]}"' if k in files else f'{attr}="#" data-tour-dead'
            return m.group(0)
        text = LINK_RE.sub(sub, text)
        text = re.sub(r'<script src="assets/(scan|jsQR)\.js"[^>]*></script>', '', text)
        if 'name="robots"' not in text:  # c'est une démo : pas d'indexation par les moteurs de recherche
            text = text.replace('<head>', '<head><meta name="robots" content="noindex, nofollow">', 1)
        bar = ('<div class="tour-bar"><a href="index.html">← Retour à la visite</a>'
               '<span>Page figée de démonstration : rien ne s’enregistre</span></div>')
        text = re.sub(r'(<body[^>]*>)', r'\1' + bar, text, count=1)
        return text.replace('</body>', '<script src="assets/tour.js" defer></script></body>')

    if out.exists():
        shutil.rmtree(out)
    (out / 'assets' / 'fonts').mkdir(parents=True)
    for k, t in pages.items():
        (out / files[k]).write_text(rewrite(t), encoding='utf-8')

    css = (ROOT / 'public/assets/pnk.css').read_text(encoding='utf-8').replace('/assets/fonts/', 'fonts/')
    css += '''
.tour-bar { position: sticky; top: 0; z-index: 100; display: flex; gap: 0.4rem 1rem; justify-content: space-between; flex-wrap: wrap;
  background: #fff; color: #0b0b0b; border-bottom: 3px solid #d7000f; padding: 0.4rem 1rem; font: 700 0.85rem 'Courier Prime', 'Courier New', monospace; }
.tour-bar a { color: #d7000f; }
.tour-toast { position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); z-index: 200; background: #0b0b0b; color: #f1ebdd;
  border: 3px solid #d7000f; padding: 0.6rem 1rem; font: 700 0.95rem 'Courier Prime', monospace; max-width: 92vw; }
'''
    (out / 'assets/pnk.css').write_text(css, encoding='utf-8')
    for f in (ROOT / 'public/assets/fonts').glob('*.woff2'):
        shutil.copy(f, out / 'assets/fonts' / f.name)
    shutil.copy(ROOT / 'public/assets/app.js', out / 'assets/app.js')
    shutil.copy(ROOT / 'public/favicon.svg', out / 'favicon.svg')
    (out / 'assets/tour.js').write_text('''/* SPDX-License-Identifier: AGPL-3.0-or-later */
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
''', encoding='utf-8')
    index = (ROOT / 'scripts/demo-site/index.html').read_text(encoding='utf-8')
    index = index.replace('o-TICKET', f'o-{ticket}').replace('o-GUEST', f'o-{guest}')
    (out / 'index.html').write_text(index, encoding='utf-8')
    (out / '.nojekyll').write_text('', encoding='utf-8')

    # ---- garde-fou : rien d'interdit dans ce qui sera publié
    forbidden = ['localhost'] + [w.strip() for w in args.forbid.split(',') if w.strip()]
    bad = []
    for f in out.rglob('*'):
        if f.is_file() and f.suffix in ('.html', '.css', '.js', '.svg'):
            low = f.read_text(encoding='utf-8').lower()
            bad += [f'{f.relative_to(out)}: « {w} »' for w in forbidden if w.lower() in low]
    if bad:
        shutil.rmtree(out)
        sys.exit('REFUS : mots interdits trouvés, rien n\'a été généré :\n  ' + '\n  '.join(bad[:20]))
    print(f'{len(pages)} pages capturées + index → {out}')


if __name__ == '__main__':
    main()
