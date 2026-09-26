import { SseParser } from './sse';
import { classifyRecipient, learnLinks, type GptToolInfo } from './gpt-tools';
import { UUID_RE } from './uuid';

/**
 * Fail-closed parser for chatgpt.com's answer stream (`POST /backend-api/f/conversation`, SSE with
 * `delta_encoding` "v1"), as teed by the MAIN-world wrapper (lib/gpt-page.ts) and parsed in the
 * relay's isolated world.
 *
 * The stream is a list of messages (index `c`), each built by JSON-pointer ops on
 * `{message, conversation_id, error}`: `add` (a new message; later adds omit `p`/`o`), `append`
 * (text: `/message/content/parts/0`; a bare string after a `patch` appends to the path the patch
 * last appended to), `replace`, `truncate`, `remove` and `patch` (a list of those). Typed events
 * (`{type: …}`) carry metadata; `[DONE]` ends it.
 *
 * Only text of assistant messages to `all`, `content_type: text`, channel `final` (or none), not
 * marked hidden (`is_visually_hidden*`, `is_user_system_message`), is ever forwarded (as `text`
 * signals, citation markers U+E200–U+E2FF stripped). An assistant message that doesn't name its
 * recipient yet is undecided: nothing of it is forwarded until it does (or it completes: then
 * chatgpt.com's default, `all`). An answer message whose metadata wasn't final when it started (no
 * `message_type` / `model_slug`: a real answer's first `add` carries them) is held back whole until
 * it completes, so a hidden flag that arrives later still keeps it out.
 * Everything else is looked at and never forwarded: system messages, user messages (the echo of our
 * question, and `is_user_system_message` custom instructions), reasoning (`thoughts`,
 * `reasoning_recap`, `analysis`/`commentary` channels) and memory (`model_editable_context`).
 * Tool calls (assistant messages to anyone but `all`) are classified (lib/gpt-tools.ts) the moment
 * their recipient is known; tool results (`tool` messages) must belong to a call seen starting.
 * An op, event, role, content type or channel this code doesn't know is `unknown`: the caller stops
 * and hands off (fail closed).
 *
 * Complete = `message_stream_complete` + `[DONE]` + the answer's status `finished_successfully`.
 */

export type GptSignal =
  /** The chat's id (first seen). */
  | { kind: 'conversation'; id: string }
  /** Answer text to forward (already cleaned). */
  | { kind: 'text'; text: string }
  /** A read tool call started (`msg`: its message index). */
  | { kind: 'tool'; info: GptToolInfo; msg: number }
  /** The running call at `msg` made progress of its own (its body, or its result streaming). */
  | { kind: 'tool_progress'; msg: number }
  /** The call at `msg` has a result. */
  | { kind: 'tool_done'; msg: number }
  /** A call that must not run: stop now and hand off. */
  | { kind: 'action'; info: GptToolInfo; msg: number; callId: string | null; recipient: string }
  /** Something this parser can't account for: stop and hand off (fail closed). */
  | { kind: 'unknown'; what: string }
  /** The stream reported an error. */
  | { kind: 'error'; what: string };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Typed events that carry only metadata (never text we show, never a tool of their own). */
export const KNOWN_TYPED_EVENTS: ReadonlySet<string> = new Set([
  'message_stream_complete',
  'resume_conversation_token',
  'message_marker',
  'conversation_detail_metadata',
  'title_generation',
  'server_ste_metadata',
  'input_message',
  'url_moderation',
  'moderation',
]);

const HIDDEN_CONTENT = new Set(['thoughts', 'reasoning_recap', 'model_editable_context']);
const HIDDEN_CHANNELS = new Set(['analysis', 'commentary']);
const OPS = new Set(['add', 'replace', 'append', 'truncate', 'remove', 'patch']);
const BAD_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

class Unknown extends Error {
  constructor(public readonly what: string) {
    super(what);
  }
}

/** Parsing stops here: an `action` signal has been emitted (it is the one that matters). */
class Stop extends Error {}

/** Remove citation markers: whole `U+E200 … U+E201` spans, and any stray U+E200–U+E2FF. An unterminated span at the end is held back (it may still close) unless `final`. */
export function stripCitations(t: string, final = false): string {
  let out = t.replace(/[^]*/g, '');
  const open = out.indexOf('');
  if (open >= 0 && !final) out = out.slice(0, open);
  return out.replace(/[-]/g, '');
}

