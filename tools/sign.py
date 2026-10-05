"""Sign GlitchGuard releases so installed copies will accept them as updates.

    python tools/sign.py init                    create the signing key (once)
    python tools/sign.py sign <zip> <version>    write <zip>.sig beside it
    python tools/sign.py verify <zip>            check a .sig against the zip

Why a signature rather than a checksum: the app installs updates without a
human in the loop, so the thing to defend against is a release that is not
yours - a compromised GitHub account, for instance. A checksum published in
the same release proves nothing then, because whoever uploads the zip uploads
the checksum too. The private key lives only on this PC, so a valid signature
proves the release came from here.

The key is kept outside the repository and outside OneDrive. Back it up
somewhere private. If it is lost, installed copies can still update by hand,
but they will refuse any automatic update signed with a new key - that is the
point - so the next release would have to be installed manually once.
"""

import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

KEY_DIR = os.path.join(os.path.expanduser("~"), ".glitchguard-signing")
KEY_PATH = os.path.join(KEY_DIR, "release-key.pem")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _message(version, filename, sha256, size):
    # Version and filename are signed along with the hash, so a genuinely
    # signed old release cannot be replayed under a newer version number.
    return f"GlitchGuard update|{version}|{filename}|{sha256}|{size}".encode()


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_key():
    if not os.path.exists(KEY_PATH):
        sys.exit(f"No signing key at {KEY_PATH}. Run: python tools/sign.py init")
    with open(KEY_PATH, "rb") as fh:
        return serialization.load_pem_private_key(fh.read(), password=None)


def _public_b64(key):
    raw = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def init():
    if os.path.exists(KEY_PATH):
        key = _load_key()
        print(f"A key already exists at {KEY_PATH}; not replacing it.")
    else:
        os.makedirs(KEY_DIR, exist_ok=True)
        key = Ed25519PrivateKey.generate()
        pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        # Exclusive create, so a race can never silently replace a key.
        with open(KEY_PATH, "xb") as fh:
            fh.write(pem)
        print(f"Created {KEY_PATH}")
        print("Back this file up somewhere private. Never commit or share it.")
    print(f"Public key (goes in glitchguard/updates.py): {_public_b64(key)}")


def sign(zip_path, version):
    from glitchguard import updates
    key = _load_key()
    if _public_b64(key) != updates.PUBLIC_KEY:
        sys.exit("This key does not match PUBLIC_KEY in glitchguard/updates.py, "
                 "so installed copies would reject the signature. Refusing.")
    name = os.path.basename(zip_path)
    size = os.path.getsize(zip_path)
    digest = _sha256(zip_path)
    sig = key.sign(_message(version, name, digest, size))
    record = {"version": version, "file": name, "sha256": digest, "size": size,
              "signature": base64.b64encode(sig).decode()}
    with open(zip_path + ".sig", "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    print(f"Signed {name} ({size:,} bytes) as version {version}")


def verify(zip_path):
    from glitchguard import updates
    with open(zip_path + ".sig", encoding="utf-8") as fh:
        record = json.load(fh)
    ok, why = updates.verify_record(record, zip_path)
    print("valid" if ok else f"INVALID: {why}")
    return ok


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["init"]:
        init()
    elif args[:1] == ["sign"] and len(args) == 3:
        sign(args[1], args[2])
    elif args[:1] == ["verify"] and len(args) == 2:
        sys.exit(0 if verify(args[1]) else 1)
    else:
        sys.exit(__doc__)
