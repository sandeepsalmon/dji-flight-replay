#!/usr/bin/env python3
"""Bundle the dji-replay-web sources into a single self-contained HTML file.
Run any time you change the JS/CSS to refresh the standalone file:
    python3 scripts/build.py
The output, index.standalone.html, is what to open over file://.
"""
import re
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
# Source template (modular, with <script src="js/main.js">)
SRC = os.path.join(ROOT, 'src', 'index.html')
# Bundled output (what end users open)
OUT = os.path.join(ROOT, 'index.html')

JS_ORDER = ['srt.js', 'mp4.js', 'dji.js', 'viewer.js', 'main.js']

# Strip relative `import { x } from './y.js'` lines, keep CDN/three imports.
LOCAL_IMPORT = re.compile(r"^\s*import\s*(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)?\s*(?:from\s+)?['\"]\./[^'\"]+['\"];?\s*\n?", re.MULTILINE)
EXPORT_PREFIX = re.compile(r"^\s*export\s+(default\s+)?(?=(async\s+)?(function|class|const|let|var)\s)", re.MULTILINE)
EXPORT_DEFAULT_LINE = re.compile(r"^\s*export\s+default\s+\w+;\s*\n?", re.MULTILINE)


def merge_js() -> str:
    parts = []
    for name in JS_ORDER:
        with open(os.path.join(ROOT, 'js', name), 'r', encoding='utf-8') as f:
            src = f.read()
        src = LOCAL_IMPORT.sub('', src)
        src = EXPORT_PREFIX.sub('', src)
        src = EXPORT_DEFAULT_LINE.sub('', src)
        parts.append(f'// ===== {name} =====\n{src.rstrip()}\n')
    return '\n'.join(parts)


def main():
    with open(SRC, 'r', encoding='utf-8') as f:
        html = f.read()
    with open(os.path.join(ROOT, 'css', 'style.css'), 'r', encoding='utf-8') as f:
        css = f.read()
    js = merge_js()

    # Inline the stylesheet
    html = html.replace(
        '<link rel="stylesheet" href="css/style.css">',
        f'<style>\n{css}\n</style>',
    )
    # Replace external module loader with the bundled module. (THREE imports
    # are already inside viewer.js, which becomes part of `js`.)
    bundle_block = '<script type="module">\n' + js + '\n</script>'
    html = html.replace(
        '<script type="module" src="js/main.js"></script>',
        bundle_block,
    )

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    size = os.path.getsize(OUT)
    print(f"Wrote {OUT} ({size/1024:.0f} KB)")


if __name__ == '__main__':
    main()
