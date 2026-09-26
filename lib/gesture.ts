import { ARENA_SEL, type ArenaChapter } from './arena-selectors';

/**
 * User-gesture gate for the page → bridge channel. Any script on learn.arena.education can post an
 * `ask` (the channel is window.postMessage) and can read, rewrite, restyle or relabel anything in
 * the page, so a question is accepted only if:
 *
 *  1. The user sent it: a trusted (`isTrusted`, browser-generated) mouse click on ARENA's REAL send
 *     button (inside its own box, on a shown, button-sized button that is topmost at that point),
 *     the browser's click for Enter/Space on that button after the user moved the focus there with
 *     Tab, or a trusted plain Enter (no modifier, not while an IME is composing, not a key repeat)
 *     in ARENA's REAL question box. "Real" = the nodes bound when ARENA's page was parsed; ids moved
 *     to other elements later don't count, and a node is re-resolved only once it has left the page.
 *  2. The user typed it: the box's value at that moment is exactly what trusted editing produced
 *     since the last question was sent (`TrustedText`). Each trusted `input` must follow its own
 *     trusted `beforeinput` and be exactly the edit it announced (typed text, a line break, a
 *     deletion, the pasted or dropped text, the IME's text) applied to a box that held only
 *     user-produced text; typing, line breaks, pastes and deletions must happen at the selection the
 *     user's keystroke found (a page listener moving the caret first doesn't count), and text
 *     dragged from the page itself doesn't count. Undo/redo may only return to a value the user
 *     produced since the last send. A script that writes `.value`, calls execCommand, or rewrites the
 *     box inside an event handler taints the box; a tainted box arms nothing (and voids pending
 *     gestures) until the user empties it or replaces all of it.
 *  3. The ask names exactly that question, arrives within GESTURE_TTL_MS, while the page is still
 *     on the gesture's chapter, and nothing but the user (or ARENA clearing it) touched the box in
 *     between. The ask then uses the chapter read at the gesture. One gesture = one ask; a second
 *     ask for an already-used gesture is reported as a duplicate (the bridge stops both). Once used,
 *     the text it covered no longer counts as typed: putting it back needs typing it again.
 *
 * A Send that arms nothing records why, so the ask ARENA then makes for that text gets a specific
 * message ("another extension changed the text", "finish composing", …).
 *
 * Every listener is registered at document_start on `window` in the CAPTURE phase from the
 * isolated world, before any page script exists, so it runs before any listener a page script can
 * add, and its state is out of the page's reach.
 */

export const GESTURE_TTL_MS = 60_000;
/** Pending (sent but not yet asked) gestures kept at once; ARENA ignores Send while it streams. */
const MAX_PENDING = 4;
/** Recent Sends remembered (used, or refused at the gesture) to explain a refusal. */
const MAX_LOG = 16;

export interface Gesture {
  /** The question (trimmed), exactly as the user typed it. */
  prompt: string;
  at: number;
  /** The chapter segment of the page URL at the gesture (ARENA moves between sections with pushState). */
  chapterPath: string;
  /** ARENA's chapter at the gesture. */
  chapter: ArenaChapter;
  /** The box's trusted-edit count at the gesture: what was typed up to it is forgotten once it's used. */
  seq?: number;
  /**
   * The model the viewer chose in ARENA's real dropdown (a trusted change of it, or the choice the
   * extension restored from its own storage) and that it showed at the Send: the ask must name it.
   */
  model?: string;
}

/**
 * Why an ask was refused. `none`: no Send for this text (e.g. a script's own question);
 * `tainted`: the page or another extension changed the text; `undo`: undo/redo brought back text
 * not typed since the last question; `restored`: a draft the browser restored; `resent`: an
 * already-sent question put back by something other than typing; `composing`: Enter while an IME
 * was composing; `key`: Ctrl/Cmd/Alt+Enter or a held-down Enter; `click`: a click that didn't land
 * on the visible Send button itself (or a keyboard-less click with no position, e.g. forwarded from
 * a label); `focus`: Space/Enter on a Send button the user didn't Tab to; `dropped`: text dragged
 * from the page itself was dropped into the box; `moved`: the page went to another chapter first;
 * `mismatch`: the page's chapter data or address isn't the chapter it was loaded for; `duplicate`:
 * a second ask for one Send; `model`: the dropdown showed a model the viewer didn't choose, or the
 * ask named another model than the one chosen at the Send.
 */
export type Refusal =
  | 'none'
  | 'tainted'
  | 'undo'
  | 'restored'
  | 'resent'
  | 'composing'
  | 'key'
  | 'click'
  | 'focus'
  | 'dropped'
  | 'moved'
  | 'mismatch'
  | 'duplicate'
  | 'model';
export type ConsumeResult = { ok: true; gesture: Gesture } | { ok: false; why: Refusal };

export class GestureGate {
  private pending: Gesture[] = [];
  /** Recent Sends, oldest first: used by an ask, or refused at the gesture (and why). */
  private log: { prompt: string; at: number; what: Refusal | 'used' }[] = [];
  /** Called with every pending gesture an ask used up (the capture then forgets the text it covered). */
  onUsed: (g: Gesture) => void = () => {};

