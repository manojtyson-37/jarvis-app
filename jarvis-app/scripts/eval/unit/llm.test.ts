import { toAnthropic, fromAnthropic, cleanJson, forcedToolSkipped, readHead } from '../../../src/lib/llm';
let f = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

const tools = [{ type: 'function' as const, function: { name: 'set_reminder', description: 'Set a reminder', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }];

const a = toAnthropic({
  model: 'claude-haiku-5-5', max_tokens: 300, temperature: 0.2, tools, tool_choice: 'auto',
  messages: [
    { role: 'system', content: 'You are Maya.' },
    { role: 'user', content: 'remind me to call Priya at 6' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'set_reminder', arguments: '{"text":"call Priya"}' } }, { id: 'toolu_2', type: 'function', function: { name: 'get_calendar_events', arguments: 'not json' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'Reminder set' },
    { role: 'tool', tool_call_id: 'toolu_2', content: '' },
  ],
});
ok('system moved to top-level', a.system === 'You are Maya.');
ok('no temperature sent', !('temperature' in a));
ok('thinking disabled on Haiku', (a.thinking as { type: string }).type === 'disabled');
ok('tools mapped', !!a.tools?.[0] && (a.tools[0] as { name: string }).name === 'set_reminder');
ok('auto tool choice', (a.tool_choice as { type: string }).type === 'auto');
ok('three turns user/assistant/user', a.messages.map(m => m.role).join() === 'user,assistant,user');
const asst = a.messages[1].content as { type: string; input?: unknown }[];
ok('assistant has two tool_use, no empty text', asst.length === 2 && asst.every(b => b.type === 'tool_use'));
ok('bad arguments become {}', JSON.stringify(asst[1].input) === '{}');
const results = a.messages[2].content as { type: string; content?: string }[];
ok('both tool results merged in one user turn', results.length === 2 && results.every(b => b.type === 'tool_result'));
ok('empty tool result not empty', results[1].content === '(empty)');

const forcedHaiku = toAnthropic({ model: 'claude-haiku-5-5', tools, tool_choice: { type: 'function', function: { name: 'set_reminder' } }, messages: [{ role: 'user', content: 'x' }] });
ok('forced tool kept on Haiku', JSON.stringify(forcedHaiku.tool_choice) === '{"type":"tool","name":"set_reminder"}');
const forcedSonnet = toAnthropic({ model: 'claude-sonnet-5-5', tools, tool_choice: { type: 'function', function: { name: 'set_reminder' } }, messages: [{ role: 'user', content: 'x' }] });
ok('forced tool becomes auto + instruction on Sonnet', (forcedSonnet.tool_choice as { type: string }).type === 'auto' && /set_reminder/.test(String(forcedSonnet.system)));
ok('Sonnet uses between_tools thinking', (forcedSonnet.thinking as { type: string }).type === 'between_tools');

const json = toAnthropic({ model: 'claude-haiku-5-5', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'x' }] });
ok('json mode adds instruction', /JSON object/.test(String(json.system)));
const noUserFirst = toAnthropic({ model: 'claude-haiku-5-5', messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'hi' }] });
ok('conversation starts with user', noUserFirst.messages[0].role === 'user');

const r = fromAnthropic({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: {} as never,
  content: [{ type: 'text', text: 'Setting it.' }, { type: 'tool_use', id: 'toolu_9', name: 'set_reminder', input: { text: 'call Priya' } }] } as never);
ok('tool_use maps to tool_calls', r.choices[0].finish_reason === 'tool_calls' && r.choices[0].message.tool_calls?.[0].function.arguments === '{"text":"call Priya"}');
ok('text kept', r.choices[0].message.content === 'Setting it.');
ok('fenced json cleaned', cleanJson('```json\n{"a":1}\n```') === '{"a":1}');

const noTool = fromAnthropic({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null, usage: {} as never, content: [{ type: 'text', text: 'You have 3 unread.' }] } as never);
const forcedP = (model: string) => ({ model, tools, tool_choice: { type: 'function' as const, function: { name: 'set_reminder' } }, messages: [] });
ok('Sonnet skipping a forced tool is a failure', forcedToolSkipped(forcedP('claude-sonnet-5-5'), noTool));
ok('Sonnet calling the tool is fine', !forcedToolSkipped(forcedP('claude-sonnet-5-5'), r));
ok('Haiku forced is enforced by the API, not checked', !forcedToolSkipped(forcedP('claude-haiku-5-5'), noTool));
ok('auto never fails for skipping', !forcedToolSkipped({ model: 'claude-sonnet-5-5', tools, tool_choice: 'auto', messages: [] }, noTool));
const otherTool = fromAnthropic({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: {} as never,
  content: [{ type: 'tool_use', id: 'toolu_8', name: 'get_calendar_events', input: {} }] } as never);
ok('Sonnet calling a different tool than the forced one is a failure', forcedToolSkipped(forcedP('claude-sonnet-5-5'), otherTool));
ok('required (unnamed) accepts any tool', !forcedToolSkipped({ model: 'claude-sonnet-5-5', tools, tool_choice: 'required', messages: [] }, otherTool));

// Fake Anthropic event stream: yields the given events, optionally throws after `throwAt` of them, records return().
type Ev = Parameters<typeof readHead>[0] extends AsyncIterable<infer E> ? E : never;
const txt = (t: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }) as unknown as Ev;
const start = { type: 'message_start' } as unknown as Ev;
function fake(evs: Ev[], throwAt = -1) {
  const s = { returned: 0, i: 0 };
  const iter: AsyncIterator<Ev> = {
    async next() {
      if (s.i === throwAt) throw Object.assign(new Error('overloaded'), { status: 529 });
      return s.i < evs.length ? { done: false, value: evs[s.i++] } : { done: true, value: undefined };
    },
    async return() { s.returned++; return { done: true, value: undefined }; },
  };
  return { s, src: { [Symbol.asyncIterator]: () => iter } };
}
const read = async (it: AsyncIterable<{ choices: { delta: { content?: string } }[] }>) => { let o = ''; for await (const d of it) o += d.choices[0].delta.content ?? ''; return o; };

(async () => {
  const early = fake([start, txt('hi')], 1);
  let threw = false;
  try { await readHead(early.src); } catch { threw = true; }
  ok('early stream error throws from readHead', threw);
  ok('early stream error closes the source', early.s.returned === 1);

  const plain = fake([start, txt('Hel'), txt('lo')]);
  ok('text-only stream reads in full', await read(await readHead(plain.src)) === 'Hello');
  ok('normal end does not call return() on the source', plain.s.returned === 0);

  const empty = fake([start]);
  ok('stream with no text yields nothing', await read(await readHead(empty.src)) === '' && empty.s.returned === 0);

  const stop = fake([start, txt('a'), txt('b'), txt('c')]);
  const it = await readHead(stop.src);
  await it.next();
  await it.return?.();
  await it.return?.();
  ok('reader stopping early closes the source once', stop.s.returned === 1);

  const unread = fake([start, txt('a'), txt('b')]);
  await (await readHead(unread.src)).return?.();
  ok('return() before any read closes the source', unread.s.returned === 1);

  const late = fake([start, txt('a'), txt('b')], 2);
  let lateThrew = false;
  try { await read(await readHead(late.src)); } catch { lateThrew = true; }
  ok('late stream error ends the stream and closes the source', lateThrew && late.s.returned === 1);

  if (f) { console.error(`${f} failed`); process.exit(1); }
})();