function pointer(p: string): string[] {
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Unknown('path');
  const segs = p
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segs.some((s) => BAD_SEGMENTS.has(s))) throw new Unknown('path');
  return segs;
}

/** Apply one op to `root` (a message wrapper); returns the new root. Throws Unknown on anything odd. */
export function applyOp(root: unknown, p: unknown, o: unknown, v: unknown, depth = 0): unknown {
  if (typeof p !== 'string' || typeof o !== 'string' || !OPS.has(o)) throw new Unknown(`op:${String(o).slice(0, 20)}`);
  if (o === 'patch') {
    if (!Array.isArray(v) || depth > 2) throw new Unknown('patch');
    let r = root;
    if (p === '') {
      for (const x of v) {
        if (!isObj(x) || !('p' in x) || !('o' in x)) throw new Unknown('patch');
        r = applyOp(r, x.p, x.o, x.v, depth + 1);
      }
      return r;
    }
    // a patch at a path: its ops are relative to that path
    const segs = pointer(p);
    let target: unknown = r;
    for (const s of segs) target = isObj(target) || Array.isArray(target) ? (target as Obj)[s] : undefined;
    for (const x of v) {
      if (!isObj(x) || !('p' in x) || !('o' in x)) throw new Unknown('patch');
      target = applyOp(target, x.p, x.o, x.v, depth + 1);
    }
    return applyOp(r, p, 'replace', target, depth + 1);
  }
  const segs = pointer(p);
  if (!segs.length) {
    if (o === 'add' || o === 'replace') return v;
    if (o === 'append' && typeof root === 'string' && typeof v === 'string') return root + v;
    throw new Unknown(`op:${o}@root`);
  }
  if (root === undefined || root === null) root = {};
  if (!isObj(root)) throw new Unknown('root');
  let obj: Obj | unknown[] = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    const next = (obj as Obj)[k];
    if (next === undefined || next === null) {
      if (o === 'remove' || o === 'truncate') return root;
      (obj as Obj)[k] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    } else if (!isObj(next) && !Array.isArray(next)) throw new Unknown('path');
    obj = (obj as Obj)[k] as Obj | unknown[];
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(obj) && !/^\d+$/.test(last) && last !== '-') throw new Unknown('path');
  const key = Array.isArray(obj) && last === '-' ? String(obj.length) : last;
  const cur = (obj as Obj)[key];
  switch (o) {
    case 'add':
    case 'replace':
      (obj as Obj)[key] = v;
      break;
    case 'append':
      if (typeof v === 'string' && (typeof cur === 'string' || cur === undefined || cur === null)) (obj as Obj)[key] = (typeof cur === 'string' ? cur : '') + v;
      else if (Array.isArray(cur)) cur.push(...(Array.isArray(v) ? v : [v]));
      else if (isObj(cur) && isObj(v)) Object.assign(cur, v);
      else if ((cur === undefined || cur === null) && (Array.isArray(v) || isObj(v))) (obj as Obj)[key] = v;
      else throw new Unknown('append');
      break;
    case 'truncate':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Unknown('truncate');
      if (typeof cur === 'string' || Array.isArray(cur)) (obj as Obj)[key] = cur.slice(0, v);
      else if (cur !== undefined) throw new Unknown('truncate');
      break;
    case 'remove':
      if (Array.isArray(obj)) obj.splice(Number(key), 1);
      else delete (obj as Obj)[key];
      break;
  }
  return root;
}

type Cls = 'answer' | 'hidden' | 'call' | 'result';

interface Call {
  recipient: string;
  /** null while an `api_tool.call_tool` path is still streaming in. */
  info: GptToolInfo | null;
  settled: boolean;
  id: string | null;
  /** The call message is complete (`finished_successfully`): chatgpt.com runs it now. */
  complete: boolean;
}

