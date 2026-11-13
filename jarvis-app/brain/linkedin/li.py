#!/usr/bin/env python3
"""LinkedIn worker for maya-brain. The Node bridge runs it as a short child process:

  li.py probe              read-only: conversation count and latest thread titles
  li.py poll               print new inbound messages as JSON (does NOT mark them seen)
  li.py mark ID [ID...]    mark message ids seen, after the bridge delivered their card
  li.py send               stdin JSON {"conversation": urn, "text": str}; sends one message

Auth is the li_at + JSESSIONID cookie pair from the env (never a username or password), on a
linkedin-api session. LinkedIn retired the legacy /messaging/conversations endpoints the library
wraps (500 as of 2026-11-13), so this talks to the Dash messenger finders LinkedIn's web app uses:
they need no rotating GraphQL queryId.
Exit codes: 0 ok, 3 LinkedIn refused the session (re-copy cookie), 4 other failure.
Message text from LinkedIn is untrusted data; this file only moves it, never acts on it.
"""
import json
import os
import re
import sys
import time
import uuid
from urllib.parse import quote

STATE_DIR = os.environ.get("MAYA_STATE_DIR", "/var/lib/maya-brain")
SEEN_FILE = os.path.join(STATE_DIR, "linkedin-seen.json")
EXIT_AUTH, EXIT_FAIL = 3, 4
CONV_URN = re.compile(r"^urn:li:msg_conversation:\(urn:li:fsd_profile:[A-Za-z0-9_\-]{10,60},2-[A-Za-z0-9=_+/\-]{4,200}\)$")
PROFILE_URN = re.compile(r"^urn:li:fsd_profile:[A-Za-z0-9_\-]{10,60}$")
PARTICIPANT = "urn:li:msg_messagingParticipant:"
BOOTSTRAP_DAYS = 14   # first run: surface unanswered inbound threads newer than this
BOOTSTRAP_MAX = 5
MAX_TEXT = 8000       # LinkedIn's own limit is 8000 characters
FALLBACK_PAGE = 20    # q=conversation page size; a full page means the newest are missing
SEEN_CAP = 5000
JSON_ACCEPT = "application/vnd.linkedin.normalized+json+2.1"


class AuthError(Exception):
    """LinkedIn refused the cookie: 401/403, a redirect to login/checkpoint, 999, or a challenge."""


# ---------- pure helpers (unit-tested) ----------

def is_auth_failure(status: int, location: str = "", body: str = "") -> bool:
    if status in (401, 403, 999):
        return True
    if 300 <= status < 400 and re.search(r"/(login|checkpoint|uas/login|authwall)", location or ""):
        return True
    return "CHALLENGE" in (body or "")[:2000]


def enc(urn: str) -> str:
    """Encode a URN the way LinkedIn's app does: parentheses and commas too (%28 %29 %2C)."""
    return quote(urn, safe="")


def parse_conversations(payload: dict):
    """Dash messengerConversations (q=syncToken) -> [{conversation, title, at}], newest first."""
    out = []
    for c in (payload or {}).get("included") or []:
        if c.get("$type") != "com.linkedin.messenger.Conversation":
            continue
        urn = c.get("entityUrn") or ""
        if not CONV_URN.match(urn):
            continue
        if ((c.get("conversationTypeText") or {}).get("text") or "").strip().lower() == "sponsored":
            continue  # ad InMail: can't be answered, never worth a card
        title = c.get("title") or c.get("headlineText") or c.get("shortHeadlineText") or c.get("conversationTypeText") or "Someone"
        if isinstance(title, dict):  # TextViewModel {text: ...}
            title = title.get("text") or "Someone"
        out.append({"conversation": urn, "title": str(title)[:120], "at": int(c.get("lastActivityAt") or 0)})
    return sorted(out, key=lambda c: -c["at"])