  constructor(private readonly ttlMs = GESTURE_TTL_MS) {}

  arm(g: Gesture): void {
    if (!g.prompt) return;
    this.pending.push({ ...g });
    while (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /**
   * A Send (or Enter) that armed nothing: an ask for this text within the TTL is told `why`. A
   * composing Enter also voids a pending gesture for the same text: ARENA sends the half-composed
   * text on it, and that must not go out. So does a Send refused for its model.
   */
  refuse(prompt: string, why: Refusal, at: number): void {
    const p = prompt.trim();
    if (!p) return;
    // A later Send of the same text that was refused for its model voids an earlier one too: the
    // ask ARENA then makes must not go out under that earlier Send's model.
    if (why === 'composing' || why === 'model') this.pending = this.pending.filter((g) => g.prompt !== p);
    this.note(p, at, why);
  }

  /** The box was changed by a script: every pending gesture is void. */
  invalidate(): void {
    this.pending = [];
  }

  private note(prompt: string, at: number, what: Refusal | 'used'): void {
    this.log.push({ prompt, at, what });
    while (this.log.length > MAX_LOG) this.log.shift();
  }

  private prune(now: number): void {
    const fresh = (at: number) => now >= at && now - at <= this.ttlMs;
    this.pending = this.pending.filter((g) => fresh(g.at));
    this.log = this.log.filter((l) => fresh(l.at));
  }

  /** The latest thing that happened to a Send of this text. */
  private last(p: string) {
    for (let k = this.log.length - 1; k >= 0; k--) if (this.log[k].prompt === p) return this.log[k];
    return undefined;
  }

  /** A second ask for a gesture an earlier ask already used (no fresh gesture for it pending)? */
  alreadyUsed(prompt: string, now = Date.now()): boolean {
    this.prune(now);
    const p = prompt.trim();
    return !!p && this.last(p)?.what === 'used' && !this.pending.some((g) => g.prompt === p);
  }

  /**
   * Use the pending gesture for this (page-supplied) question. `boxClean`: the question box holds
   * nothing a script wrote; `model`: the model the ask names (it must be the one chosen at the
   * Send). A question with no matching gesture leaves the pending ones alone.
   */
  consume(prompt: string, o: { chapterPath: string; boxClean: boolean; model?: string; now?: number }): ConsumeResult {
    const now = o.now ?? Date.now();
    this.prune(now);
    const p = prompt.trim();
    const i = p ? this.pending.findIndex((g) => g.prompt === p) : -1;
    if (i < 0) {
      const l = p ? this.last(p) : undefined;
      return { ok: false, why: !l ? 'none' : l.what === 'used' ? 'duplicate' : l.what };
    }
    if (!o.boxClean) {
      this.invalidate();
      return { ok: false, why: 'tainted' };
    }
    const [g] = this.pending.splice(i, 1);
    // Any other Send of the same text armed before now is void too: once used, that text no longer
    // counts as typed (e.g. undo/redo brought it back while ARENA was still fetching its context).
    this.pending = this.pending.filter((x) => x.prompt !== p);
    this.onUsed(g);
    if (g.chapterPath !== o.chapterPath) return { ok: false, why: 'moved' };
    // The ask goes to the provider the viewer chose, never one the page's request names instead.
    if (o.model !== undefined && g.model !== o.model) return { ok: false, why: 'model' };
    this.note(p, now, 'used');
    return { ok: true, gesture: g };
  }
}

/** What the page is told when an ask is refused (after "ARENA Ask couldn't send that question."). */
export function refusalMessage(why: Refusal): string {
  switch (why) {
    case 'tainted':
      return 'Another extension (Grammarly, a text expander, autocorrect) or the page changed the text in the box. Clear the box and type or paste your question again.';
    case 'undo':
      return "Undo/redo brought back text that wasn't typed since your last question. Clear the box and type or paste your question again.";
    case 'restored':
      return 'Your draft was restored by the browser (after a reload or Back), so it doesn\'t count as typed. Select it and retype or paste it, then send.';
    case 'resent':
      return 'That text was already sent as a question and was put back in the box without typing. To ask it again, clear the box and type or paste it.';
    case 'composing':
      return 'Finish composing your text (confirm the IME), then press Enter again.';
    case 'key':
      return 'Send with the Send button or plain Enter (not Ctrl/Cmd/Alt+Enter or a held-down Enter).';
    case 'click':
      return "The click didn't land on ARENA's Send button itself (the page may have moved, resized or covered it). Click the Send button or press Enter.";
    case 'dropped':
      return "Text dragged from this page into the box doesn't count as typed (the page decides what a drag carries). Type or paste your question instead.";
    case 'focus':
      return 'Space/Enter pressed on a Send button that the page (not you, with Tab) focused. Click the Send button, or press Enter in the question box.';
    case 'moved':
      return 'The page moved to another chapter before the question went out. Ask again.';
    case 'mismatch':
      return "This page's chapter information doesn't match the chapter it was loaded for (a script on the page may be interfering). Reload the page and ask again.";
    case 'duplicate':
      return 'Two questions arrived for one Send (a script on this page may be interfering), so ARENA Ask stopped both. Ask again.';
    case 'model':
      return "The model in ARENA's dropdown (or the one its request named) isn't the one you picked; the page may have changed it. Pick the model again, then send.";
    case 'none':
    default:
      return 'It only sends a question you typed in the box and sent with the Send button or Enter.';
  }
}

// ---------------------------------------------------------------------------------------------
// The question box's user-produced value

const COMPOSITION = /^(insertCompositionText|deleteCompositionText|insertFromComposition|deleteByComposition)$/;
/** Values remembered for undo/redo (Chrome's undo can jump back over a long run of typing). */
const MAX_STATES = 1000;
const MAX_STATE_CHARS = 2_000_000;

/** A textarea's value never holds "\r": the browser turns CRLF / CR into LF when it inserts text. */
export const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, '\n');

/** Is `post` = `pre` with one contiguous range replaced by exactly `ins`? */
export function isSplice(pre: string, post: string, ins: string): boolean {
  const L = ins.length;
  if (pre.length - post.length + L < 0) return false; // it would have to remove a negative amount
  const max = Math.min(pre.length, post.length);
  let p = 0;
  while (p < max && pre[p] === post[p]) p++;
  let q = 0;
  while (q < max && pre[pre.length - 1 - q] === post[post.length - 1 - q]) q++;
  for (let a = Math.max(0, post.length - L - q); a <= Math.min(p, post.length - L); a++) {
    if (post.startsWith(ins, a)) return true;
  }
  return false;
}

/** A trusted edit as its `beforeinput` announced it. */
export interface Edit {
  type: string;
  /** `data` of the beforeinput (newlines normalized). */
  data: string | null;
  /** The text it inserts: `data`, else the beforeinput's dataTransfer text/plain (normalized). */
  text: string | null;
  /** The box's value and selection before the edit. */
  pre: string;
  start: number;
  end: number;
}

/**
 * Pasted/dropped text as the box may receive it: macOS "smart paste" adds a space before and/or
 * after a word copied with a double-click.
 */
const smartVariants = (t: string) => [t, ` ${t}`, `${t} `, ` ${t} `];

/**
 * Is `post` = `pre` with one contiguous run deleted at the selection: exactly the selection when
 * there is one, else a run ending at the caret (`*Backward`: Backspace, word or line), starting at
 * it (`*Forward`: Delete…), or (another deletion) containing it?
 */
export function deletedAt(pre: string, post: string, start: number, end: number, type = 'deleteContent'): boolean {
  if (start !== end) return post === pre.slice(0, start) + pre.slice(end);
  const k = pre.length - post.length;
  if (k <= 0) return false;
  const backward = /Backward$/.test(type);
  const forward = /Forward$/.test(type);
  for (let a = Math.max(0, start - k); a <= Math.min(start, pre.length - k); a++) {
    if (backward && a + k !== start) continue;
    if (forward && a !== start) continue;
    if (post === pre.slice(0, a) + pre.slice(a + k)) return true;
  }
  return false;
}

/**
 * Is `post` exactly what `ed` makes of the box (from `ed.pre`, at its selection `start`–`end`)?
 * Typed text, line breaks, pastes and deletions must happen AT the selection (the one the user's
 * keystroke found, when there was one: a page listener moving the caret or widening the selection
 * before the edit doesn't make its result count). Drops, composition updates and spelling
 * replacements don't happen at the selection, so for those any one contiguous splice of exactly
 * their text counts. Undo/redo is judged elsewhere.
 */
export function verifyEdit(ed: Edit, post: string): boolean {
  const { type, text, pre, start, end } = ed;
  if (post === pre) return true; // nothing changed
  const at = (t: string) => post === pre.slice(0, start) + t + pre.slice(end);
  if (COMPOSITION.test(type)) return isSplice(pre, post, text ?? ''); // replaces the composition range
  if (type === 'deleteByDrag') return isSplice(pre, post, ''); // removes the dragged text, wherever the caret is
  if (type.startsWith('delete')) return deletedAt(pre, post, start, end, type);
  if (type === 'insertLineBreak' || type === 'insertParagraph') return at('\n');
  if (!type.startsWith('insert') || !text) return false; // format*, history*, or an insert with no text
  if (type === 'insertFromPaste' || type === 'insertFromPasteAsQuotation') return smartVariants(text).some(at);
  if (type === 'insertFromDrop') return smartVariants(text).some((t) => isSplice(pre, post, t));
  if (type === 'insertText') return at(text);
  return isSplice(pre, post, text); // insertReplacementText (spelling), insertTranspose, insertFromYank…
}

/** Does `ed` replace ALL of `pre` (so none of an untrusted box survives), giving exactly `post`? */
function replacesAll(ed: Edit, post: string): boolean {
  if (ed.start !== 0 || ed.end !== ed.pre.length || !ed.type.startsWith('insert') || !ed.text) return false;
  const t = COMPOSITION.test(ed.type) ? [ed.text] : smartVariants(ed.text);
  return t.includes(post);
}

/** The text a trusted beforeinput carries (plain-text controls put it in `data`). */
function insertedText(e: InputEvent): string | null {
  if (e.data != null) return normalizeNewlines(e.data);
  try {
    const t = e.dataTransfer?.getData('text/plain');
    return t ? normalizeNewlines(t) : null;
  } catch {
    return null;
  }
}

type Box = HTMLTextAreaElement | HTMLInputElement;

/**
 * Tracks the value trusted editing produced in one text box. The caller passes only trusted
 * `beforeinput` / `input` events targeted at that box, with the box itself.
 */
export class TrustedText {
  /** Last user-produced value; null = something else wrote to the box since (tainted, `why`). */
  private value: string | null = '';
  private why: Refusal = 'tainted';
  /** Values trusted edits produced since the last send → the edit that produced it (Map = oldest first). */
  private states = new Map<string, number>();
  private stateChars = 0;
  private edits = 0;
  private valueEdit = 0;
  private pending: (Edit & { clean: boolean; refuse?: Refusal }) | null = null;
  /** A trusted edit event has reached this box. */
  private touched = false;
  /** A non-empty value the box held before the user touched it (form restoration). */
  private restored: string | null = null;
  /** Recently sent questions (trimmed), for the refusal message only. */
  private sent: string[] = [];

