import Groq from 'groq-sdk';
import { NextRequest, NextResponse, after } from 'next/server';
import { buildSystemPrompt } from '@/lib/context';
import {
  getConversationHistory, appendConversation,
  getPromptFacts, getRules, saveRule,
} from '@/lib/supabase';
import { getEmail, fetchMessageSummaries } from '@/lib/gmail';
import { readDriveFile } from '@/lib/drive';
import { historyForModel, gmailLookupIntent, isPlaceholderReply, calendarReadIntent } from '@/lib/chatContext';
import { selectTools } from '@/lib/toolRouting';
import { analysisIntent, GROUNDABLE, GROUNDED_SYSTEM, groundedUser, needsLookIds, driveReadableIds } from '@/lib/grounded';
import { answerInboxTopic } from '@/lib/inboxSearch';
import { parseStandingInstruction, ruleSavedReply, rulesBlock } from '@/lib/instructions';
import { GATED_TOOLS, queueAction } from '@/lib/actions';
import { parseReplyIntent, handleReply } from '@/lib/replyIntent';
import { mailWriteIntent } from '@/lib/routingGuards';
import { parseAwayIntent } from '@/lib/away/intent';
import { handleAwayIntent } from '@/lib/away/chat';
import { parseTodoCapture } from '@/lib/todos/capture';
import { insertTodos } from '@/lib/todos/store';
import { runTodoBatch } from '@/lib/todos/runner';
import { parseGoalIntent, parseCancelGoal } from '@/lib/agent/intent';
import { startAgentRun, runAgent, cancelAgentRuns } from '@/lib/agent/runner';
import { groq, PRIMARY_MODEL, withFallback, fallbackOpts, TOOLS, executeTool } from '@/lib/chatTools';
import { shouldRetryToolUseFailed, reportedError } from '@/lib/groqErrors';

// Vercel's default would otherwise cut a long tool-plus-summary turn off with no message.
// The reply itself is cut at 52s (see the deadline below); the extra time is for the to-do run that follows a capture.
export const maxDuration = 300;

export async function GET() {
  const history = await getConversationHistory('manoj', 40);
  // Placeholder replies from earlier builds are junk, not answers; hide them from the chat view (rows stay stored).
  return NextResponse.json({ history: history.filter(h => !isPlaceholderReply(h.role, h.content)) });
}

// Tools whose result skips the 2nd (narration) Groq call and gets returned raw instead.
// Two distinct reasons a tool lands here:
//  (a) write/confirm actions — a narrated "I did X" adds nothing over the raw confirmation.
//  (b) high-risk factual lookups — confirmed (a ticket lookup, Gmail inbox) that the narration
//      pass will sometimes disregard the real tool result already in context and fabricate a
//      different, wrong, plausible-sounding answer instead. Forcing tool_choice on the FIRST
//      call only guarantees the tool gets called; it does nothing to stop the SECOND call from
//      ignoring that real result, since that pass still runs with tool_choice:'auto'. Skipping
//      it entirely for these tools removes the fabrication opportunity structurally rather than
//      relying on a prompt instruction the model has already shown it won't reliably follow.
// send_email and the other gated tools ARE here now: they only queue an approval request, so the
// raw "Waiting for your approval: ..." text must reach the user verbatim — a narration pass could
// wrongly claim the action already happened.
// KNOWN GAP, not closed by this set: a turn where the model calls one of these tools ALONGSIDE
// a tool NOT in this set (e.g. list_emails + get_calendar_events together) falls through
// to the normal narration path below with tool_choice:'auto' — the exact same unresolved
// fabrication risk this set exists to avoid, just for a mixed-tool turn instead of a single-tool
// one. This is unchanged risk, not reduced risk, for any multi-tool-type turn.
const SKIP_NARRATION_TOOLS = new Set([
  'save_note', 'delete_note', 'set_reminder', 'mark_reminder_done',
  'log_workout', 'log_expense', 'log_income', 'delete_calendar_event',
  'complete_action_item', 'send_email', 'create_calendar_event',
  'list_emails', 'get_email', 'list_labels', 'search_drive', 'read_drive_file',
]);