def parse_messages(payload: dict, conv: str, title: str):
    """Dash messengerMessages (q=syncToken or q=conversation) -> [{id, conversation, sender, sender_urn, text, at}].
    Only messages that name `conv` as their own conversation: a draft must never go to a thread
    the message didn't come from, so a missing or different conversationUrn is dropped."""
    out = []
    for m in (payload or {}).get("included") or []:
        if m.get("$type") != "com.linkedin.messenger.Message":
            continue
        if m.get("conversationUrn") != conv:
            continue
        text = ((m.get("body") or {}).get("text")) or ""
        mid = m.get("entityUrn")
        if not mid or not text.strip():
            continue
        sender = str(m.get("senderUrn") or m.get("actorUrn") or "")
        if sender.startswith(PARTICIPANT):
            sender = sender[len(PARTICIPANT):]
        if not sender:
            continue  # unknown author: never guess, it could be Manoj's own message
        subject = m.get("subject")
        body = f"[{subject}]\n{text}" if subject else text
        out.append({"id": mid, "conversation": conv, "sender": title, "sender_urn": sender,
                    "text": str(body)[:MAX_TEXT], "at": int(m.get("deliveredAt") or 0)})
    return out


def thread_candidates(msgs, me_urn):
    """Messages in one thread that could need a reply: dedupe, oldest first, only those after
    Manoj's own latest message there (anything before it he already answered). Not capped here:
    the cap applies to unseen ones in cmd_poll, so nothing older is silently watermarked away."""
    by_id = {m["id"]: m for m in msgs}
    ordered = sorted(by_id.values(), key=lambda m: m["at"])
    mine = [m["at"] for m in ordered if m.get("sender_urn") == me_urn]
    if mine:
        # Strictly after his reply: a same-millisecond or undated (at=0) message is treated as answered.
        ordered = [m for m in ordered if m["at"] > max(mine)]
    return ordered, list(by_id)


def select_new(messages, seen: set, me_urn: str, bootstrap: bool, now_ms: int):
    """Inbound (not from me), unseen messages, oldest first. On the very first run only recent
    threads come through (others are marked seen by the caller) so history doesn't flood Telegram."""
    picked = [m for m in messages if m["id"] not in seen and m.get("sender_urn") != me_urn]
    if bootstrap:
        cutoff = now_ms - BOOTSTRAP_DAYS * 86400_000
        picked = [m for m in picked if m["at"] >= cutoff]
        picked.sort(key=lambda m: m["at"], reverse=True)
        picked = picked[:BOOTSTRAP_MAX]
    return sorted(picked, key=lambda m: m["at"])


def load_seen(path=None):
    path = path or SEEN_FILE
    try:
        with open(path) as f:
            d = json.load(f)
        return {"ids": list(d.get("ids", [])), "bootstrapped": bool(d.get("bootstrapped")),
                "threads": dict(d.get("threads", {})), "names": dict(d.get("names", {}))}
    except (FileNotFoundError, ValueError):
        return {"ids": [], "bootstrapped": False, "threads": {}, "names": {}}


def save_seen(state, path=None):
    path = path or SEEN_FILE
    state = {"ids": state["ids"][-SEEN_CAP:], "bootstrapped": state["bootstrapped"],
             "threads": state.get("threads", {}), "names": dict(list(state.get("names", {}).items())[-500:])}
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def mark_seen(ids, path=None):
    st = load_seen(path)
    have = set(st["ids"])
    st["ids"] += [i for i in ids if i not in have]
    save_seen(st, path)


def profile_name(payload: dict) -> str:
    """First + last name from an /identity/dash/profiles response, or ''."""
    for x in ((payload or {}).get("included") or []) + [(payload or {}).get("data") or {}]:
        if x.get("firstName"):
            return " ".join(v for v in (x.get("firstName"), x.get("lastName")) if v).strip()[:80]
    return ""


def changed_threads(convs, threads: dict, bootstrap: bool, now_ms: int):
    """Threads worth fetching: activity newer than the last time we found nothing to show there.
    On the first run, only threads active in the last BOOTSTRAP_DAYS."""
    cutoff = now_ms - BOOTSTRAP_DAYS * 86400_000
    out = []
    for c in convs:
        if bootstrap and c["at"] < cutoff:
            continue
        if c["at"] > int(threads.get(c["conversation"], 0)):
            out.append(c)
    return out


# ---------- LinkedIn I/O ----------

