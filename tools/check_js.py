"""Fail the build if any script in web/ does not even parse.

1.0.8 and 1.0.9 shipped a line break inside a string literal in app.js. One
syntax error stops the whole script, so the window sat on "Loading the deal
feed..." forever while the backend worked perfectly. Nothing caught it,
because nothing ever parsed the JavaScript before release.

Node is not installed here, but Edge is: each file is compiled with
new Function(source) in headless Edge, which parses without running anything,
so no DOM, server or token is needed.

    python tools/check_js.py
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EDGE_PATHS = [
    pathlib.Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe",
    pathlib.Path(os.environ.get("ProgramFiles", "")) / "Microsoft/Edge/Application/msedge.exe",
]

PAGE = """<!doctype html><meta charset="utf-8"><body><pre id="out"></pre><script>
const files = %s;
const lines = [];
for (const [name, src] of Object.entries(files)) {
  try { new Function(src); lines.push("OK " + name); }
  catch (e) { lines.push("FAIL " + name + ": " + e.name + ": " + e.message); }
}
document.getElementById("out").textContent = lines.join("\\n");
</script>"""


def main():
    edge = next((p for p in EDGE_PATHS if p.exists()), None)
    if not edge:
        print("check_js: Microsoft Edge not found - cannot check the scripts")
        return 2
    files = {p.name: p.read_text(encoding="utf-8")
             for p in sorted((ROOT / "web").glob("*.js"))}
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / "check.html"
        page.write_text(PAGE % json.dumps(files), encoding="utf-8")
        result = subprocess.run(
            [str(edge), "--headless=new", "--disable-gpu", "--no-first-run",
             f"--user-data-dir={pathlib.Path(tmp) / 'profile'}",
             "--dump-dom", page.as_uri()],
            capture_output=True, text=True, encoding="utf-8", timeout=120)
    out = result.stdout
    start, end = out.find('<pre id="out">'), out.find("</pre>")
    report = out[start + len('<pre id="out">'):end] if start >= 0 and end > start else ""
    lines = [l for l in report.replace("&gt;", ">").replace("&lt;", "<")
             .replace("&amp;", "&").splitlines() if l.strip()]
    for line in lines:
        print("check_js:", line)
    if len(lines) != len(files):
        print("check_js: Edge did not report on every script")
        return 1
    return 1 if any(l.startswith("FAIL") for l in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
