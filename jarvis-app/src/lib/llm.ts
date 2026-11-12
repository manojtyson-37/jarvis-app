// Maya's model client: Claude through the official Anthropic SDK, behind the chat-completions shape the rest of
// the code already speaks (messages with tool_calls, OpenAI-style function tools, streamed content deltas).
// Only this file knows about Anthropic's wire format, so callers stay unchanged.
import Anthropic from '@anthropic-ai/sdk';
import type Groq from 'groq-sdk';

type ChatMessage = Groq.Chat.ChatCompletionMessageParam;
type ChatTool = Groq.Chat.ChatCompletionTool;
type ChatToolChoice = Groq.Chat.ChatCompletionToolChoiceOption;

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
  stream?: boolean;
  // Accepted and ignored: Claude Haiku 5.5 / Sonnet 5.5 reject sampling parameters, and effort is set here.
  temperature?: number;
  reasoning_effort?: string;
}

const JSON_ONLY = 'Reply with one JSON object and nothing else: no prose, no code fences.';

// Sonnet 5.5 rejects a forced tool_choice; Haiku 5.5 accepts it.
const forcedToolAllowed = (model: string) => !/sonnet-5-5|opus-5-5|fable/.test(model);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  return '';
}

export function toAnthropic(p: ChatParams): Anthropic.MessageCreateParamsNonStreaming {
  const system: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of p.messages) {
    if (m.role === 'system') { const t = textOf(m.content).trim(); if (t) system.push(t); continue; }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) || '(empty)' }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      const t = textOf(m.content).trim();
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try { const v = JSON.parse(tc.function.arguments || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) input = v; } catch { /* keep {} */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      push('assistant', blocks);
      continue;
    }
    const t = textOf(m.content);
    if (t.trim()) push('user', [{ type: 'text', text: t }]);
  }
  // The API needs the conversation to open with a user turn.
  if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  if (p.response_format?.type === 'json_object') system.push(JSON_ONLY);

  const out: Anthropic.MessageCreateParamsNonStreaming = {
    model: p.model,
    max_tokens: p.max_tokens ?? 1024,
    messages,
    // Thinking off: fast, short turns. Haiku 5.5 takes "disabled"; Sonnet 5.5 only accepts "between_tools".
    thinking: (/sonnet-5-5/.test(p.model) ? { type: 'between_tools' } : { type: 'disabled' }) as Anthropic.ThinkingConfigParam,
  };
  if (system.length) out.system = system.join('\n\n');

  if (p.tools?.length) {
    out.tools = p.tools.map(t => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
    }));
    const tc = p.tool_choice;
    if (tc === 'none') out.tool_choice = { type: 'none' };
    else if (tc && typeof tc === 'object' && tc.type === 'function') {
      if (forcedToolAllowed(p.model)) out.tool_choice = { type: 'tool', name: tc.function.name };
      else {
        out.tool_choice = { type: 'auto' };
        out.system = [out.system, `Call the ${tc.function.name} tool now before answering.`].filter(Boolean).join('\n\n');
      }
    } else if (tc === 'required') {
      out.tool_choice = forcedToolAllowed(p.model) ? { type: 'any' } : { type: 'auto' };
    } else out.tool_choice = { type: 'auto' };
  }
  return out;
}

// Strip a ```json fence if the model added one despite the instruction.
export function cleanJson(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return m ? m[1] : text;
}

export function fromAnthropic(r: Anthropic.Message, jsonMode = false): Groq.Chat.ChatCompletion {
  let text = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  if (jsonMode) text = cleanJson(text);
  const toolCalls = r.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const finish = r.stop_reason === 'tool_use' ? 'tool_calls' : r.stop_reason === 'max_tokens' ? 'length' : 'stop';
  return {
    id: r.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: r.model,
    choices: [{
      index: 0,
      finish_reason: finish,
      logprobs: null,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    }],
  } as unknown as Groq.Chat.ChatCompletion;
}

type Delta = { choices: { delta: { content?: string } }[] };

// No SDK retries and a 20s cap: withFallback (chatTools.ts) decides retries, and must reach the fallback model
// well inside the chat route's 52s turn deadline.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 20000 });

// A forced read tool exists to stop the model answering from memory. On a model that cannot be forced (Sonnet 5.5)
// the force becomes a hint; if the model still skips the tool, fail the call rather than return a made-up answer.
export function forcedToolSkipped(p: ChatParams, r: Groq.Chat.ChatCompletion): boolean {
  const tc = p.tool_choice;
  const named = !!tc && typeof tc === 'object' && tc.type === 'function' ? tc.function.name : null;
  const forced = tc === 'required' || !!named;
  if (!forced || forcedToolAllowed(p.model)) return false;
  const calls = r.choices[0]?.message?.tool_calls ?? [];
  // A named force must call that tool; calling some other tool still skips the read the force exists for.
  return named ? !calls.some(c => c.function.name === named) : !calls.length;
}

const textDelta = (ev: Anthropic.RawMessageStreamEvent): Delta | null =>
  ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' ? { choices: [{ delta: { content: ev.delta.text } }] } : null;

// Read up to the first text before returning, so an overload or error that arrives early in the stream
// still throws inside withFallback and can move to the other model. Later errors end the stream.
// The returned iterator closes the request on return() even if nothing was read yet (a generator would not).
export async function readHead(events: AsyncIterable<Anthropic.RawMessageStreamEvent>): Promise<AsyncIterableIterator<Delta>> {
  const it = events[Symbol.asyncIterator]();
  const closeSource = async () => { try { await it.return?.(); } catch { /* already closed */ } };
  const head: Delta[] = [];
  let ended = false;
  try {
    while (!head.length) {
      const n = await it.next();
      if (n.done) { ended = true; break; }
      const d = textDelta(n.value);
      if (d) head.push(d);
    }
  } catch (e) {
    await closeSource();
    throw e;
  }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; if (!ended) await closeSource(); };
  const finished = { done: true as const, value: undefined };
  const out: AsyncIterableIterator<Delta> = {
    [Symbol.asyncIterator]() { return out; },
    async next() {
      if (head.length) return { done: false, value: head.shift()! };
      if (ended || closed) { await close(); return finished; }
      try {
        for (;;) {
          const n = await it.next();
          if (n.done) { ended = true; closed = true; return finished; }
          const d = textDelta(n.value);
          if (d) return { done: false, value: d };
        }
      } catch (e) {
        await close();
        throw e;
      }
    },
    async return() { await close(); return finished; },
  };
  return out;
}

async function create(p: ChatParams & { stream: true }): Promise<AsyncIterable<Delta>>;
async function create(p: ChatParams): Promise<Groq.Chat.ChatCompletion>;
async function create(p: ChatParams): Promise<Groq.Chat.ChatCompletion | AsyncIterable<Delta>> {
  const params = toAnthropic(p);
  if (p.stream) {
    return readHead(await client.messages.create({ ...params, stream: true }));
  }
  const r = fromAnthropic(await client.messages.create(params), p.response_format?.type === 'json_object');
  if (forcedToolSkipped(p, r)) throw Object.assign(new Error(`${p.model} skipped the required tool`), { status: 502 });
  return r;
}

export const llm = { chat: { completions: { create } } };