class Session:
    BASE = "https://www.linkedin.com/voyager/api"

    def __init__(self):
        li_at, jsid, ua = (os.environ.get(k, "") for k in ("LINKEDIN_LI_AT", "LINKEDIN_JSESSIONID", "LINKEDIN_UA"))
        if not li_at or not jsid:
            raise AuthError("cookie not set")
        from requests.cookies import RequestsCookieJar
        from linkedin_api import Linkedin
        jar = RequestsCookieJar()
        jar.set("li_at", li_at, domain=".linkedin.com", path="/")
        jar.set("JSESSIONID", f'"{jsid}"', domain=".www.linkedin.com", path="/")
        self.api = Linkedin("", "", cookies=jar)
        self.http = self.api.client.session
        if ua:
            self.http.headers["user-agent"] = ua
        self._me = None

    def _check(self, res):
        body = res.text if res.status_code not in (200, 201) else ""
        if is_auth_failure(res.status_code, res.headers.get("location", ""), body):
            raise AuthError(f"status {res.status_code}")
        if res.status_code not in (200, 201):
            raise RuntimeError(f"linkedin status {res.status_code}")
        try:
            return res.json() if res.text else {}
        except ValueError:
            raise AuthError("non-JSON reply (likely a login page)")

    def get(self, path_and_query, accept=None):
        # Built as a string: requests would leave ( ) , unencoded and LinkedIn then answers 400.
        res = self.api._fetch(path_and_query, evade=lambda: None, allow_redirects=False, timeout=30,
                              headers={"accept": accept} if accept else None)
        return self._check(res)

    def me_urn(self):
        if self._me is None:
            mp = (self.get("/me") or {}).get("miniProfile") or {}
            urn = mp.get("dashEntityUrn") or ""
            self._me = urn if PROFILE_URN.match(urn) else ""
        return self._me

    def conversations(self):
        me = self.me_urn()
        if not me:
            raise RuntimeError("could not tell which messages are Manoj's own")
        d = self.get(f"/voyagerMessagingDashMessengerConversations?q=syncToken&mailboxUrn={enc(me)}", JSON_ACCEPT)
        return parse_conversations(d)

    def name(self, urn):
        """Just the sender's name for the card. Never fatal: a refused lookup is not a dead session."""
        if not PROFILE_URN.match(urn or ""):
            return ""
        try:
            return profile_name(self.get(f"/identity/dash/profiles/{enc(urn)}", JSON_ACCEPT))
        except Exception:  # noqa: BLE001
            return ""

    def messages(self, conv, title):
        if not CONV_URN.match(conv):
            raise ValueError("bad conversation id")
        # q=syncToken returns the NEWEST messages. q=conversation pages from the OLDEST (verified live
        # 2026-11-13: a long thread's 20 came back from 2023-2024), so it is only a fallback when
        # syncToken itself fails. An empty syncToken answer (e.g. attachments only) is trusted as-is:
        # re-reading from the oldest end there would resurface stale messages.
        try:
            d = self.get(f"/voyagerMessagingDashMessengerMessages?q=syncToken&conversationUrn={enc(conv)}", JSON_ACCEPT)
            return parse_messages(d, conv, title)
        except RuntimeError:
            pass  # AuthError is not a RuntimeError: it is not retried via the fallback (cmd_poll counts it as skipped)
        d = self.get(f"/voyagerMessagingDashMessengerMessages?q=conversation&conversationUrn={enc(conv)}"
                     f"&count={FALLBACK_PAGE}", JSON_ACCEPT)
        raw = [m for m in (d or {}).get("included") or [] if m.get("$type") == "com.linkedin.messenger.Message"]
        if len(raw) >= FALLBACK_PAGE:
            # A full page from the oldest end means the thread is longer and its newest are missing.
            raise RuntimeError("thread longer than one fallback page; newest messages not visible")
        return parse_messages(d, conv, title)

    def send(self, conv, text):
        if not CONV_URN.match(conv):
            raise ValueError("bad conversation id")
        if not text.strip() or len(text) > MAX_TEXT:
            raise ValueError("empty or too long")
        from linkedin_api.utils.helpers import generate_trackingId_as_charString
        me = self.me_urn()
        if not me:
            raise RuntimeError("could not tell which mailbox is Manoj's")
        payload = {
            "message": {"body": {"attributes": [], "text": text}, "renderContentUnions": [],
                        "conversationUrn": conv, "originToken": str(uuid.uuid4())},
            "mailboxUrn": me,
            "trackingId": generate_trackingId_as_charString(),
            "dedupeByClientGeneratedToken": False,
        }
        res = self.api._post("/voyagerMessagingDashMessengerMessages?action=createMessage", evade=lambda: None,
                             data=json.dumps(payload), allow_redirects=False, timeout=30,
                             headers={"content-type": "text/plain;charset=UTF-8", "accept": "application/json"})
        if 200 <= res.status_code < 300:
            return  # sent; the body shape doesn't matter
        self._check(res)  # raises AuthError or RuntimeError with the status