interface Slot {
  w: unknown;
  cls: Cls | null;
  /** Answer: clean text forwarded so far. */
  sent: string;
  /** Answer: held back until the message completes (its metadata wasn't final when it started). */
  held?: boolean;
  /** The message's first `add` named its recipient and channel and carried final metadata. */
  finalAtAdd?: boolean;
  call?: Call;
  /** Result: index of the call it belongs to. */
  of?: number;
}

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** Metadata that keeps a message off the page: `is_visually_hidden*` (any value but false) or `is_user_system_message`. */
export function hiddenMeta(meta: Obj): boolean {
  if (meta.is_user_system_message !== undefined && meta.is_user_system_message !== null && meta.is_user_system_message !== false) return true;
  for (const [k, v] of Object.entries(meta)) if (/^is_visually_hidden/.test(k) && v !== undefined && v !== null && v !== false) return true;
  return false;
}

/**
 * Is an answer message's metadata final enough to stream it as it arrives? A real answer's first
 * `add` names its recipient and channel and carries its metadata (`message_type`, `model_slug`);
 * one that doesn't is held back until it completes.
 */
function finalEnough(m: Obj): boolean {
  const meta = m.metadata;
  return typeof m.recipient === 'string' && 'channel' in m && isObj(meta) && (typeof meta.message_type === 'string' || typeof meta.model_slug === 'string');
}

/** Tool author name `t` answers a call to `r` (`web.run` ↔ `web`, `api_tool.call_tool` ↔ `api_tool`). */
const answers = (t: string, r: string) => t === r || r.startsWith(`${t}.`) || t.startsWith(`${r}.`);

export class GptStream {
  private sse = new SseParser();
  private slots = new Map<number, Slot>();
  private cur = 0;
  private lastP: unknown;
  private lastO: unknown;
  private lastAppendP: string | undefined;
  private failed: string | null = null;
  /** Some answer text was forwarded (a later answer message starts on a new paragraph). */
  private anySent = false;
  /** Connected apps by link id, from this turn's `api_tool.list_resources` results (lib/gpt-tools.ts). */
  private links = new Map<string, string>();

  encoding: string | null = null;
  done = false;
  streamComplete = false;
  conversationId: string | null = null;
  /** The answer message's id and status (the last answer message seen). */
  answerId: string | null = null;
  answerStatus: string | null = null;
  /** The answer's model (`metadata.model_slug`), when it says. */
  model: string | null = null;
  /** Names of every event type / content type seen (diagnostics: names only, never content). */
  readonly seen = new Set<string>();

  /** Feed a decoded chunk of the SSE body. */
  push(chunk: string): GptSignal[] {
    return this.handle(this.sse.push(chunk));
  }

  /** End of the body: flush, plus any held-back text (an unterminated citation marker). */
  end(): GptSignal[] {
    const out = this.handle(this.sse.flush());
    if (this.failed) return out;
    for (const [, s] of [...this.slots.entries()].sort((a, b) => a[0] - b[0])) {
      if (s.cls !== 'answer' || s.held) continue;
      const clean = stripCitations(this.textOf(s) ?? '', true);
      if (clean.startsWith(s.sent) && clean.length > s.sent.length) {
        out.push({ kind: 'text', text: clean.slice(s.sent.length) });
        s.sent = clean;
      }
    }
    // a call still undecided when the stream ends, or a connector read whose body no longer holds
    // up as complete, is an action (it may have run)
    for (const [c, s] of this.slots) {
      const info = this.finalCall(s);
      if (info) {
        out.push({ kind: 'action', info, msg: c, callId: s.call!.id, recipient: s.call!.recipient });
        break;
      }
    }
    return out;
  }

  /** Complete: `message_stream_complete`, `[DONE]` and a finished answer, with no call still running. */
  get complete(): boolean {
    return this.done && this.streamComplete && this.answerStatus === 'finished_successfully' && !this.failed && this.running().length === 0;
  }

  /** Calls still running (read calls without a result). */
  running(): number[] {
    return [...this.slots.entries()].filter(([, s]) => s.cls === 'call' && s.call?.info?.kind === 'read' && !s.call.settled).map(([c]) => c);
  }

  private handle(events: { event: string; data: string }[]): GptSignal[] {
    const out: GptSignal[] = [];
    for (const ev of events) {
      if (this.failed) break;
      try {
        this.event(ev, out);
      } catch (e) {
        if (e instanceof Stop) {
          this.failed = 'action';
          break;
        }
        const what = e instanceof Unknown ? e.what : 'parse';
        this.failed = what;
        out.push({ kind: 'unknown', what });
      }
    }
    return out;
  }