const ACTIONISH = /\b(send|add|remind|log|save|delete|cancel|set|create|schedule|book|mark|find|search|read|summari[sz]e|move|reschedule|forward|open|list)\b/i;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const wf = <T,>(call: (model: string) => Promise<T>) => withFallback(call, startedAt);
  const { message } = await req.json();
  // Test isolation: outside production only, an eval run can act as its own throwaway user so it never
  // touches Manoj's real notes, reminders or chat history. Deployed builds always run with NODE_ENV=production.
  const evalHeader = process.env.NODE_ENV !== 'production' ? req.headers.get('x-maya-eval-user') : null;
  const evalUser = evalHeader && /^cso-eval-[a-z0-9-]{1,48}$/.test(evalHeader) ? evalHeader : null;
  const userId = evalUser ?? 'manoj';

  if (!message?.trim()) return NextResponse.json({ error: 'Empty message' }, { status: 400 });

  const history = await getConversationHistory(userId, 10);
  const [memoryFacts, rules] = await Promise.all([getPromptFacts(userId, 20), getRules(userId)]);

  // The model has shown it will sometimes skip a lookup tool entirely and fabricate a plausible but wrong answer
  // (finish_reason 'stop', no tool_calls: a detailed fake inbox when the real unread count was 0). So a clear lookup
  // message forces tool_choice to that specific read function; the model still writes the reply. Never generic
  // 'required': that could force an unrelated write from the full tool list.
  // A Gmail message ID is a long hex string — check for one BEFORE the general inbox-check
  // match below, so "show me email <id>" routes to get_email rather than getting swept into
  // the broader "show...email" inbox-check pattern and incorrectly forced to list_emails.
  const emailIdMatch = !mailWriteIntent(message) && /\b(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b/i.test(message);
  // Scoped to email/Gmail context, not bare "label" — otherwise "what label would you give
  // this idea" or "add a label to this note" would wrongly force a Gmail tool call too.
  const labelMatch = /\blabels?\b.{0,20}\b(email|gmail|inbox)\b|\b(email|gmail|inbox)\b.{0,20}\blabels?\b/i.test(message);
  // "gmail" (without send/draft/reply intent) forces the read-only lookup: "I connected my gmail account" matched
  // nothing, so the model answered from stale chat history (old Jodo lists) instead of checking the inbox.
  // An explicit "send an email to X" must reach send_email (which only QUEUES it for approval). Left on 'auto',
  // the model sometimes skipped the tool and answered as if the email had been handled. "draft" is excluded on
  // purpose: there is no draft tool, and a draft request must never queue a send.
  const sendMailMatch = !emailIdMatch && !labelMatch
    && (/\b(send|shoot|fire off)\s+(?:an?\s+|the\s+)?(?:e-?mail|mail)\b.{0,80}(?:\bto\b|@)/i.test(message) || /\b(?:e-?mail|mail)\s+[\w.+-]+@[\w-]+\.\w+/i.test(message))
    && !/\b(draft|compose|write|unread|inbox)\b|\bsend me\b|\b(don'?t|do not|never|not)\b/i.test(message);
  const inboxCheckMatch = !emailIdMatch && !labelMatch && !mailWriteIntent(message)
    && (/\b(unread|inbox)\b|\b(check|show|read|any|list)\b.{0,20}\b(emails?|mail)\b/i.test(message) || gmailLookupIntent(message));
  const forcedToolChoice = emailIdMatch
    ? { type: 'function' as const, function: { name: 'get_email' } }
    : labelMatch
      ? { type: 'function' as const, function: { name: 'list_labels' } }
      : sendMailMatch
        ? { type: 'function' as const, function: { name: 'send_email' } }
        : inboxCheckMatch
          ? { type: 'function' as const, function: { name: 'list_emails' } }
          : calendarReadIntent(message)
            ? { type: 'function' as const, function: { name: 'get_calendar_events' } }
            : 'auto' as const;

  // Only the tool definitions this message can need — see toolRouting.ts for why.
  const forcedName = typeof forcedToolChoice === 'object' ? forcedToolChoice.function.name : undefined;
  const recent = history.slice(-4).map(h => h.content.slice(0, 300));
  const turnTools = selectTools(TOOLS, message, recent, forcedName);
  const ruleTexts = rules.map(r => r.fact);
  // "What about jobs?" then "In my inbox": the question is about job emails, not the whole inbox.
  const prevUser = [...history].slice(-2).reverse().find(h => h.role === 'user')?.content;

  await appendConversation(userId, 'user', message);

  // "My to-dos: a, b" (the check-in push prefills this) or "add X to my to-dos": saved, then worked on right after the
  // reply goes out. The runner reports in chat and by push when it finishes.
  const todoCapture = parseTodoCapture(message);
  let todosSaved: Promise<number> | null = null;
  if (todoCapture) {
    todosSaved = insertTodos(userId, todoCapture.items, todoCapture.source).then(r => r.length);
    after(async () => {
      if (!(await todosSaved!.catch(() => 0))) return;
      await runTodoBatch(userId, { limit: 3, budgetMs: 150_000 }).catch(e => console.error('[todos] run after capture failed:', (e as Error).message));
    });
  }

  // A multi-step goal ("find a slot next week, draft an invite and email, then send it"): saved as an agent run and
  // worked through in the background after the reply goes out. To-do lists and standing rules keep their own paths.
  const goal = !todoCapture && !parseStandingInstruction(message) ? parseGoalIntent(message) : null;
  let runStarted: Promise<{ id: string } | { error: string }> | null = null;
  if (goal) {
    runStarted = startAgentRun(userId, goal, 'chat');
    after(async () => {
      const r = await runStarted!.catch(() => null);
      if (r && 'id' in r) await runAgent(userId, r.id, 240_000).catch(e => console.error('[agent] run after chat failed:', (e as Error).message));
    });
  }

  const encoder = new TextEncoder();
  const sseChunk = (text: string) => encoder.encode(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  const sseDone = () => encoder.encode('data: [DONE]\n\n');

  const readable = new ReadableStream({
    start(controller) {
      // Every turn must end with a reply that is shown AND saved. On 2026-11-10 several messages ("Be polite",
      // "Hey Maya") got neither: the turn never reached a save. `settled` makes the first ending win; the
      // deadline below ends the turn itself before Vercel's 60s limit kills the function silently.
      let settled = false;
      const path: string[] = [];
      const send = (bytes: Uint8Array) => { if (settled) return; try { controller.enqueue(bytes); } catch { /* client left; keep going so the reply is still saved */ } };
      const emit = (text: string) => send(sseChunk(text));
      const saveReply = async (text: string) => {
        if (settled) return;
        await appendConversation(userId, 'assistant', text).catch(e => console.error('[chat] reply not saved:', (e as Error).message));
      };
      const close = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        console.log(`[chat] done ms=${Date.now() - startedAt} path=${path.join('>') || 'direct'}`);
        try { controller.enqueue(sseDone()); controller.close(); } catch { /* client left */ }
      };
      const deadline = setTimeout(() => {
        if (settled) return;
        console.error(`[chat] turn hit the deadline ms=${Date.now() - startedAt} path=${path.join('>')}`);
        const msg = 'Sorry, Manoj, that took too long and I had to stop. Please ask again.';
        appendConversation(userId, 'assistant', msg).catch(e => console.error('[chat] reply not saved:', (e as Error).message));
        emit(msg);
        close();
      }, 52000);

      const finish = async (reply: string) => {
        let r = reply.trim();
        r = r.replace(/^(.{4,}?)\s*\1$/s, '$1').trim();
        if (!r) r = 'Sorry, Manoj, something went wrong on my end. Please try again.';
        await saveReply(r);
        emit(r);
        close();
      };

      // Top-level net: any unhandled throw settles the controller so the stream is never leaked
      (async () => {
        // Already saved above, so a to-do list always gets the to-do reply, whatever else it looks like.
        if (todoCapture && todosSaved) {
          path.push('todos');
          const n = await todosSaved.catch(e => { console.error('[chat] todo save failed:', (e as Error).message); return 0; });
          await finish(n
            ? `Got ${n === 1 ? 'it' : `${n} to-dos`}, Manoj:\n${todoCapture.items.map(t => `• ${t}`).join('\n')}\n\nI'll start on the ones I can do now and report back here. Anything that sends, books or deletes will wait for your Approve; money and passwords stay with you.`
            : "Sorry, Manoj, I couldn't save those to-dos just now. Please send them again in a moment.");
          return;
        }

        if (parseCancelGoal(message)) {
          path.push('agent-cancel');
          await finish(await cancelAgentRuns(userId).catch(e => { console.error('[chat] cancel failed:', (e as Error).message); return "Sorry, Manoj, I couldn't stop it just now. Please try again."; }));
          return;
        }

        if (goal && runStarted) {
          path.push('agent');
          const r = await runStarted.catch(e => { console.error('[chat] agent run not started:', (e as Error).message); return null; });
          await finish(!r
            ? "Sorry, Manoj, I couldn't start on that just now. Please send it again in a moment."
            : 'error' in r
              ? `Not started: ${r.error}`
              : `On it, Manoj. I'll work through this in the background and message you the plan in a moment:\n${goal}\n\nAnything that sends an email or changes your calendar comes to you for approval first.`);
          return;
        }

        // "Be polite", "from now on reply in Hindi": a standing rule. Saved for every later turn, then confirmed.
        const standing = parseStandingInstruction(message);
        if (standing) {
          path.push('rule');
          try {
            await saveRule(userId, standing.rule, standing.kind === 'fact' ? 'preference' : 'instruction');
            await finish(ruleSavedReply(standing));
          } catch (e) {
            console.error('[chat] rule save failed:', (e as Error).message);
            await finish("Sorry, Manoj, I couldn't save that rule just now. Please say it again in a moment.");
          }
          return;
        }

        // "reply to Bob saying yes": looked up and queued for approval without the model (see replyIntent.ts).
        const replyIntent = parseReplyIntent(message);
        if (replyIntent) {
          send(encoder.encode(`data: ${JSON.stringify({ tool: 'send_email', phase: 'start' })}\n\n`));
          let text: string;
          let queued: { to: string; subject: string; body: string } | undefined;
          try {
            ({ text, queued } = await handleReply(replyIntent, {
              fetchSummaries: fetchMessageSummaries,
              queue: (tool, args) => queueAction(userId, tool, args),
            }));
          } catch (e) {
            console.error('reply handler failed:', (e as Error).message);
            text = 'Could not set that reply up. Nothing was queued.';
          }
          send(encoder.encode(`data: ${JSON.stringify({
            tool: 'send_email', phase: 'end', ok: !!queued,
            ...(evalUser ? { args: JSON.stringify(queued ?? {}), result: text.slice(0, 700) } : {}),
          })}\n\n`));
          await finish(text);
          return;
        }

        // "I'm away until Friday", "send draft 2", "FAQ: ...": Away Mode commands, handled without the model. Starting an
        // agent that answers email for him is matched strictly (away/intent.ts) and never inferred from a casual sentence.
        const awayIntent = parseAwayIntent(message);
        if (awayIntent) {
          path.push('away');
          let text: string;
          try {
            text = await handleAwayIntent(awayIntent, userId);
          } catch (e) {
            console.error('[chat] away command failed:', (e as Error).message);
            text = 'Could not do that just now, and nothing was changed. Please try again in a moment.';
          }
          await finish(text);
          return;
        }

        const msgs: Groq.Chat.ChatCompletionMessageParam[] = [
          ...historyForModel(history),
          { role: 'user', content: message },
        ];

        let response: Groq.Chat.ChatCompletion;
        try {
          response = await wf(model => groq.chat.completions.create({
            ...fallbackOpts(model),
            model,
            messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts, ruleTexts) }, ...msgs],
            tools: turnTools,
            tool_choice: forcedToolChoice,
            max_tokens: model === PRIMARY_MODEL ? 400 : 700, // the fallback spends some tokens reasoning first
          }));
        } catch (e) {
          // withFallback already moved to the other model once; a tool_use_failed here means that attempt also
          // wrote a malformed tool call. The output is sampled, so send the same request once more.
          let failure: unknown = e;
          let retried: Groq.Chat.ChatCompletion | null = null;
          if (shouldRetryToolUseFailed(e, Date.now() - startedAt)) {
            console.warn('Groq initial call hit tool_use_failed, retrying once:', (e as Error).message?.slice(0, 200));
            path.push('tool-retry');
            try {
              retried = await groq.chat.completions.create({
                model: PRIMARY_MODEL,
                messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts, ruleTexts) }, ...msgs],
                tools: turnTools,
                tool_choice: forcedToolChoice,
                max_tokens: 400,
              });
            } catch (e2) { failure = reportedError(e, e2); }
          }
          if (!retried) {
            console.error('Groq initial call failed:', (failure as Error).message);
            await finish((failure as { status?: number }).status === 429
              ? "I'm at my rate limit for the moment. Ask again in about a minute."
              : 'Hit a snag — try again in a moment.');
            return;
          }
          response = retried;
        }

        // Last resort for a routing miss: the model answered an action-sounding message without calling any tool
        // while it only had a subset of tools. Retry once with the full set before accepting a tool-less answer.
        if (response.choices[0]?.finish_reason !== 'tool_calls' && turnTools.length < TOOLS.length && ACTIONISH.test(message)) {
          try {
            response = await wf(model => groq.chat.completions.create({
              ...fallbackOpts(model),
              model,
              messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts, ruleTexts) }, ...msgs],
              tools: TOOLS,
              tool_choice: 'auto',
              max_tokens: model === PRIMARY_MODEL ? 400 : 700,
            }));
          } catch { /* keep the first answer */ }
        }

        let turns = 0;
        while (response.choices[0]?.finish_reason === 'tool_calls') {
          if (++turns > 5) {
            await finish('Took too many steps — try rephrasing.');
            return;
          }
          const toolCalls = response.choices[0].message.tool_calls ?? [];
          const toolResults: Groq.Chat.ChatCompletionMessageParam[] = [];
          const fastResults: string[] = [];
          const queuedNotes: string[] = []; // gated-tool queue text, appended verbatim in mixed turns

          // An inbox question about one subject ("Any job roles where I am moved to next stage rejected?"): search Gmail
          // for that subject and answer from the matched emails (inboxSearch.ts). Runs whenever list_emails is the only
          // tool picked, forced or not, since his question may not mention the inbox at all. A plain check falls through
          // to the usual list; so does any Gmail or answer failure, rather than a guess.
          let topicStartSent = false;
          if (turns === 1 && toolCalls.length === 1 && toolCalls[0].function.name === 'list_emails' && !analysisIntent(message) && !mailWriteIntent(message)) {
            path.push('inbox-topic');
            topicStartSent = true;
            send(encoder.encode(`data: ${JSON.stringify({ tool: 'list_emails', phase: 'start' })}\n\n`));
            try {
              const r = await answerInboxTopic(message, prevUser, {
                llm: async (system, user, maxTokens) => {
                  const c = await wf(model => groq.chat.completions.create({
                    ...fallbackOpts(model),
                    model,
                    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                    temperature: 0,
                    max_tokens: model === PRIMARY_MODEL ? maxTokens : maxTokens + 500,
                  }));
                  return c.choices[0]?.message?.content ?? '';
                },
                search: (q, max) => fetchMessageSummaries(q, max, max),
                // getEmail reports failures as text ("Gmail fetch failed: 429"); only a real email may reach the model.
                read: async id => { const e = await getEmail(id); return e.startsWith('From: ') ? e : ''; },
                rules: rulesBlock(ruleTexts) || undefined,
              });
              if (r.kind === 'answer') {
                console.log(`[inbox-topic] matched=${r.matched} query=${JSON.stringify(r.query.slice(0, 200))}`);
                send(encoder.encode(`data: ${JSON.stringify({ tool: 'list_emails', phase: 'end', ok: true, ...(evalUser ? { args: JSON.stringify({ query: r.query }) } : {}) })}\n\n`));
                if (settled) return;
                await finish(r.text);
                return;
              }
            } catch (e) {
              console.error('[inbox-topic] failed, showing the list:', (e as Error).message);
            }
            if (settled) return;
          }

          for (const tc of toolCalls) {
            // The deadline already answered: running more tools now would repeat them when Manoj asks again.
            if (settled) return;
            let result: string;
            path.push(tc.function.name);
            // Progress event so the UI can show "Checking Gmail…". Unknown keys are ignored by older clients.
            if (!(topicStartSent && tc.function.name === 'list_emails')) send(encoder.encode(`data: ${JSON.stringify({ tool: tc.function.name, phase: 'start' })}\n\n`));
            try {
              const targs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              // The model sometimes truncates an id it was handed ("1a10115c…" became "1a"). An id the user
              // typed is authoritative, so use it verbatim.
              if (tc.function.name === 'get_email' && toolCalls.filter(t => t.function.name === 'get_email').length === 1) {
                const typed = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{10,}\b/i.exec(message)?.[0];
                if (typed && targs.message_id !== typed) targs.message_id = typed;
              }
              result = await executeTool(tc.function.name, targs, userId);
            } catch (e) {
              result = `Tool error: ${(e as Error).message}`;
            }
            send(encoder.encode(`data: ${JSON.stringify({
              tool: tc.function.name, phase: 'end', ok: !result.startsWith('Tool error'),
              // Arguments and a result excerpt are exposed to eval runs only.
              ...(evalUser ? { args: tc.function.arguments, result: result.slice(0, 700) } : {}),
            })}\n\n`));
            toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
            if (GATED_TOOLS.has(tc.function.name)) queuedNotes.push(result);
            if (SKIP_NARRATION_TOOLS.has(tc.function.name)) fastResults.push(result);
          }

          // "Summarise / read through / prioritise" over read-only tool data: answer from the data alone.
          if (analysisIntent(message) && toolCalls.length > 0 && toolCalls.every(tc => GROUNDABLE.has(tc.function.name)) && !toolResults.some(t => String(t.content).startsWith('Tool error'))) {
            try {
              // Each section has its own cap so appended bodies / file text are never silently cut off.
              const listed = toolResults.map(t => String(t.content)).join('\n\n');
              let data = listed.slice(0, 2500);
              // An email summary is thin on snippets alone: add the bodies of the few worth a look.
              if (toolCalls.some(tc => tc.function.name === 'list_emails')) {
                const bodies = await Promise.all(needsLookIds(listed).map(id => getEmail(id).catch(() => '')));
                data += bodies.filter(Boolean).map(b => `\n\n--- email body ---\n${b.slice(0, 900)}`).join('');
              }
              // Likewise for Drive: a summary needs the file text, not just names.
              if (toolCalls.some(tc => tc.function.name === 'search_drive')) {
                const files = await Promise.all(driveReadableIds(listed).map(id => readDriveFile(id).catch(() => '')));
                data += files.filter(Boolean).map(f => `\n\n--- file text ---\n${f.slice(0, 1500)}`).join('');
              }
              const g = await wf(model => groq.chat.completions.create({
                ...fallbackOpts(model),
                model,
                messages: [{ role: 'system', content: [GROUNDED_SYSTEM, rulesBlock(ruleTexts)].filter(Boolean).join('\n\n') }, { role: 'user', content: groundedUser(message, data) }],
                temperature: 0.2,
                max_tokens: model === PRIMARY_MODEL ? 450 : 800,
              }));
              const summary = (g.choices[0]?.message?.content ?? '').trim();
              if (summary) {
                await saveReply(summary);
                emit(summary);
                close();
                return;
              }
            } catch (e) {
              console.error('grounded summary failed, falling back to raw:', (e as Error).message);
            }
          }

          // All fast-confirm — skip 2nd Groq call
          if (fastResults.length === toolCalls.length && fastResults.length > 0) {
            // '\n\n' not ' ' — several entries in this set (ticket/email lookups) are multi-line
            // formatted blocks, not one-line confirmations; joining with a space would mash them together.
            const reply = fastResults.join('\n\n');
            await saveReply(reply);
            emit(reply);
            close();
            return;
          }

          msgs.push({ role: 'assistant', content: response.choices[0].message.content ?? '', tool_calls: toolCalls });
          msgs.push(...toolResults);

          // Stream the post-tool response.
          // tool_choice:'none' errors on qwen — keep 'auto' and only collect content deltas;
          // if model returns tool_calls (rare), chunksEmitted stays 0 and finish() emits fallback.
          try {
            const groqStream = await wf(model => groq.chat.completions.create({
              ...fallbackOpts(model),
              model,
              messages: [{ role: 'system', content: buildSystemPrompt(memoryFacts, ruleTexts) }, ...msgs],
              tools: turnTools,
              tool_choice: 'auto',
              max_tokens: model === PRIMARY_MODEL ? 600 : 900,
              stream: true,
            }));

            let fullReply = '';
            let chunksEmitted = 0;
            for await (const chunk of groqStream) {
              const text = chunk.choices[0]?.delta?.content ?? '';
              if (text) {
                fullReply += text;
                emit(text);
                chunksEmitted++;
              }
            }

            fullReply = fullReply.trim();
            fullReply = fullReply.replace(/^(.{4,}?)\s*\1$/s, '$1').trim();
            // The narration pass can wrongly say a queued action already happened — state the real status.
            if (queuedNotes.length) {
              const tail = `\n\n${queuedNotes.join('\n')}`;
              fullReply += tail;
              emit(tail);
              chunksEmitted++;
            }
            if (!fullReply) fullReply = 'Something went wrong on my end. Try again.';
            await saveReply(fullReply);
            if (chunksEmitted === 0) emit(fullReply); // nothing streamed yet, emit now
            close();
            return;
          } catch (e) {
            console.error('Groq stream (post-tool) failed:', (e as Error).message);
            const errMsg = queuedNotes.length
              ? `Queued, not done yet. ${queuedNotes.join('\n')}`
              : 'Done, but had trouble composing the response. Try asking again.';
            await saveReply(errMsg);
            emit(errMsg);
            close();
            return;
          }
        }

        // No tools: direct answer already in response
        const reply = response.choices[0]?.message?.content ?? '';
        await finish(reply);
      })().catch(async e => {
        console.error('[chat] unhandled:', (e as Error).message, 'path=' + path.join('>'));
        await finish('Sorry, Manoj, something went wrong on my end. Please try again.');
      });
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