def cmd_probe(s):
    convs = s.conversations()
    print(json.dumps({"conversations": len(convs), "latest_threads": [c["title"] for c in convs[:5]]}))


def cmd_poll(s):
    st = load_seen()
    seen = set(st["ids"])
    me = s.me_urn()
    if not me:
        raise RuntimeError("could not tell which messages are Manoj's own")
    convs = s.conversations()
    bootstrap = not st["bootstrapped"]
    now = int(time.time() * 1000)
    msgs, visible, quiet, skipped, failed = [], [], [], 0, set()
    for c in changed_threads(convs, st["threads"], bootstrap, now):
        try:
            cand, ids = thread_candidates(s.messages(c["conversation"], c["title"]), me)
        except (RuntimeError, AuthError):
            skipped += 1  # reported in the output so the bridge logs it
            failed.add(c["conversation"])
            continue  # one refused thread is not a dead session; it retries next poll
        time.sleep(1)  # gentle pacing between thread reads
        visible += ids
        unseen = [m for m in cand if m["id"] not in seen and m["sender_urn"] != me]
        if not unseen:
            quiet.append(c)  # nothing to show here: skip it until it changes again
        msgs += unseen[-10:]  # one card holds at most 10; the rest come next poll
    new = select_new(msgs, seen, me, bootstrap, now)
    shown = {m["conversation"] for m in new}
    for c in quiet:
        if c["conversation"] not in shown:
            st["threads"][c["conversation"]] = c["at"]
    if bootstrap:
        # Everything visible now that isn't being surfaced counts as already handled.
        keep = {m["id"] for m in new}
        st["ids"] += [i for i in dict.fromkeys(visible) if i not in keep and i not in seen]
        for c in convs:  # old threads: start watching from their current activity
            if c["conversation"] not in shown and c["conversation"] not in failed:  # unread: retry next poll
                st["threads"].setdefault(c["conversation"], c["at"])
        st["bootstrapped"] = True
    names = st.setdefault("names", {})
    for m in new:
        urn = m.pop("sender_urn", None)
        if urn and urn not in names:
            n = s.name(urn)
            if n:
                names[urn] = n
        m["sender"] = names.get(urn) or m["sender"]
    save_seen(st)
    print(json.dumps({"messages": new, "skipped": skipped}))


def cmd_send(s):
    req = json.loads(sys.stdin.read())
    s.send(str(req["conversation"]), str(req["text"]))
    print(json.dumps({"sent": True}))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    try:
        if cmd == "mark":
            mark_seen(argv[2:])
            print(json.dumps({"marked": len(argv) - 2}))
            return 0
        fn = {"probe": cmd_probe, "poll": cmd_poll, "send": cmd_send}.get(cmd)
        if not fn:
            print(json.dumps({"error": "usage"}))
            return EXIT_FAIL
        fn(Session())
        return 0
    except AuthError as e:
        print(json.dumps({"error": "auth", "detail": str(e)}))
        return EXIT_AUTH
    except Exception as e:  # noqa: BLE001 - one line out, never a stack trace with data in it
        print(json.dumps({"error": type(e).__name__, "detail": str(e)[:200]}))
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main(sys.argv))