  constructor(private readonly onTaint: () => void = () => {}) {}

  /** A different box: nothing typed in it yet. */
  reset(): void {
    this.value = '';
    this.states.clear();
    this.stateChars = 0;
    this.pending = null;
    this.touched = false;
    this.restored = null;
  }

  /** The number of trusted edits so far (a gesture records it). */
  get seq(): number {
    return this.edits;
  }

  /** `current` is empty or exactly what the user produced. */
  isClean(current: string): boolean {
    return current === '' || (this.value !== null && current === this.value);
  }

  /** Why `current` (not clean) doesn't count as typed. */
  whyNot(current: string): Refusal {
    if (this.value === null) return this.why;
    if (this.restored !== null && current === this.restored) return 'restored';
    if (this.sent.includes(current.trim())) return 'resent';
    return 'tainted';
  }

  /** The page has loaded: a value in an untouched box was put there by the browser (or a script). */
  noteInitial(current: string): void {
    if (!this.touched && current !== '' && this.value === '') this.restored = current;
  }

  /** Something other than a trusted edit (a script, an untrusted input event) changed the box. */
  noteUntrusted(current: string): void {
    if (!this.isClean(current)) this.taint(this.whyNot(current));
  }

  /**
   * A question was sent: what was typed up to edit `upTo` no longer counts as typed, and neither
   * does the sent question itself, whenever it was produced (a value undo/redo returned to keeps
   * its edit number, but the question is dropped by text too).
   */
  forget(upTo: number, prompt: string): void {
    const p = prompt.trim();
    for (const [v, n] of this.states) {
      if (n <= upTo || v.trim() === p) {
        this.states.delete(v);
        this.stateChars -= v.length;
      }
    }
    if (this.value !== null && (this.valueEdit <= upTo || this.value.trim() === p)) this.value = '';
    this.sent.push(p);
    if (this.sent.length > 4) this.sent.shift();
  }

