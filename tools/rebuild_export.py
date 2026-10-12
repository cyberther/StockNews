#!/usr/bin/env python3
"""Rebuild the self-unpacking exports from their templates:
export/HIF-Web-Dark.html from templates/stock-news-web/StockNewsWeb.dc.html and
export/HIF-Mobile-Dark.html from templates/stock-news-dark/StockNewsDark.dc.html.

The export is a self-unpacking bundle: a JSON-encoded copy of the page whose
asset paths are replaced by manifest uuids, plus a manifest of base64 (gzip)
assets. This keeps the bundle's runtime and uuids, and swaps in the current
page markup and the current asset bytes.

    python3 tools/rebuild_export.py                  # writes both exports
    python3 tools/rebuild_export.py web|mobile       # writes one
    python3 tools/rebuild_export.py --check          # exit 1 if any export is stale
"""
import base64, gzip, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Per export: the page, the output, and page-relative src -> manifest uuid
# (stable across rebuilds).
TARGETS = {
    'web': {
        'page': ROOT / 'templates/stock-news-web/StockNewsWeb.dc.html',
        'out': ROOT / 'export/HIF-Web-Dark.html',
        'assets': {
            './support.js': '0063a956-78e8-41de-b840-36b3c7c986f8',
            './ds-base.js': 'e28c8dbf-cca6-4619-a20e-28e41cc2e168',
            '../shared/hif-data.js': '51260e3d-ca06-4f11-8bb4-255f8df7487d',
            '../shared/hif-chart.js': 'c2cb1d5a-7eb5-4f7b-ae9b-20657e2ba262',
            '../shared/hif-insight.js': '9cf08d53-172d-43a0-9618-2b7d30215898',
            '../shared/hif-live.js': 'c3512b4d-940f-4c6c-be48-a62e195d9a3c',
            '../shared/hif-store.js': 'cbf22793-fdd7-4578-9f64-92a72296bdea',
            './assets/aa-logo.png': '8f4d386c-5068-40fe-9b17-49e5c21ab630',
            './assets/hero-globe.png': 'f6717536-9b6d-44c4-b709-5a1f9fbe7642',
        },
    },
    'mobile': {
        'page': ROOT / 'templates/stock-news-dark/StockNewsDark.dc.html',
        'out': ROOT / 'export/HIF-Mobile-Dark.html',
        'assets': {
            './support.js': '5f546fba-2a1a-4253-b6d5-6d499367d292',
            './ds-base.js': '1a23418a-47b6-4488-b543-86c6c76bc75d',
            '../shared/hif-data.js': '579b1aee-3c99-4dcd-89f7-0266059cff28',
            '../shared/hif-store.js': 'fa1601de-b213-46b7-8267-9c64cee3176c',
        },
    },
}

# The exporter rewrites ds-base.js to load the design system from bundle
# blobs, so the bundled copy is kept as-is rather than replaced from source.
KEEP_BUNDLED = {'./ds-base.js'}

def block_span(s, kind):
    m = re.search(r'(<script type="__bundler/%s">)(.*?)(</script>)' % kind, s, re.S)
    return m.start(2), m.end(2), m.group(2)

def camel_to_sc(name):
    return 'sc-camel-' + re.sub(r'([A-Z])', lambda m: '-' + m.group(1).lower(), name)

def encode_markup(html):
    # The bundler stores the parsed DOM, where attribute case is lost, so
    # camelCase attributes travel as sc-camel-kebab. Script bodies are left alone.
    parts = re.split(r'(<script\b[^>]*>.*?</script>)', html, flags=re.S)
    out = []
    for p in parts:
        if p.startswith('<script'):
            head, body = re.match(r'(<script\b[^>]*>)(.*)', p, re.S).groups()
            out.append(fix_tag(head) + body)
        else:
            out.append(re.sub(r'<[a-zA-Z][^<>]*>', lambda m: fix_tag(m.group(0)), p))
    return ''.join(out)

def fix_tag(tag):
    tag = re.sub(r'(\s)([a-z]+[A-Z][A-Za-z]*)(?==)', lambda m: m.group(1) + camel_to_sc(m.group(2)), tag)
    return re.sub(r'(\s)data-dc-script(?=[\s>])', r'\1data-dc-script=""', tag)

def build_template(t):
    html = t['page'].read_text()
    html = re.sub(r'<template id="__bundler_thumbnail">.*?</template>', '', html, flags=re.S)
    for path, uuid in t['assets'].items():
        html = html.replace('src="%s"' % path, 'src="%s"' % uuid)
    html = encode_markup(html)
    # Match the DOM serializer the bundle was first exported with.
    html = re.sub(r'(<(?:input|img|br|hr|meta|link)\b[^<>]*?)\s*/>', r'\1>', html)
    html = re.sub(r'(<html\b[^>]*>)\n<head>', r'\1<head>', html, count=1)
    return re.sub(r'\n*</body>\s*</html>\s*$', '\n\n\n</body></html>', html)

def decoded(s):
    manifest = json.loads(block_span(s, 'manifest')[2])
    assets = {}
    for uuid, e in manifest.items():
        b = base64.b64decode(e['data'])
        assets[uuid] = (e['mime'], gzip.decompress(b) if e.get('compressed') else b)
    return assets, json.loads(block_span(s, 'template')[2]), re.sub(
        r'(<script type="__bundler/(?:manifest|template)">).*?</script>', r'\1', s, flags=re.S)

def rebuild(t, check):
    s = t['out'].read_text()
    man_a, man_b, man_raw = block_span(s, 'manifest')
    manifest = json.loads(man_raw)
    for path, uuid in t['assets'].items():
        if path in KEEP_BUNDLED:
            continue
        data = (t['page'].parent / path).resolve().read_bytes()
        entry = manifest[uuid]
        if entry.get('compressed'):
            data = gzip.compress(data, mtime=0)
        entry['data'] = base64.b64encode(data).decode()
    new = s[:man_a] + json.dumps(manifest, separators=(',', ':')) + s[man_b:]
    tpl_a, tpl_b, _ = block_span(new, 'template')
    tpl = json.dumps(build_template(t)).replace('</', '<\\/')
    new = new[:tpl_a] + tpl + new[tpl_b:]
    if check:
        fresh = decoded(new) == decoded(s)
        print(t['out'].relative_to(ROOT), 'up to date' if fresh else 'STALE')
        return fresh
    t['out'].write_text(new)
    print('wrote', t['out'].relative_to(ROOT), len(new), 'bytes')
    return True

def main():
    names = [a for a in sys.argv[1:] if not a.startswith('-')] or list(TARGETS)
    bad = [n for n in names if n not in TARGETS]
    if bad:
        sys.exit('unknown target: %s (choose from %s)' % (', '.join(bad), ', '.join(TARGETS)))
    check = '--check' in sys.argv
    ok = [rebuild(TARGETS[n], check) for n in names]
    sys.exit(0 if all(ok) else 1)

if __name__ == '__main__':
    main()
