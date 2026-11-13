#!/usr/bin/env python3
"""Runs ON THE DROPLET as root. Reads three lines on stdin (li_at, JSESSIONID, user agent),
checks their shapes and writes them into /etc/maya-brain.env (mode 600), replacing any old
LINKEDIN_* lines. Never prints a value, only whether each one looked right."""
import os
import re
import sys
import tempfile

ENV = os.environ.get("MAYA_ENV_FILE", "/etc/maya-brain.env")
KEYS = ("LINKEDIN_LI_AT", "LINKEDIN_JSESSIONID", "LINKEDIN_UA")

LI_AT = re.compile(r"^[A-Za-z0-9_\-]{80,1000}$")
JSID = re.compile(r"^ajax:[0-9]{8,30}$")
UA = re.compile(r"^Mozilla/5\.0 \([^\"\n]{5,120}\) [^\"\n]{10,200}$")


def clean(v: str) -> str:
    return v.strip().strip('"').strip()


def main() -> int:
    lines = sys.stdin.read().split("\n")
    if len(lines) < 3:
        print("error: expected 3 lines")
        return 1
    li_at, jsid, ua = (clean(x) for x in lines[:3])
    checks = {"li_at": bool(LI_AT.match(li_at)), "JSESSIONID": bool(JSID.match(jsid)), "user agent": bool(UA.match(ua))}
    for name, ok in checks.items():
        print(f"{name}: {'ok' if ok else 'WRONG SHAPE'}")
    if not all(checks.values()):
        print("nothing written")
        return 1

    old = open(ENV).read() if os.path.exists(ENV) else ""
    kept = [l for l in old.splitlines() if l.strip() and not l.startswith(tuple(k + "=" for k in KEYS))]
    kept += [f"LINKEDIN_LI_AT={li_at}", f"LINKEDIN_JSESSIONID={jsid}", f'LINKEDIN_UA="{ua}"']
    # Validate the new content BEFORE touching the real file.
    bad = [l for l in kept if not re.match(r"^[A-Z_][A-Z0-9_]*=", l) and not l.lstrip().startswith("#")]
    if bad:
        print(f"error: {len(bad)} malformed line(s) already in the env file; nothing written")
        return 1
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(ENV), prefix=".maya-env-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write("\n".join(kept) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, ENV)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    # Read back: every key present exactly once, every line KEY=value.
    back = open(ENV).read().splitlines()
    for k in KEYS:
        n = sum(1 for l in back if l.startswith(k + "="))
        if n != 1:
            print(f"error: {k} appears {n} times")
            return 1
    print(f"saved to {ENV} (mode {oct(os.stat(ENV).st_mode & 0o777)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