  /**
   * A trusted beforeinput. `o.sel`: the selection the user's keystroke found (recorded before any
   * page listener could move it), used instead of the box's current one. `o.refuse`: the edit
   * doesn't count, whatever it does (e.g. text dragged from the page itself).
   */
  beforeInput(e: InputEvent, box: Box, o: { sel?: { start: number; end: number }; refuse?: Refusal } = {}): void {
    const pre = box.value;
    const clean = this.isClean(pre);
    if (!clean) this.taint(this.whyNot(pre));
    this.touched = true;
    this.pending = {
      type: e.inputType || '',
      data: e.data == null ? null : normalizeNewlines(e.data),
      text: insertedText(e),
      pre,
      start: o.sel?.start ?? box.selectionStart ?? pre.length,
      end: o.sel?.end ?? box.selectionEnd ?? pre.length,
      clean,
      ...(o.refuse ? { refuse: o.refuse } : {}),
    };
  }

  input(e: InputEvent, current: string): void {
    const p = this.pending;
    this.pending = null;
    this.touched = true;
    const type = e.inputType || '';
    if (type.startsWith('history')) {
      // Undo/redo (Chrome often sends no beforeinput for it): only back to what the user produced.
      // The value keeps the edit number it was produced with: undo/redo (which a page script can
      // trigger with execCommand, e.g. during the user's Send) never makes older text newer, so a
      // send that covered it still forgets it.
      if (current === '') return this.accept('');
      const n = this.states.get(current);
      if (n === undefined) return this.taint('undo');
      this.value = current;
      this.restored = null;
      this.valueEdit = n;
      return;
    }
    if (p?.refuse) return this.taint(p.refuse);
    if (current === '') return this.accept(''); // emptied: clean again
    const data = e.data == null ? null : normalizeNewlines(e.data);
    // No trusted beforeinput of its own (execCommand fires none), a different edit, or a result the
    // edit can't explain (rewritten mid-edit): not the user's text. From a box that wasn't clean,
    // only an edit that replaced all of it counts.
    const ok =
      !!p &&
      p.type === type &&
      !(p.data !== null && data !== null && p.data !== data) &&
      (p.clean ? verifyEdit(p, current) : replacesAll(p, current));
    if (ok) this.accept(current);
    else this.taint('tainted');
  }

