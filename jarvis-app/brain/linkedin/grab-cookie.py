#!/usr/bin/env python3
"""Run on the Mac. Reads LinkedIn's li_at and JSESSIONID from your logged-in Chrome and writes them,
with your Chrome user agent, into /etc/maya-brain.env on the maya-brain droplet, then restarts Maya.
macOS asks you to Allow access to "Chrome Safe Storage" once; that click is the only step.
No value is printed or saved on the Mac; they go straight into ssh's stdin."""
import glob
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HOST = "root@143.110.183.143"
SSHKEY = os.path.expanduser("~/.ssh/id_rsa_do")
CHROME = os.path.expanduser("~/Library/Application Support/Google/Chrome")


def chrome_key() -> bytes:
    pw = subprocess.run(["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"],
                        capture_output=True, text=True)
    if pw.returncode != 0:
        sys.exit("Keychain access was not allowed, so nothing was read.")
    return hashlib.pbkdf2_hmac("sha1", pw.stdout.strip().encode(), b"saltysalt", 1003, 16)


def decrypt(enc: bytes, key: bytes, db_version: int) -> str:
    if enc[:3] != b"v10":
        raise ValueError("unknown cookie encryption")
    p = subprocess.run(["openssl", "enc", "-d", "-aes-128-cbc", "-K", key.hex(), "-iv", "20" * 16],
                       input=enc[3:], capture_output=True)
    if p.returncode != 0:
        raise ValueError("could not decrypt")
    plain = p.stdout[32:] if db_version >= 24 else p.stdout  # newer Chrome prefixes a 32-byte domain hash
    return plain.decode()


def read_profile(db_path, key):
    tmp = tempfile.mkdtemp()
    try:
        for f in glob.glob(db_path + "*"):  # copy with -wal/-journal so a running Chrome doesn't lock us out
            shutil.copy(f, tmp)
        con = sqlite3.connect(os.path.join(tmp, os.path.basename(db_path)))
        ver = int((con.execute("select value from meta where key='version'").fetchone() or [0])[0])
        rows = con.execute(
            "select name, encrypted_value, last_access_utc from cookies "
            "where host_key like '%linkedin.com' and name in ('li_at','JSESSIONID')").fetchall()
        con.close()
        out = {}
        for name, enc, last in rows:
            if name not in out or last > out[name][1]:
                out[name] = (decrypt(enc, key, ver), last)
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    dbs = glob.glob(os.path.join(CHROME, "*", "Cookies")) + glob.glob(os.path.join(CHROME, "*", "Network", "Cookies"))
    if not dbs:
        sys.exit("No Chrome profile found.")
    key = chrome_key()
    best = None
    for db in dbs:
        try:
            c = read_profile(db, key)
        except Exception:
            continue
        if "li_at" in c and "JSESSIONID" in c:
            if not best or c["li_at"][1] > best["li_at"][1]:
                best = c
    if not best:
        sys.exit("No signed-in LinkedIn found in Chrome. Open linkedin.com in Chrome, sign in, then run this again.")
    ver = subprocess.run(["defaults", "read", "/Applications/Google Chrome.app/Contents/Info", "CFBundleShortVersionString"],
                         capture_output=True, text=True).stdout.strip().split(".")[0]
    ua = f"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver}.0.0.0 Safari/537.36"
    payload = f"{best['li_at'][0]}\n{best['JSESSIONID'][0]}\n{ua}\n"
    r = subprocess.run(["ssh", "-i", SSHKEY, "-o", "IdentitiesOnly=yes", HOST,
                        "python3 /opt/maya-brain/linkedin/set_env.py && systemctl restart maya-brain && echo 'Maya restarted with the new cookie.'"],
                       input=payload, text=True)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