  private event(ev: { event: string; data: string }, out: GptSignal[]): void {
    const name = ev.event || 'message';
    if (ev.data === '[DONE]') {
      this.done = true;
      return;
    }
    if (name !== 'message' && name !== 'delta' && name !== 'delta_encoding') throw new Unknown(`event:${name.slice(0, 40)}`);
    let d: unknown;
    try {
      d = JSON.parse(ev.data);
    } catch {
      throw new Unknown('nonjson');
    }
    if (name === 'delta_encoding') {
      if (d !== 'v1') throw new Unknown('encoding');
      this.encoding = 'v1';
      return;
    }
    if (this.done) throw new Unknown('after_done');
    if (!isObj(d)) throw new Unknown('shape');
    if ('type' in d && !('v' in d)) {
      const t = str(d.type) ?? '';
      this.seen.add(`type:${t.slice(0, 40)}`);
      if (!KNOWN_TYPED_EVENTS.has(t)) throw new Unknown(`type:${t.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}`);
      if (t === 'message_stream_complete') this.streamComplete = true;
      this.noteConversation(d.conversation_id, out);
      return;
    }
    if (!('v' in d)) throw new Unknown('shape');
    if (this.encoding !== 'v1') throw new Unknown('encoding');
    this.delta(d, out);
  }

  private delta(d: Obj, out: GptSignal[]): void {
    if ('c' in d) {
      if (typeof d.c !== 'number' || !Number.isInteger(d.c) || d.c < 0 || d.c > 10_000) throw new Unknown('c');
      if (d.c !== this.cur) this.leave(this.cur, out);
      this.cur = d.c;
    }
    const v = d.v;
    let p: unknown;
    let o: unknown;
    if ('p' in d || 'o' in d) {
      p = 'p' in d ? d.p : this.lastP;
      o = 'o' in d ? d.o : this.lastO;
    } else if (isObj(v) && 'message' in v) {
      p = '';
      o = 'add';
    } else if (typeof v === 'string' && this.lastAppendP !== undefined) {
      p = this.lastAppendP;
      o = 'append';
    } else throw new Unknown('delta');
    if (typeof p !== 'string' || typeof o !== 'string') throw new Unknown('delta');
    this.lastP = p;
    this.lastO = o;
    if (o === 'append' && typeof v === 'string') this.lastAppendP = p;
    if (o === 'patch' && Array.isArray(v)) {
      for (const x of v) if (isObj(x) && x.o === 'append' && typeof x.v === 'string' && typeof x.p === 'string') this.lastAppendP = p === '' ? x.p : `${p}${x.p}`;
    }
    const c = this.cur;
    if (p === '' && o === 'add') {
      if (!isObj(v)) throw new Unknown('add');
      const prev = this.slots.get(c);
      if (prev) throw new Unknown('re_add');
      const m0 = isObj(v.message) ? (v.message as Obj) : null;
      this.slots.set(c, { w: v, cls: null, sent: '', finalAtAdd: !!m0 && finalEnough(m0) });
    } else {
      const s = this.slots.get(c);
      if (!s) throw new Unknown('no_message');
      s.w = applyOp(s.w, p, o, v);
    }
    this.examine(c, out);
  }

  private msgOf(s: Slot): Obj | null {
    return isObj(s.w) && isObj(s.w.message) ? (s.w.message as Obj) : null;
  }

  private textOf(s: Slot): string | null {
    const m = this.msgOf(s);
    const content = m && isObj(m.content) ? m.content : null;
    if (!content) return null;
    if (Array.isArray(content.parts)) {
      if (!content.parts.every((x) => typeof x === 'string')) return null;
      return (content.parts as string[]).join('');
    }
    return str(content.text);
  }