  private accept(v: string): void {
    this.value = v;
    this.restored = null;
    this.valueEdit = ++this.edits;
    if (!v) return;
    if (this.states.has(v)) this.states.delete(v);
    else this.stateChars += v.length;
    this.states.set(v, this.edits);
    for (const [old] of this.states) {
      if (this.states.size <= MAX_STATES && this.stateChars <= MAX_STATE_CHARS) break;
      this.states.delete(old);
      this.stateChars -= old.length;
    }
  }

  /** The first reason sticks until the box is clean again. */
  private taint(why: Refusal): void {
    if (this.value !== null) this.why = why;
    this.value = null;
    this.onTaint();
  }
}

// ---------------------------------------------------------------------------------------------
// DOM capture

/** A node bound once and re-resolved by selector only after it has left the document. */
export class NodeRef<T extends Element> {
  private node: T | null = null;

  constructor(
    private readonly doc: Document,
    private readonly sel: string,
    private readonly onRebind: () => void = () => {},
  ) {}

  get(): T | null {
    if (this.node?.isConnected) return this.node;
    const n = this.doc.querySelector<T>(this.sel);
    if (n !== this.node) {
      this.node = n;
      this.onRebind();
    }
    return this.node;
  }

  get bound(): boolean {
    return !!this.node?.isConnected;
  }
}

/** The largest Send button that counts (ARENA's is 36×36 CSS px). */
export const MAX_BUTTON = { width: 200, height: 120 };
/** Below this effective opacity the button counts as hidden. */
const MIN_OPACITY = 0.3;

/** The product of the `opacity(…)` functions in a computed `filter` value (each clamped to 0–1). */
export function filterOpacity(filter: string | null | undefined): number {
  let o = 1;
  for (const m of (filter || '').matchAll(/opacity\(\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)?\s*(%)?\s*\)/gi)) {
    if (m[1] === undefined) continue; // opacity() = 1
    const v = parseFloat(m[1]) / (m[2] ? 100 : 1);
    if (!Number.isNaN(v)) o *= Math.min(1, Math.max(0, v));
  }
  return o;
}

/** An element's parent in the rendered (flat) tree: its slot, its parent element, or its shadow host. */
function renderParent(n: Element): Element | null {
  if (n.assignedSlot) return n.assignedSlot;
  if (n.parentElement) return n.parentElement;
  const root = n.parentNode as (Node & { host?: Element }) | null;
  return root?.host ?? null;
}

/**
 * Is the button shown as a button? Button-sized (content moved into it makes it bigger), at least
 * partly inside the viewport, not `visibility: hidden`, and its effective opacity (its own and every
 * rendered ancestor's `opacity` and `filter: opacity()`) at least MIN_OPACITY. This can't prove the
 * user sees the button (a `pointer-events: none` overlay on top of it, transparent paint): see the
 * README's residual risks (docs/DESIGN.md "Security model").
 */
export function buttonShown(btn: Element, win: Window): boolean {
  const r = btn.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0 && r.width <= MAX_BUTTON.width && r.height <= MAX_BUTTON.height)) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight) return false;
  const check = (btn as HTMLElement).checkVisibility;
  if (typeof check === 'function' && !check.call(btn, { opacityProperty: true, visibilityProperty: true })) return false;
  if (win.getComputedStyle(btn).visibility !== 'visible') return false;
  let opacity = 1;
  for (let n: Element | null = btn; n; n = renderParent(n)) {
    const cs = win.getComputedStyle(n);
    const o = parseFloat(cs.opacity);
    if (!Number.isNaN(o)) opacity *= o;
    opacity *= filterOpacity(cs.filter);
  }
  return opacity >= MIN_OPACITY;
}

/**
 * Is ARENA's model select rendered at all (not `display: none`, `visibility: hidden` or fully
 * transparent, itself or through an ancestor)? Where `checkVisibility` is missing, assume it is.
 */
export function selectShown(sel: Element): boolean {
  const check = (sel as HTMLElement).checkVisibility;
  return typeof check !== 'function' || check.call(sel, { opacityProperty: true, visibilityProperty: true });
}

/** Is the button (or a child of it) topmost at (x, y)? */
function topmostAt(btn: Element, doc: Document, x: number, y: number): boolean {
  const hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null;
  return !!hit && btn.contains(hit);
}

