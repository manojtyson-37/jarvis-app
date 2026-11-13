#!/bin/bash
# Run on your Mac. Asks for the two LinkedIn cookies (typing is hidden), adds your Chrome
# user agent, and writes all three into /etc/maya-brain.env on the maya-brain droplet.
# The values go straight over ssh; nothing is saved on the Mac or printed.
set -euo pipefail
HOST=root@143.110.183.143
SSHKEY="$HOME/.ssh/id_rsa_do"

V=$(defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString 2>/dev/null | cut -d. -f1 || true)
if [ -z "$V" ]; then echo "Could not find Google Chrome's version."; exit 1; fi
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$V.0.0.0 Safari/537.36"

echo "In Chrome: open linkedin.com, press Cmd+Option+I, go to Application > Cookies > https://www.linkedin.com"
echo "Double-click the Value cell of each cookie, copy it, and paste it below."
read -rsp "li_at value: " LIAT; echo
read -rsp "JSESSIONID value: " JSID; echo

printf '%s\n%s\n%s\n' "$LIAT" "$JSID" "$UA" | ssh -i "$SSHKEY" -o IdentitiesOnly=yes "$HOST" \
  'python3 /opt/maya-brain/linkedin/set_env.py && systemctl restart maya-brain && echo "Maya restarted with the new cookie."'
unset LIAT JSID
