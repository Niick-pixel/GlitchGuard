"""Updates: find newer releases and, in the packaged app, install them.

Checking is one anonymous request to GitHub's public API. Nothing about the
user or their deals is sent.

Installing is only ever done by the packaged app, and only for a release that
carries a valid signature from the GlitchGuard release key. That key lives on
the developer's PC, never on GitHub, so a compromised GitHub account could
publish a release but could not make installed copies accept it. A checksum
published alongside the zip would not give that guarantee - whoever can upload
the zip can upload the checksum too.

The flow:
  1. check()  - is there a newer release?
  2. stage()  - download its .sig, verify the signature, download the zip,
                verify size and SHA-256 against the signed record, unpack it
                into data/updates, and mark it ready.
  3. apply()  - hand off to a small installer script that waits for the app
                to exit, swaps GlitchGuard.exe and _internal\\, restores the
                old ones if anything fails, and relaunches. data\\ - settings,
                history, tokens - is never touched.
A staged update installs itself the next time the app starts, or at once from
the Restart to update button.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile

from . import __version__, config

# The repository was renamed from price-error-hunter. Copies at 1.0.2 still
# ask for the old name and reach this one through GitHub's redirect, which
# holds only while no new repository takes the old name on this account.
REPO = "Niick-pixel/GlitchGuard"
LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
# Lets the update flow be exercised against a local server. It cannot be used
# to install anything unsigned: every package is still verified against the
# key below, wherever it was fetched from.
FEED = os.environ.get("GLITCHGUARD_UPDATE_FEED") or LATEST
TIMEOUT = 15

# Ed25519 public half of the release key. tools/sign.py refuses to sign with a
# key that does not match this, so a release can never be published that the
# installed copies would then reject.
PUBLIC_KEY = "5HM+xjpqek/L3hPHacXv+w12XnuxM3YEbfsYw7Uci5s="

UPDATES_DIR = os.path.join(config.DATA_DIR, "updates")
READY_FILE = os.path.join(UPDATES_DIR, "ready.json")
RESULT_FILE = os.path.join(UPDATES_DIR, "result.json")
HANDOFF_FILE = os.path.join(UPDATES_DIR, "handoff.json")
INSTALLER = os.path.join(UPDATES_DIR, "install-update.ps1")

MAX_SIG_BYTES = 16 * 1024
MAX_ZIP_BYTES = 300 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024

_lock = threading.Lock()
_busy = threading.Lock()
_assets = {}
_result = {
    "current": __version__, "checked": False, "latest": None, "newer": False,
    "url": None, "error": None,
    # idle | checking | downloading | ready | error
    "state": "idle", "progress": None, "ready": None,
    # Whether this copy can install updates itself; a plain browser run or a
    # source checkout only ever shows the link.
    "can_install": config.FROZEN,
    "last_install": None,
}


def _set(**changes):
    with _lock:
        _result.update(changes)


def status():
    with _lock:
        return dict(_result)


def _parse(tag):
    """'v1.2.3' or '1.2.3' -> (1, 2, 3); anything unparseable sorts lowest."""
    nums = re.findall(r"\d+", tag or "")
    return tuple(int(n) for n in nums[:3]) if nums else (0,)


def _newer(version):
    return _parse(version) > _parse(__version__)


# ------------------------------------------------------------- verification

def _message(version, filename, sha256, size):
    # Must match tools/sign.py byte for byte. Version and filename are signed
    # with the hash so an old, genuinely signed release cannot be replayed
    # under a newer version number to downgrade an install.
    return f"GlitchGuard update|{version}|{filename}|{sha256}|{size}".encode()


def _signature_ok(record):
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY))
        key.verify(base64.b64decode(record["signature"]),
                   _message(record["version"], record["file"],
                            record["sha256"], record["size"]))
        return True
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return False


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_record(record, zip_path):
    """(ok, reason) for a signed record against a downloaded zip."""
    needed = ("version", "file", "sha256", "size", "signature")
    if not isinstance(record, dict) or any(k not in record for k in needed):
        return False, "signature file is incomplete"
    if not _signature_ok(record):
        return False, "signature does not match the GlitchGuard release key"
    if os.path.getsize(zip_path) != record["size"]:
        return False, "download size does not match the signed size"
    if _sha256(zip_path) != record["sha256"]:
        return False, "download contents do not match the signed hash"
    return True, ""


# ---------------------------------------------------------------- transport

def _url_ok(url):
    if url.startswith("https://"):
        return True
    # Plain HTTP only for a local test feed, and only when one was set.
    return FEED != LATEST and url.startswith("http://127.0.0.1")


def _open(url):
    if not _url_ok(url):
        raise ValueError(f"refusing non-HTTPS download: {url}")
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json, application/octet-stream",
        "User-Agent": f"GlitchGuard/{__version__}",
    })
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def _download(url, dest, limit, total=None):
    """Stream to dest, refusing anything over limit. Reports progress."""
    got = 0
    with _open(url) as resp, open(dest, "wb") as out:
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            got += len(chunk)
            if got > limit:
                raise ValueError("download is larger than any release should be")
            out.write(chunk)
            if total:
                _set(progress=min(99, round(got * 100 / total)))
    return got


# ------------------------------------------------------------------- check

def check():
    """Ask GitHub for the latest release. Failures are recorded, never raised,
    because a missing network must never stop the app starting."""
    _set(state="checking", error=None)
    info = {"checked": True, "latest": None, "newer": False, "url": None,
            "error": None}
    try:
        with _open(FEED) as resp:
            data = json.loads(resp.read(1024 * 1024).decode("utf-8"))
        tag = data.get("tag_name") or ""
        version = tag.lstrip("vV")
        info.update(latest=version or None, url=data.get("html_url"),
                    newer=_newer(version))
        _assets.clear()
        for asset in data.get("assets") or []:
            _assets[asset.get("name")] = asset
    except urllib.error.HTTPError as exc:
        # 404 simply means no release has been published yet.
        info["error"] = None if exc.code == 404 else f"HTTP {exc.code}"
    except Exception as exc:
        info["error"] = type(exc).__name__
    with _lock:
        _result.update(info)
        if _result["state"] == "checking":
            _result["state"] = "ready" if _result.get("ready") else "idle"
    return status()


def check_async():
    threading.Thread(target=check, daemon=True).start()


# ------------------------------------------------------------------- stage

def _safe_extract(zip_path, dest):
    """Unpack only what a GlitchGuard release contains: one GlitchGuard\\
    folder, no absolute paths, no '..', and a sane unpacked size."""
    with zipfile.ZipFile(zip_path) as zf:
        members = zf.infolist()
        total = 0
        for info in members:
            name = info.filename.replace("\\", "/")
            parts = name.split("/")
            if (name.startswith("/") or ":" in name or ".." in parts
                    or parts[0] != "GlitchGuard"):
                raise ValueError(f"unexpected path in update: {info.filename}")
            total += info.file_size
        if total > MAX_UNPACKED_BYTES:
            raise ValueError("update unpacks to an implausible size")
        zf.extractall(dest)
    app = os.path.join(dest, "GlitchGuard")
    if not (os.path.isfile(os.path.join(app, "GlitchGuard.exe"))
            and os.path.isdir(os.path.join(app, "_internal"))):
        raise ValueError("update is missing GlitchGuard.exe or _internal")
    return app


def _remove_partial_downloads():
    if not os.path.isdir(UPDATES_DIR):
        return
    for name in os.listdir(UPDATES_DIR):
        if name.endswith((".part", ".sig")):
            try:
                os.remove(os.path.join(UPDATES_DIR, name))
            except OSError:
                pass


# Files the installer writes are read with utf-8-sig: Windows PowerShell 5.1
# writes UTF-8 with a byte-order mark, which json.load rejects - and a result
# that cannot be read would hide a failed install and retry it forever.
def _last_failed(version):
    try:
        with open(RESULT_FILE, encoding="utf-8-sig") as fh:
            res = json.load(fh)
        return res.get("version") == version and not res.get("ok")
    except (OSError, ValueError):
        return False


def stage(manual=False):
    """Download, verify and unpack the newer release. Packaged app only."""
    if not config.FROZEN:
        return status()
    with _lock:
        latest, newer = _result["latest"], _result["newer"]
    if not (latest and newer):
        return status()
    ready = pending()
    if ready and ready["version"] == latest:
        _set(state="ready", ready=latest, progress=None)
        return status()
    if _last_failed(latest) and not manual:
        # Installing this exact version already failed once; do not loop on
        # it every six hours. "Check now" in Settings tries again.
        _set(state="error", error=f"installing {latest} failed - see data\\updates\\install.log")
        return status()
    if not _busy.acquire(blocking=False):
        return status()
    try:
        name = f"GlitchGuard-{latest}-portable.zip"
        zip_asset, sig_asset = _assets.get(name), _assets.get(name + ".sig")
        if not zip_asset or not sig_asset:
            # An unsigned release is never installed automatically.
            _set(state="error", error="this release is not signed - update by hand")
            return status()

        os.makedirs(UPDATES_DIR, exist_ok=True)
        _set(state="downloading", progress=0, error=None)

        sig_path = os.path.join(UPDATES_DIR, name + ".sig")
        _download(sig_asset["browser_download_url"], sig_path, MAX_SIG_BYTES)
        with open(sig_path, encoding="utf-8") as fh:
            record = json.load(fh)
        # Check the signature before spending 20 MB on a download it would
        # not unlock anyway.
        if not _signature_ok(record):
            raise ValueError("signature does not match the GlitchGuard release key")
        if record.get("version") != latest or record.get("file") != name:
            raise ValueError("signature is for a different release")

        zip_path = os.path.join(UPDATES_DIR, name + ".part")
        _download(zip_asset["browser_download_url"], zip_path,
                  min(MAX_ZIP_BYTES, record["size"]), total=record["size"])
        ok, why = verify_record(record, zip_path)
        if not ok:
            raise ValueError(why)

        staged_root = os.path.join(UPDATES_DIR, f"staged-{latest}")
        shutil.rmtree(staged_root, ignore_errors=True)
        app = _safe_extract(zip_path, staged_root)
        os.remove(zip_path)
        os.remove(sig_path)

        with open(READY_FILE, "w", encoding="utf-8") as fh:
            json.dump({"version": latest, "dir": app}, fh)
        _set(state="ready", ready=latest, progress=None, error=None)
    except Exception as exc:
        _remove_partial_downloads()
        _set(state="error", progress=None,
             error=f"update not installed: {exc}"[:200])
    finally:
        _busy.release()
    return status()


def check_and_stage(auto=True, manual=False):
    check()
    if auto:
        stage(manual=manual)
    return status()


# ------------------------------------------------------------------- apply

def pending():
    """The staged update, if one is ready and newer than this copy."""
    try:
        with open(READY_FILE, encoding="utf-8-sig") as fh:
            info = json.load(fh)
    except (OSError, ValueError):
        return None
    if (_newer(info.get("version", ""))
            and os.path.isfile(os.path.join(info.get("dir", ""), "GlitchGuard.exe"))):
        return info
    return None


def handoff_failed():
    """True when a previous apply() started an installer that never ran.

    The installer always removes ready.json, whether it succeeds or not. If a
    hand-off was made over two minutes ago and ready.json is still here, the
    script never started - PowerShell blocked by policy, say - and trying
    again at every launch would leave the app unable to start at all.
    """
    try:
        with open(HANDOFF_FILE, encoding="utf-8-sig") as fh:
            at = json.load(fh).get("at", 0)
    except (OSError, ValueError):
        return False
    return os.path.exists(READY_FILE) and time.time() - at > 120


def startup():
    """Run once at launch: tidy up after an install and report its result."""
    try:
        with open(RESULT_FILE, encoding="utf-8-sig") as fh:
            _set(last_install=json.load(fh))
    except (OSError, ValueError):
        pass
    ready = None
    try:
        with open(READY_FILE, encoding="utf-8-sig") as fh:
            ready = json.load(fh)
    except (OSError, ValueError):
        pass
    if ready and not _newer(ready.get("version", "")):
        # Already running this version or later: the staged copy is spent.
        try:
            os.remove(READY_FILE)
        except OSError:
            pass
    info = pending()
    if os.path.isdir(UPDATES_DIR):
        # Drop any staged copy that is not the one waiting to be installed.
        keep = os.path.dirname(info["dir"]) if info else None
        for entry in os.listdir(UPDATES_DIR):
            path = os.path.join(UPDATES_DIR, entry)
            if entry.startswith("staged-") and path != keep:
                shutil.rmtree(path, ignore_errors=True)
        _remove_partial_downloads()
    if info:
        _set(state="ready", ready=info["version"])


INSTALLER_PS1 = r'''
param([int]$WaitPid, [string]$AppDir, [string]$Staged, [string]$Version, [switch]$Tray)
# Written by GlitchGuard before it exits. Swaps in the staged version, puts the
# old one back if anything goes wrong, and relaunches. Never touches data\.
$ErrorActionPreference = "Stop"
$updates = Join-Path $AppDir "data\updates"
$log = Join-Path $updates "install.log"
function Log([string]$m) { Add-Content -LiteralPath $log -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m) }
function Retry([scriptblock]$Do) {
    # OneDrive and antivirus briefly lock files that were just written.
    for ($i = 1; $i -le 30; $i++) {
        try { & $Do; return } catch { if ($i -eq 30) { throw }; Start-Sleep -Milliseconds 500 }
    }
}
function Result([bool]$Ok, [string]$Err) {
    @{ version = $Version; ok = $Ok; error = $Err; at = (Get-Date).ToString("s") } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $updates "result.json") -Encoding UTF8
}

Log "installing $Version, waiting for GlitchGuard (pid $WaitPid) to close"
try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction Stop } catch { }
if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
    Log "GlitchGuard did not close - nothing changed"
    Result $false "GlitchGuard did not close"
    Remove-Item -LiteralPath (Join-Path $updates "ready.json") -Force -ErrorAction SilentlyContinue
    exit 1
}

$exe = Join-Path $AppDir "GlitchGuard.exe"
$int = Join-Path $AppDir "_internal"
$oldExe = "$exe.old"
$oldInt = "$int.old"
$ok = $false
try {
    if (Test-Path -LiteralPath $oldInt) { Retry { Remove-Item -LiteralPath $oldInt -Recurse -Force } }
    if (Test-Path -LiteralPath $oldExe) { Retry { Remove-Item -LiteralPath $oldExe -Force } }
    Retry { Rename-Item -LiteralPath $int -NewName "_internal.old" }
    Retry { Rename-Item -LiteralPath $exe -NewName "GlitchGuard.exe.old" }
    Retry { Move-Item -LiteralPath (Join-Path $Staged "_internal") -Destination $int }
    Retry { Move-Item -LiteralPath (Join-Path $Staged "GlitchGuard.exe") -Destination $exe }
    $ok = $true
    Log "installed $Version"
} catch {
    $err = $_.Exception.Message
    Log "install failed: $err - restoring the previous version"
    try {
        if (Test-Path -LiteralPath $oldInt) {
            if (Test-Path -LiteralPath $int) { Remove-Item -LiteralPath $int -Recurse -Force }
            Rename-Item -LiteralPath $oldInt -NewName "_internal"
        }
        if (Test-Path -LiteralPath $oldExe) {
            if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force }
            Rename-Item -LiteralPath $oldExe -NewName "GlitchGuard.exe"
        }
        Log "previous version restored"
    } catch { Log "RESTORE FAILED: $($_.Exception.Message)" }
    Result $false $err
}

if ($ok) {
    Result $true ""
    try { Remove-Item -LiteralPath $oldInt -Recurse -Force -ErrorAction Stop } catch { Log "could not remove $oldInt yet" }
    try { Remove-Item -LiteralPath $oldExe -Force -ErrorAction Stop } catch { }
}
Remove-Item -LiteralPath (Join-Path $updates "ready.json") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $updates "handoff.json") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Split-Path -Parent $Staged) -Recurse -Force -ErrorAction SilentlyContinue

if ($Tray) { Start-Process -FilePath $exe -ArgumentList "--tray" } else { Start-Process -FilePath $exe }
Log "relaunched"
'''


def apply(tray=False):
    """Start the installer and return True; the caller must then exit.

    Returns False, changing nothing, if there is no staged update or the
    installer could not be started - in which case the app carries on.
    """
    info = pending()
    if not info or not config.FROZEN:
        return False
    try:
        os.makedirs(UPDATES_DIR, exist_ok=True)
        with open(INSTALLER, "w", encoding="utf-8-sig") as fh:
            fh.write(INSTALLER_PS1)
        powershell = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                  "System32", "WindowsPowerShell", "v1.0",
                                  "powershell.exe")
        args = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
                "Bypass", "-WindowStyle", "Hidden", "-File", INSTALLER,
                "-WaitPid", str(os.getpid()), "-AppDir", config.APP_DIR,
                "-Staged", info["dir"], "-Version", info["version"]]
        if tray:
            args.append("-Tray")
        with open(HANDOFF_FILE, "w", encoding="utf-8") as fh:
            json.dump({"version": info["version"], "at": time.time()}, fh)
        CREATE_NO_WINDOW, CREATE_NEW_PROCESS_GROUP = 0x08000000, 0x00000200
        subprocess.Popen(args, cwd=UPDATES_DIR, close_fds=True,
                         creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
        return True
    except Exception as exc:
        _set(state="error", error=f"could not start the installer: {exc}"[:200])
        return False