/**
 * Did this trusted MOUSE click land on the button itself? Inside the button's own border box (a
 * pseudo-element stretched over the page isn't), on a shown button (`buttonShown`) that is (or
 * whose child is) topmost at that point.
 */
export function clickLanded(btn: Element, e: MouseEvent, doc: Document, win: Window): boolean {
  const r = btn.getBoundingClientRect();
  const x = e.clientX;
  const y = e.clientY;
  if (!(x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1)) return false;
  return buttonShown(btn, win) && topmostAt(btn, doc, x, y);
}

/** For a keyboard activation: the button is shown and topmost at its own centre. */
export function keyedButtonShown(btn: Element, doc: Document, win: Window): boolean {
  if (!buttonShown(btn, win)) return false;
  const r = btn.getBoundingClientRect();
  return topmostAt(btn, doc, r.left + r.width / 2, r.top + r.height / 2);
}

export interface CaptureOptions {
  win: Window;
  doc: Document;
  gate: GestureGate;
  /** Our model is the one selected in ARENA's dropdown. */
  enabled: () => boolean;
  /** The viewer changed ARENA's real dropdown (a trusted change): its new value, to remember. */
  onModel?: (value: string) => void;
  /** Where the page is, read at the gesture. */
  where: () => { chapterPath: string; chapter: ArenaChapter };
  /** A trusted click inside ARENA's real "Clear chat history" button. */
  onClear?: () => void;
  /** Injectable for tests only (jsdom can't make trusted events). */
  isTrusted?: (e: Event) => boolean;
  now?: () => number;
  /** Test hook: run `fn` once the current task is over (default: a 0 ms timeout). */
  nextTask?: (fn: () => void) => void;
}

export interface GestureCapture {
  /** The question box holds only what the user typed (or nothing). */
  boxClean(): boolean;
  /** The extension restored the viewer's remembered choice (from its own storage) into the real dropdown. */
  noteModel(value: string): void;
  /** Test hook: remove every listener. */
  uninstall(): void;
}

/**
 * Install the gesture capture. Call at document_start, before anything else, so these capture
 * listeners on `window` precede every listener a page script can add.
 */
