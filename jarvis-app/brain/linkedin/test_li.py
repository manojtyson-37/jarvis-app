import json
import os
import tempfile
import unittest

import li

ME = "urn:li:fs_miniProfile:ME"
DAY = 86400_000
NOW = 1_800_000_000_000


def ev(eid, text, who="urn:li:fs_miniProfile:P", first="Pushpita", last="Mazumdar", at=NOW):
    return {"entityUrn": eid, "createdAt": at,
            "from": {"com.linkedin.voyager.messaging.MessagingMember": {"miniProfile": {"firstName": first, "lastName": last, "entityUrn": who}}},
            "eventContent": {"com.linkedin.voyager.messaging.event.MessageEvent": {"attributedBody": {"text": text}}}}


def msg(i, at=NOW, who="urn:li:fs_miniProfile:P"):
    return {"id": i, "conversation": "2-abc", "sender": "P", "sender_urn": who, "text": "hi", "at": at}


class Dedupe(unittest.TestCase):
    def test_seen_ids_are_skipped(self):
        out = li.select_new([msg("a"), msg("b")], {"a"}, ME, False, NOW)
        self.assertEqual([m["id"] for m in out], ["b"])

    def test_my_own_messages_are_skipped(self):
        self.assertEqual(li.select_new([msg("a", who=ME)], set(), ME, False, NOW), [])

    def test_oldest_first(self):
        out = li.select_new([msg("new", NOW), msg("old", NOW - 5)], set(), ME, False, NOW)
        self.assertEqual([m["id"] for m in out], ["old", "new"])

    def test_bootstrap_limits_history(self):
        msgs = [msg(f"r{i}", NOW - i) for i in range(8)] + [msg("ancient", NOW - 30 * DAY)]
        out = li.select_new(msgs, set(), ME, True, NOW)
        self.assertEqual(len(out), li.BOOTSTRAP_MAX)
        self.assertNotIn("ancient", [m["id"] for m in out])

    def test_after_bootstrap_old_unseen_still_surfaces(self):
        out = li.select_new([msg("x", NOW - 30 * DAY)], set(), ME, False, NOW)
        self.assertEqual(len(out), 1)

    def test_mark_and_reload_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "seen.json")
            li.mark_seen(["a", "b"], p)
            li.mark_seen(["b", "c"], p)
            st = li.load_seen(p)
            self.assertEqual(st["ids"], ["a", "b", "c"])
            out = li.select_new([msg("a"), msg("c"), msg("d")], set(st["ids"]), ME, False, NOW)
            self.assertEqual([m["id"] for m in out], ["d"])

    def test_corrupt_seen_file_is_empty_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "seen.json")
            open(p, "w").write("{oops")
            self.assertEqual(li.load_seen(p), {"ids": [], "bootstrapped": False, "threads": {}, "names": {}})

    def test_seen_store_is_capped(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "seen.json")
            li.save_seen({"ids": [str(i) for i in range(li.SEEN_CAP + 50)], "bootstrapped": True}, p)
            st = li.load_seen(p)
            self.assertEqual(len(st["ids"]), li.SEEN_CAP)
            self.assertEqual(st["ids"][-1], str(li.SEEN_CAP + 49))  # newest kept


CONV = "urn:li:msg_conversation:(urn:li:fsd_profile:MEMEMEMEMEMEMEME,2-ZjE2YWJj==)"


class Thread(unittest.TestCase):
    def test_newest_first_input_comes_out_oldest_first(self):
        cand, ids = li.thread_candidates([msg("e3", NOW), msg("e2", NOW - 10), msg("e1", NOW - 20)], ME)
        self.assertEqual([m["id"] for m in cand], ["e1", "e2", "e3"])

    def test_messages_before_my_reply_are_dropped(self):
        cand, ids = li.thread_candidates([msg("old", NOW - 30), msg("mine", NOW - 20, who=ME), msg("new", NOW)], ME)
        self.assertEqual([m["id"] for m in cand], ["new"])
        self.assertEqual(set(ids), {"old", "mine", "new"})

    def test_answered_thread_has_no_candidates(self):
        cand, _ = li.thread_candidates([msg("q", NOW - 30), msg("mine", NOW, who=ME)], ME)
        self.assertEqual(cand, [])

    def test_not_capped_so_older_unseen_survive(self):
        cand, _ = li.thread_candidates([msg(f"m{i}", NOW - 100 + i) for i in range(30)], ME)
        self.assertEqual(len(cand), 30)
        self.assertEqual(cand[-1]["id"], "m29")

    def test_changed_threads(self):
        convs = [{"conversation": "a", "at": NOW}, {"conversation": "b", "at": NOW - 5}, {"conversation": "old", "at": NOW - 30 * DAY}]
        self.assertEqual([c["conversation"] for c in li.changed_threads(convs, {"b": NOW - 5}, False, NOW)], ["a", "old"])
        self.assertEqual([c["conversation"] for c in li.changed_threads(convs, {}, True, NOW)], ["a", "b"])


