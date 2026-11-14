# Download the interface fonts to src/fonts/ (tools/.venv/bin/python tools/fetch_fonts.py).
#   Rajdhani 500/600/700: headings, labels and numerals, latin subset.
# SIL Open Font License 1.1; the licence text is saved alongside the fonts.
# Running text and small print use the platform's own UI face, so nothing is downloaded for them.
import re
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import certifi                      # the python.org build of Python does not ship the system root certificates
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'fonts'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/130.0 Safari/537.36')


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        return r.read()


def css_faces(css):
    # [(subset name, weight, font URL, unicode-range)]
    out = []
    for m in re.finditer(r'(?:/\* ([\w-]+) \*/\s*)?@font-face \{(.*?)\}', css, re.S):
        body = m.group(2)
        url = re.search(r'url\((\S+?)\) format', body).group(1)
        weight = re.search(r'font-weight: (\d+)', body).group(1)
        rng = re.search(r'unicode-range: ([^;]+);', body)
        out.append((m.group(1) or '', weight, url, rng.group(1) if rng else ''))
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    css = get('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700').decode()
    for _, w, url, rng in (f for f in css_faces(css) if f[0] == 'latin'):
        (OUT / f'rajdhani-{w}.woff2').write_bytes(get(url))
        print(f'rajdhani-{w}.woff2  unicode-range: {rng}')

    meta = get('https://fonts.google.com/metadata/fonts/Rajdhani').decode()
    lic = re.search(r'"license"\s*:\s*"([^"]+)"', meta)
    print(f'Rajdhani licence: {lic.group(1) if lic else "see OFL-Rajdhani.txt"}')


if __name__ == '__main__':
    main()