export function installGestureCapture(o: CaptureOptions): GestureCapture {
  const isTrusted = o.isTrusted ?? ((e: Event) => e.isTrusted);
  const now = o.now ?? Date.now;
  const nextTask = o.nextTask ?? ((fn: () => void) => void setTimeout(fn, 0));
  const text = new TrustedText(() => o.gate.invalidate());
  const input = new NodeRef<Box>(o.doc, ARENA_SEL.input, () => text.reset());
  const send = new NodeRef<HTMLElement>(o.doc, ARENA_SEL.sendBtn);
  const clear = new NodeRef<HTMLElement>(o.doc, ARENA_SEL.clearBtn);
  /** The model the viewer chose: set only by a trusted change of the real dropdown, or the extension's own restore. */
  let chosen: string | null = null;
  const modelSel = new NodeRef<HTMLSelectElement>(o.doc, ARENA_SEL.modelSelect, () => (chosen = null));
  const refs = [input, send, clear, modelSel];
  o.gate.onUsed = (g) => text.forget(g.seq ?? text.seq, g.prompt);

  // Bind the real nodes as the parser creates them (MutationObserver callbacks run before any later
  // page script, and ours was created first), so a later id swap can't redirect the bindings.
  const bindAll = () => {
    for (const r of refs) r.get();
    if (refs.every((r) => r.bound)) mo.disconnect();
  };
  const mo = new MutationObserver(bindAll);
  mo.observe(o.doc, { childList: true, subtree: true });
  // Once parsed / loaded / shown: a value in the untouched box is a restored draft.
  const onLoaded = () => {
    bindAll();
    const box = input.get();
    if (box) text.noteInitial(box.value);
  };
  o.doc.addEventListener('DOMContentLoaded', onLoaded);
  o.win.addEventListener('load', onLoaded);
  o.win.addEventListener('pageshow', onLoaded);
  if (o.doc.readyState !== 'loading') onLoaded();

  /** A Send that arms nothing: tell a following ask for this text why. */
  const refuse = (why: Refusal) => {
    const box = input.get();
    if (box && o.enabled()) o.gate.refuse(box.value, why, now());
  };
  const arm = () => {
    const box = input.get();
    if (!box || !o.enabled()) return;
    const v = box.value;
    if (!text.isClean(v)) {
      o.gate.invalidate(); // a script wrote to the box
      return refuse(text.whyNot(v));
    }
    const prompt = v.trim();
    if (!prompt) return;
    // The dropdown must show the model the viewer chose (a script can set its value without an event),
    // and be the one the viewer sees: the only #chat-model in the page, not hidden. A page that moved
    // the id to a select of its own (the real one kept in the page, hidden) shows the viewer choices
    // the gate never sees.
    const sel = modelSel.get();
    const all = o.doc.querySelectorAll(ARENA_SEL.modelSelect);
    if (!sel || all.length !== 1 || all[0] !== sel || !selectShown(sel)) return refuse('model');
    if (chosen === null || sel.value !== chosen) return refuse('model');
    const w = o.where();
    o.gate.arm({ prompt, at: now(), chapterPath: w.chapterPath, chapter: w.chapter, seq: text.seq, model: chosen });
  };
  /** A trusted change of the real dropdown: the viewer's choice. */
  /** The value the viewer's trusted `input` on the dropdown carried (its `change` follows). */
  let inputValue: string | null = null;
  const onModelChange = (e: Event) => {
    const sel = modelSel.get();
    if (!sel || e.target !== sel || !isTrusted(e)) return;
    const v = sel.value;
    if (e.type === 'input') {
      // Our capture listener runs before any page listener: this is the value the viewer picked.
      inputValue = v;
    } else {
      // The browser's `change` after it: a page listener may have set another value in between
      // (on `input`); that is not the viewer's choice, and nothing counts as chosen.
      const picked = inputValue;
      inputValue = null;
      if (picked !== null && picked !== v) {
        chosen = null;
        return;
      }
    }
    if (chosen === v) return;
    chosen = v;
    o.onModel?.(v);
  };

  // The box's selection as the user's keystroke found it: our keydown listener runs before any a
  // page script can add, so a page listener that moves the caret or widens the selection before the
  // edit (on keydown, keypress or beforeinput) doesn't get its result counted as typed.
  // It stays in force (no time limit: a page listener that blocks for a while must not outlast it)
  // until the edit it makes, the key's trusted keyup, a released Cmd/Ctrl (macOS sends no keyup for
  // a key pressed with Cmd held) or a trusted mouse press (e.g. for a menu paste).
  let keySel: { start: number; end: number; value: string; code: string } | null = null;
  /** A keystroke that edits the box (text, a line break, a deletion, a paste or cut); not while composing. */
  const editKey = (k: KeyboardEvent) =>
    !k.isComposing &&
    k.keyCode !== 229 &&
    (([...k.key].length === 1 && !k.ctrlKey && !k.metaKey) ||
      k.key === 'Enter' ||
      k.key === 'Backspace' ||
      k.key === 'Delete' ||
      ((k.ctrlKey || k.metaKey) && /^[vx]$/i.test(k.key)));
  const noteKey = (k: KeyboardEvent) => {
    const box = input.get();
    if (!box || k.target !== box || !editKey(k)) return;
    const v = box.value;
    keySel = { start: box.selectionStart ?? v.length, end: box.selectionEnd ?? v.length, value: v, code: k.code };
  };

  /** A drag the user started in this page (a trusted dragstart): the page chooses what it carries. */
  let drag: { fromBox: boolean; text: string } | null = null;
  const onDragstart = (e: Event) => {
    if (!isTrusted(e)) return;
    const box = input.get();
    const fromBox = !!box && e.target === box;
    // Moving the user's own selected text within the box is fine, if that is what gets dropped.
    const sel = fromBox ? normalizeNewlines(box!.value.slice(box!.selectionStart ?? 0, box!.selectionEnd ?? 0)) : '';
    drag = { fromBox, text: sel };
  };
  const onDragend = (e: Event) => {
    if (isTrusted(e)) drag = null; // a page's synthetic dragend must not end the drag it chose the data for
  };
  const onPointerdown = (e: Event) => {
    if (isTrusted(e)) keySel = null; // the user moves the caret or opens a menu: that keystroke is over
  };
  const onDrop = (e: Event) => {
    if (!isTrusted(e)) return;
    const d = drag;
    nextTask(() => {
      if (drag === d) drag = null; // the drop's edit (if any) ran in its task
    });
  };

  const onBeforeInput = (e: Event) => {
    const box = input.get();
    if (!box || e.target !== box || !isTrusted(e)) return;
    const ie = e as InputEvent;
    const k = keySel;
    keySel = null;
    const sel = k && k.value === box.value ? { start: k.start, end: k.end } : undefined;
    let refuse: Refusal | undefined;
    // The caret or selection moved between the user's keystroke and the edit it makes: something
    // other than the user chose where the edit lands.
    if (sel && (box.selectionStart !== sel.start || box.selectionEnd !== sel.end)) refuse = 'tainted';
    if (ie.inputType === 'insertFromDrop' && drag && !(drag.fromBox && insertedText(ie) === drag.text)) refuse ??= 'dropped';
    text.beforeInput(ie, box, { ...(sel ? { sel } : {}), ...(refuse ? { refuse } : {}) });
  };
  const onInput = (e: Event) => {
    if (e.target && e.target === modelSel.get()) return onModelChange(e);
    const box = input.get();
    if (!box || e.target !== box) return;
    if (isTrusted(e)) text.input(e as InputEvent, box.value);
    else text.noteUntrusted(box.value); // a script's synthetic event (after writing .value)
  };
  // Keyboard activation of the Send button. The browser clicks a focused button (a click with no
  // mouse position, detail 0) on an Enter keypress or a Space keyup, in that key event's task. It
  // counts only if the user put the focus there with Tab: a script's btn.focus() would otherwise
  // turn the user's next Space or Enter into a Send.
  /** A trusted Tab keydown whose task is still running (its default action moves the focus). */
  let tabKey: KeyboardEvent | null = null;
  /** The trusted Tab keydown that moved the focus to the Send button (null: focused another way). */
  let focusedBy: KeyboardEvent | null = null;
  /** A trusted Enter keypress / Space keyup on the Send button whose task is still running. */
  let activation: KeyboardEvent | null = null;
  /** A trusted Space keydown on the Send button (the browser clicks on the matching keyup). */
  let spaceDown = false;
  const forThisTask = (k: KeyboardEvent, what: 'tab' | 'activation') => {
    if (what === 'tab') tabKey = k;
    else activation = k;
    nextTask(() => {
      if (tabKey === k) tabKey = null;
      if (activation === k) activation = null;
    });
  };
  const onFocusin = (e: Event) => {
    const btn = send.get();
    if (btn && e.target === btn) focusedBy = tabKey;
  };
  const onFocusout = (e: Event) => {
    const btn = send.get();
    if (btn && e.target === btn) {
      focusedBy = null;
      spaceDown = false;
    }
  };

  const onKeydown = (e: Event) => {
    const k = e as KeyboardEvent;
    if (!isTrusted(k)) return;
    noteKey(k);
    if (k.key === 'Tab') {
      if (!k.ctrlKey && !k.altKey && !k.metaKey) forThisTask(k, 'tab');
      return;
    }
    const btn = send.get();
    if (btn && k.target === btn && k.key === ' ') spaceDown = true;
    if (k.key !== 'Enter') return;
    const box = input.get();
    if (!box || k.target !== box || k.shiftKey) return; // Shift+Enter: a new line (ARENA agrees)
    // ARENA sends on every other Enter, even mid-composition: refuse those with a reason.
    if (k.isComposing || k.keyCode === 229) return refuse('composing');
    if (k.ctrlKey || k.altKey || k.metaKey || k.repeat) return refuse('key');
    arm();
  };
  const onKeypress = (e: Event) => {
    const k = e as KeyboardEvent;
    const btn = send.get();
    if (isTrusted(k) && btn && k.target === btn && k.key === 'Enter') forThisTask(k, 'activation');
  };
  const onKeyup = (e: Event) => {
    const k = e as KeyboardEvent;
    if (!isTrusted(k)) return;
    // That keystroke made no edit (or Cmd/Ctrl, with which macOS never sends the key's own keyup).
    if (keySel && (k.code === keySel.code || k.key === 'Meta' || k.key === 'Control')) keySel = null;
    const btn = send.get();
    if (!btn || k.target !== btn || k.key !== ' ') return;
    if (spaceDown) forThisTask(k, 'activation');
    spaceDown = false;
  };
  /** Why a click with no mouse position (detail 0) on the Send button doesn't count, or null if it does. */
  const keyboardRefusal = (btn: HTMLElement, target: Node): Refusal | null => {
    const key = activation;
    activation = null;
    // Not the browser's click for the user's Enter/Space on the button (e.g. forwarded from a <label>).
    if (target !== btn || !key) return 'click';
    if (o.doc.activeElement !== btn || !focusedBy || focusedBy.defaultPrevented) return 'focus';
    return keyedButtonShown(btn, o.doc, o.win) ? null : 'click';
  };
  const onClick = (e: Event) => {
    if (!isTrusted(e)) return;
    const t = e.target as Node | null;
    if (!t) return;
    const btn = send.get();
    if (btn?.contains(t)) {
      const m = e as MouseEvent;
      const why = m.detail === 0 ? keyboardRefusal(btn, t) : clickLanded(btn, m, o.doc, o.win) ? null : 'click';
      if (why) refuse(why);
      else arm();
    } else if (o.onClear && clear.get()?.contains(t)) o.onClear();
  };

  const listeners: [string, (e: Event) => void][] = [
    ['beforeinput', onBeforeInput],
    ['input', onInput],
    ['keydown', onKeydown],
    ['keypress', onKeypress],
    ['keyup', onKeyup],
    ['focusin', onFocusin],
    ['focusout', onFocusout],
    ['click', onClick],
    ['dragstart', onDragstart],
    ['dragend', onDragend],
    ['pointerdown', onPointerdown],
    ['mousedown', onPointerdown],
    ['drop', onDrop],
    ['change', onModelChange],
  ];
  for (const [type, fn] of listeners) o.win.addEventListener(type, fn, true);

  return {
    boxClean: () => {
      const box = input.get();
      return !!box && text.isClean(box.value);
    },
    noteModel: (value: string) => {
      if (modelSel.get()?.value === value) chosen = value;
    },
    uninstall: () => {
      mo.disconnect();
      o.doc.removeEventListener('DOMContentLoaded', onLoaded);
      o.win.removeEventListener('load', onLoaded);
      o.win.removeEventListener('pageshow', onLoaded);
      for (const [type, fn] of listeners) o.win.removeEventListener(type, fn, true);
      o.gate.onUsed = () => {};
    },
  };
}