class Parsing(unittest.TestCase):
    def test_conversation_list(self):
        payload = {"included": [
            {"$type": "com.linkedin.messenger.Conversation", "entityUrn": CONV, "title": "Pushpita Mazumdar", "lastActivityAt": NOW},
            {"$type": "com.linkedin.messenger.Conversation", "entityUrn": "urn:li:msg_conversation:(x/../y)", "title": "bad", "lastActivityAt": NOW},
            {"$type": "com.linkedin.messenger.Message", "entityUrn": "m"},
            {"$type": "com.linkedin.messenger.Conversation", "entityUrn": CONV.replace("ZjE2", "QUQx"), "conversationTypeText": {"text": "Sponsored"}, "lastActivityAt": NOW},
        ]}
        out = li.parse_conversations(payload)
        self.assertEqual(out, [{"conversation": CONV, "title": "Pushpita Mazumdar", "at": NOW}])

    def test_messages(self):
        payload = {"included": [
            {"$type": "com.linkedin.messenger.Message", "entityUrn": "urn:li:msg_message:1", "deliveredAt": str(NOW),
             "senderUrn": "urn:li:msg_messagingParticipant:urn:li:fsd_profile:PUSHPITA00000", "subject": "Hiring PM",
             "body": {"text": "Please share your CV"}},
            {"$type": "com.linkedin.messenger.Message", "entityUrn": "urn:li:msg_message:2", "body": {"text": "  "}},
            {"$type": "com.linkedin.messenger.Message", "entityUrn": "urn:li:msg_message:3", "body": {"text": "no sender"}},
        ]}
        out = li.parse_messages(payload, CONV, "Pushpita Mazumdar")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["sender_urn"], "urn:li:fsd_profile:PUSHPITA00000")
        self.assertEqual(out[0]["text"], "[Hiring PM]\nPlease share your CV")
        self.assertEqual(out[0]["at"], NOW)
        self.assertEqual(out[0]["sender"], "Pushpita Mazumdar")

    def test_text_capped(self):
        payload = {"included": [{"$type": "com.linkedin.messenger.Message", "entityUrn": "u", "senderUrn": "urn:li:fsd_profile:X", "body": {"text": "x" * 20000}}]}
        self.assertEqual(len(li.parse_messages(payload, CONV, "t")[0]["text"]), li.MAX_TEXT)

    def test_profile_name(self):
        self.assertEqual(li.profile_name({"included": [{"firstName": "Sanjeev", "lastName": "K"}]}), "Sanjeev K")
        self.assertEqual(li.profile_name({"data": {}}), "")

    def test_name_lookup_never_fatal(self):
        s = li.Session.__new__(li.Session)
        def boom(*a, **k): raise li.AuthError("403")
        s.get = boom
        self.assertEqual(s.name("urn:li:fsd_profile:ABCDEFGHIJKL"), "")
        self.assertEqual(s.name("urn:li:fsd_company:123"), "")

    def test_urn_encoding_matches_linkedin(self):
        self.assertEqual(li.enc("urn:li:x:(a,b)"), "urn%3Ali%3Ax%3A%28a%2Cb%29")

    def test_conversation_urn_rejects_tricks(self):
        self.assertFalse(li.CONV_URN.match("urn:li:msg_conversation:(urn:li:fsd_profile:AAAAAAAAAA,2-a)&x=1"))
        self.assertTrue(li.CONV_URN.match(CONV))


class AuthDetection(unittest.TestCase):
    def test_statuses(self):
        for s in (401, 403, 999):
            self.assertTrue(li.is_auth_failure(s))
        self.assertFalse(li.is_auth_failure(200))
        self.assertFalse(li.is_auth_failure(500))

    def test_redirect_to_login(self):
        self.assertTrue(li.is_auth_failure(302, "https://www.linkedin.com/login?session_redirect=x"))
        self.assertTrue(li.is_auth_failure(303, "https://www.linkedin.com/checkpoint/challenge/x"))
        self.assertFalse(li.is_auth_failure(302, "https://www.linkedin.com/feed/"))

    def test_challenge_body(self):
        self.assertTrue(li.is_auth_failure(400, "", '{"status":"CHALLENGE"}'))


class Cli(unittest.TestCase):
    def test_no_cookie_is_auth_exit(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("LINKEDIN_")}
        old = os.environ.copy()
        os.environ.clear(); os.environ.update(env)
        try:
            self.assertEqual(li.main(["li.py", "probe"]), li.EXIT_AUTH)
        finally:
            os.environ.clear(); os.environ.update(old)

    def test_poll_refuses_when_me_unknown(self):
        class S:
            def me_urn(self): return ""
            def conversations(self): return []
        with tempfile.TemporaryDirectory() as d:
            old = li.SEEN_FILE; li.SEEN_FILE = os.path.join(d, "s.json")
            try:
                with self.assertRaises(RuntimeError):
                    li.cmd_poll(S())
            finally:
                li.SEEN_FILE = old

    def test_unknown_command(self):
        self.assertEqual(li.main(["li.py", "nope"]), li.EXIT_FAIL)

    def test_send_refuses_bad_conversation_id(self):
        s = li.Session.__new__(li.Session)
        with self.assertRaises(ValueError):
            s.send("../me", "hi")
        with self.assertRaises(ValueError):
            s.send(CONV, "   ")


if __name__ == "__main__":
    unittest.main()
