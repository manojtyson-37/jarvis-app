// Away Mode chat commands: runs a parsed intent (intent.ts) and returns the reply text. No model involved.
import 'server-only';
import { getOwnAddress } from '@/lib/gmail';
import { buildDigest, sendDraft } from './live';
import { formatDigest } from './digest';
import { inr, SHADOW_HOURS } from './policy';
import type { AwayIntent } from './intent';
import * as store from './store';

const when = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

export async function handleAwayIntent(intent: AwayIntent, userId: string): Promise<string> {
  switch (intent.kind) {
    case 'start': {
      // Refuse to start blind: an away trip with no mailbox access would look active while doing nothing.
      const own = await getOwnAddress();
      if (!own) return "I can't start away mode: Gmail isn't connected right now (the Google token has expired). Run `node scripts/google-reauth.mjs` once from the Maya folder, then tell me again.";
      const { session, extended } = await store.startSession(userId, intent.until, intent.thresholdInr);
      const faqs = (await store.listFaqs(userId)).length;
      const shadow = session.shadowUntil.getTime() > Date.now();
      return [
        extended ? `Away mode extended until ${when(session.endsAt)} IST.` : `Away mode is ON until ${when(session.endsAt)} IST. I'm watching ${own}.`,
        shadow ? `For the first ${SHADOW_HOURS} hours (until ${when(session.shadowUntil)}) I only DRAFT replies. Nothing is sent. After that I answer plain FAQ-style questions myself.` : 'The draft-only period is over, so I answer plain FAQ-style questions myself.',
        `I escalate to you straight away for anything at or above ${inr(session.thresholdInr)}, legal matters and complaints. Everything else I can't answer waits for the 8:30 pm IST report.`,
        faqs ? `I know ${faqs} FAQ ${faqs === 1 ? 'entry' : 'entries'}.` : `I have no FAQ entries yet, so I can only lean on your past sent replies. Teach me with "FAQ: our office hours are 10 to 6".`,
        `"I'm back" ends it. "Kill away mode" halts everything immediately.`,
      ].join('\n');
    }
    case 'stop':
    case 'kill': {
      const session = await store.getActiveSession(userId);
      if (!session) return 'Away mode is not on.';
      const rows = await store.digestRows(session.id);
      await store.endSession(session.id, intent.kind === 'kill' ? 'killed' : 'ended');
      const report = formatDigest(session, rows, new Date());
      return intent.kind === 'kill'
        ? `Away mode killed. I will not read or send anything more.\n\n${report}`
        : `Welcome back. Away mode is off.\n\n${report}`;
    }
    case 'status': {
      const session = await store.getActiveSession(userId);
      if (!session) return 'Away mode is not on.';
      const rows = await store.digestRows(session.id);
      return `Away mode is ON until ${when(session.endsAt)} IST (escalate at ${inr(session.thresholdInr)}+${session.shadowUntil.getTime() > Date.now() ? `; drafting only until ${when(session.shadowUntil)}` : ''}).\n\n${formatDigest(session, rows, new Date())}`;
    }
    case 'threshold': {
      const ok = await store.setThreshold(userId, intent.thresholdInr);
      return ok
        ? `Done. I'll escalate to you immediately for anything at or above ${inr(intent.thresholdInr)}.`
        : `No away trip is on. Tell me together: "I'm away until Friday, escalate over ${inr(intent.thresholdInr)}".`;
    }
    case 'drafts': {
      const session = await store.getActiveSession(userId);
      if (!session) return 'Away mode is not on, so there are no drafts.';
      const drafts = (await store.listDrafts(session.id)).filter(d => !d.delivered);
      if (!drafts.length) return 'No drafts are waiting.';
      // Every draft is shown in full: "send draft N" must never send words that were not on screen. Past the size budget
      // a draft is listed by number only and read in full with "show draft N".
      let budget = 6000;
      const shown: string[] = [], hidden: number[] = [];
      for (const d of drafts) {
        const block = `${d.n}. To ${d.from} — "${d.subject}"\n${d.reply}`;
        if (block.length > budget) { hidden.push(d.n); continue; }
        budget -= block.length; shown.push(block);
      }
      return `${drafts.length} draft${drafts.length === 1 ? '' : 's'} waiting. Say "send draft N" to send one.\n\n${shown.join('\n\n')}${hidden.length ? `\n\nNot shown here (too long): ${hidden.join(', ')}. Say "show draft N" to read one in full before sending.` : ''}`;
    }
    case 'show_draft': {
      const session = await store.getActiveSession(userId);
      if (!session) return 'Away mode is not on, so there are no drafts.';
      const d = (await store.listDrafts(session.id)).find(x => x.n === intent.n);
      if (!d) return `There is no draft ${intent.n}.`;
      if (d.delivered) return `Draft ${intent.n} was already sent.`;
      return `Draft ${intent.n}, to ${d.from} — "${d.subject}"\n${d.reply}\n\nSay "send draft ${intent.n}" to send exactly this.`;
    }
    case 'send_draft':
      return sendDraft(userId, intent.n);
    case 'faq_add': {
      const added = await store.addFaq(userId, intent.text);
      return added ? `Saved. While you're away I may answer from this: "${intent.text.slice(0, 200)}"` : 'I already have that FAQ entry.';
    }
    case 'faq_list': {
      const faqs = await store.listFaqs(userId);
      return faqs.length ? `Your FAQ (what I may tell people while you're away):\n${faqs.map((f, i) => `${i + 1}. ${f.fact}`).join('\n')}\n\nSay "forget faq N" to remove one.` : 'No FAQ entries yet. Add one with "FAQ: our office hours are 10 to 6".';
    }
    case 'faq_remove': {
      const faqs = await store.listFaqs(userId);
      const f = faqs[intent.n - 1];
      if (!f) return faqs.length ? `There is no FAQ ${intent.n}. You have ${faqs.length}.` : 'No FAQ entries to remove.';
      await store.removeFaq(userId, f.id);
      return `Removed FAQ ${intent.n}: "${f.fact.slice(0, 120)}"`;
    }
  }
}

export { buildDigest };