  private noteConversation(id: unknown, out: GptSignal[]) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return;
    if (this.conversationId === null) {
      this.conversationId = id;
      out.push({ kind: 'conversation', id });
    } else if (this.conversationId !== id) throw new Unknown('conversation_changed');
  }

  /**
   * A call at its end (the message is done being written to): undecided, or an `api_tool.call_tool`
   * read whose whole body doesn't hold up as that read any more, is an action (returned, and recorded).
   */
  private finalCall(s: Slot): GptToolInfo | null {
    if (s.cls !== 'call' || !s.call) return null;
    const call = s.call;
    if (call.info && !(call.info.kind === 'read' && call.recipient === 'api_tool.call_tool')) return null;
    const again = classifyRecipient(call.recipient, this.textOf(s) ?? '', true, this.links)!;
    if (call.info && again.kind === 'read' && again.name === call.info.name) return null;
    const info = again.kind === 'action' ? again : { ...again, kind: 'action' as const };
    call.info = info;
    return info;
  }

  /** The message at `c` is done being written to (another one started): an undecided call is an action. */
  private leave(c: number, out: GptSignal[]) {
    const s = this.slots.get(c);
    const info = s ? this.finalCall(s) : null;
    if (info) {
      out.push({ kind: 'action', info, msg: c, callId: s!.call!.id, recipient: s!.call!.recipient });
      throw new Stop();
    }
  }

  private examine(c: number, out: GptSignal[]) {
    const s = this.slots.get(c)!;
    if (!isObj(s.w)) throw new Unknown('wrapper');
    if (s.w.error !== undefined && s.w.error !== null) {
      out.push({ kind: 'error', what: 'stream_error' });
      throw new Unknown('stream_error');
    }
    this.noteConversation(s.w.conversation_id, out);
    const m = this.msgOf(s);
    if (!m) {
      if (s.cls === null) return; // not a message (yet)
      throw new Unknown('message_gone');
    }
    const author = isObj(m.author) ? m.author : {};
    const role = str(author.role);
    if (m.recipient !== undefined && m.recipient !== null && typeof m.recipient !== 'string') throw new Unknown('fields');
    if (m.channel !== undefined && m.channel !== null && typeof m.channel !== 'string') throw new Unknown('fields');
    const content = isObj(m.content) ? m.content : null;
    const ct = content ? str(content.content_type) : null;
    const channel = m.channel === undefined || m.channel === null ? null : (m.channel as string);
    const meta = isObj(m.metadata) ? m.metadata : {};
    const status = str(m.status);
    const finished = status === 'finished_successfully';
    const id = typeof m.id === 'string' && m.id.length <= 100 ? m.id : null;
    // No recipient: chatgpt.com's default is `all`, but an assistant message may still name one (a
    // tool call whose recipient arrives late): undecided until it does, or until it completes.
    let recipient = typeof m.recipient === 'string' ? m.recipient : null;
    if (recipient === null) {
      if (role === 'assistant' && s.cls === null && !finished) return; // undecided: nothing forwarded
      recipient = 'all'; // (a decided call losing its recipient is `call_changed` below)
    }
    this.seen.add(`${role}:${recipient === 'all' ? 'all' : 'tool'}:${ct}:${channel ?? '-'}`);

    if (s.cls === null) {
      if (role === 'system' || role === 'user') s.cls = 'hidden';
      else if (role === 'assistant' && recipient === 'all') {
        if (hiddenMeta(meta)) s.cls = 'hidden';
        else if (ct === 'text' && (channel === null || channel === 'final')) {
          s.cls = 'answer';
          // Streamed as it arrives only if its FIRST add was already final (metadata added later,
          // or a recipient that arrived late, can't vouch for text that is already there).
          s.held = !(s.finalAtAdd && finalEnough(m));
          if (s.held) this.seen.add('answer:held');
        } else if (ct === 'text' && channel !== null && HIDDEN_CHANNELS.has(channel)) s.cls = 'hidden';
        else if (ct !== null && HIDDEN_CONTENT.has(ct)) s.cls = 'hidden';
        else throw new Unknown(`content:${String(ct).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}:${String(channel).slice(0, 20)}`);
      } else if (role === 'assistant') {
        s.cls = 'call';
        s.call = { recipient, info: null, settled: false, id, complete: false };
      } else if (role === 'tool') {
        const name = str(author.name) ?? '';
        let of: number | undefined;
        for (const [k, x] of [...this.slots.entries()].sort((a, b) => b[0] - a[0])) {
          if (x.cls === 'call' && x.call && k < c && answers(name, x.call.recipient)) {
            of = k;
            break;
          }
        }
        if (of === undefined) throw new Unknown(`result:${name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}`);
        s.cls = 'result';
        s.of = of;
        const call = this.slots.get(of)!.call!;
        if (!call.settled) {
          call.settled = true;
          if (call.info?.kind === 'read') out.push({ kind: 'tool_done', msg: of });
        }
      } else throw new Unknown(`role:${String(role).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 20)}`);
    }

    switch (s.cls) {
      case 'hidden':
        // Never forwarded. A hidden message turning into something else is not something we know.
        if (role === 'assistant' && recipient !== 'all') throw new Unknown('hidden_changed');
        return;
      case 'answer': {
        if (role !== 'assistant' || recipient !== 'all' || ct !== 'text' || (channel !== null && channel !== 'final')) throw new Unknown('answer_changed');
        if (hiddenMeta(meta)) {
          // Hidden after all: if none of it went out, it simply stays hidden; otherwise stop.
          if (!s.sent) {
            s.cls = 'hidden';
            return;
          }
          throw new Unknown('answer_hidden');
        }
        if (id) this.answerId = id;
        if (status) this.answerStatus = status;
        if (typeof meta.model_slug === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(meta.model_slug)) this.model = meta.model_slug;
        const text = this.textOf(s);
        if (text === null) {
          if (content && Array.isArray(content.parts) && content.parts.length === 0) return;
          throw new Unknown('answer_parts');
        }
        if (s.held) {
          if (!finished) return; // held back whole until the message (and its metadata) is complete
          s.held = false;
        }
        const clean = stripCitations(text, finished);
        if (!clean.startsWith(s.sent)) throw new Unknown('answer_rewritten');
        if (clean.length > s.sent.length) {
          // The model writing its answer again after a complete read call means it has that call's
          // result (it can't go on without it), even if no result message was streamed (web search
          // results arrive as the answer's metadata). A call still being written stays running.
          for (const [k, x] of this.slots) {
            if (k < c && x.cls === 'call' && x.call?.info?.kind === 'read' && !x.call.settled && x.call.complete) {
              x.call.settled = true;
              out.push({ kind: 'tool_done', msg: k });
            }
          }
          const add = clean.slice(s.sent.length);
          const sep = !s.sent && this.anySent ? '\n\n' : '';
          s.sent = clean;
          this.anySent = true;
          out.push({ kind: 'text', text: sep + add });
        }
        return;
      }
      case 'call': {
        const call = s.call!;
        if (role !== 'assistant' || recipient !== call.recipient) throw new Unknown('call_changed');
        if (finished) call.complete = true;
        const body = this.textOf(s) ?? '';
        if (!call.info) {
          const info = classifyRecipient(call.recipient, body, finished, this.links);
          if (!info) return; // api_tool.call_tool: its whole body isn't in yet
          call.info = info;
          if (info.kind === 'action') {
            out.push({ kind: 'action', info, msg: c, callId: call.id, recipient: call.recipient });
            throw new Stop();
          }
          out.push({ kind: 'tool', info, msg: c });
          return;
        }
        if (call.info.kind === 'read' && call.recipient === 'api_tool.call_tool') {
          // A connector read stays one only while its whole body still says exactly that read.
          const again = classifyRecipient(call.recipient, body, true, this.links)!;
          if (again.kind !== 'read' || again.name !== call.info.name) {
            const info = again.kind === 'action' ? again : { ...again, kind: 'action' as const };
            call.info = info;
            out.push({ kind: 'action', info, msg: c, callId: call.id, recipient: call.recipient });
            throw new Stop();
          }
        }
        if (!call.settled) out.push({ kind: 'tool_progress', msg: c });
        return;
      }
      case 'result': {
        if (role !== 'tool') throw new Unknown('result_changed');
        const call = this.slots.get(s.of!)!.call!;
        // Which app each link id belongs to (an app read is allowed only on a link listed as that app).
        if (call.recipient === 'api_tool.list_resources') learnLinks(this.textOf(s) ?? '', this.links);
        if (call.info?.kind === 'read') out.push({ kind: 'tool_progress', msg: s.of! });
        return;
      }
    }
  }
}
