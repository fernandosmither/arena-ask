import type { Browser } from 'wxt/browser';
import {
  ARENA_EXCLUDE_MATCHES,
  ARENA_ORIGIN,
  ARENA_SEL,
  arenaHistoryKey,
  chapterMatchesPath,
  chapterPathOf,
  isArenaCoursePage,
  readChapter,
  type ArenaChapter,
} from '@/lib/arena-selectors';
import { MODEL_CHOICE_KEY, MODEL_CHOICE_RE, dropLegacyModelPref, ensureModelOptions } from '@/lib/arena-ui';
import { GestureGate, installGestureCapture, refusalMessage } from '@/lib/gesture';
import { STATE_ATTR, clearStatus, enhanceBubble, injectStyles, scanBubbles, setStatus } from '@/lib/enhance';
import { ext, extAlive } from '@/lib/ext';
import { textHash } from '@/lib/hash';
import type { BubbleMeta } from '@/lib/meta';
import { MetaStore, answerIndexOf } from '@/lib/meta-store';
import {
  BRIDGE_SOURCE,
  EMPTY_ANSWER_NOTE,
  GPT_EMPTY_ANSWER_NOTE,
  KEEPALIVE_MS,
  LIMITS,
  PORT_ASK,
  humanError,
  interruptionNote,
  type AskRequest,
} from '@/lib/protocol';
import { PROVIDERS, providerByOption, type Provider } from '@/lib/provider';
import { RateLimiter, chapterKeyFor, parseArenaHistory, parsePageMessage, validateStreamEvent } from '@/lib/validate';

/**
 * The bridge: isolated world of learn.arena.education (top frame only). The only component with
 * both the page (DOM + window messages) and extension APIs. It:
 *  - adds "My Claude (Opus 5.5)" and "My ChatGPT" to ARENA's model dropdown and remembers the choice;
 *  - validates `ask` messages from the MAIN-world fetch interceptor (source/origin, schema, size
 *    caps, one in flight, ≤ 20/min) and accepts one only for a question the user typed and sent
 *    with a trusted click on ARENA's real send button / Enter in its real box (lib/gesture.ts),
 *    once per Send; streams answers back to it;
 *  - forgets the chapter's conversation when the user clicks ARENA's real "Clear chat history";
 *  - renders finished answers as markdown with an "Open in claude.ai" / "Open in ChatGPT" footer,
 *    including answers ARENA re-renders from its localStorage history.
 */
export default defineContentScript({
  matches: ['https://learn.arena.education/*'],
  excludeMatches: ARENA_EXCLUDE_MATCHES,
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main() {
    if (window.top !== window || !isArenaCoursePage(location.href)) return;
    try {
      startBridge();
    } catch (e) {
      console.warn('[arena-ask] bridge failed to start', e);
    }
  },
});

type Port = Browser.runtime.Port;

function startBridge() {
  // The chapter segment of the URL this document was loaded at. The chapter key, ARENA's history and
  // the conversation are those of this chapter only: #chapter-data (which any page script can
  // rewrite) is used only while it names this chapter, and the gesture's chapter must be it too.
  const loadedPath = chapterPathOf(location.pathname);
  /** `chapter` (read from #chapter-data at `chapterPath`), if it is the chapter this page was loaded for. */
  const ownChapter = (chapterPath: string, chapter: ArenaChapter): ArenaChapter | null =>
    chapterPath === loadedPath && chapterMatchesPath(chapter, loadedPath) ? chapter : null;

  // FIRST, at document_start: the gesture capture (window, capture phase), so its listeners run
  // before any listener a page script can add. It also watches ARENA's real "Clear chat history".
  let onClear: () => void = () => {};
  const gate = new GestureGate();
  /** The viewer's remembered dropdown choice (extension storage, which page scripts can't write). */
  let wantModel: string | null = null;
  const capture = installGestureCapture({
    win: window,
    doc: document,
    gate,
    enabled: () => {
      const v = document.querySelector<HTMLSelectElement>(ARENA_SEL.modelSelect)?.value;
      return PROVIDERS.some((p) => p.optionValue === v);
    },
    where: () => ({ chapterPath: chapterPathOf(location.pathname), chapter: readChapter(document) }),
    onClear: () => onClear(),
    // The viewer picked a model in the real dropdown (a trusted change): remember it for the next page.
    onModel: (value) => {
      if (!MODEL_CHOICE_RE.test(value)) return;
      wantModel = value;
      try {
        void ext()
          .storage.local.set({ [MODEL_CHOICE_KEY]: value })
          .catch(() => {});
      } catch {
        /* extension reloaded under the page */
      }
    },
  });
  dropLegacyModelPref();
  try {
    void ext()
      .storage.local.get(MODEL_CHOICE_KEY)
      .then((got) => {
        const v = (got as Record<string, unknown>)[MODEL_CHOICE_KEY];
        if (wantModel === null && typeof v === 'string' && MODEL_CHOICE_RE.test(v)) {
          wantModel = v;
          schedule();
        }
      })
      .catch(() => {});
  } catch {
    /* extension reloaded under the page */
  }

  const limiter = new RateLimiter(LIMITS.perMinute, 60_000);
  const meta = new MetaStore();
  const seen = new WeakMap<Element, string>();
  let inflight: string | null = null;
  let cancelInflight: (() => void) | null = null;
  /** Stop the answer in flight and tell its asker `message`. */
  let failInflight: ((message: string) => void) | null = null;
  let chapterKeyCache: string | null = null;
  let metaChapter: string | null = null;

  // Visible to the page (and QA): the bridge is running. The dropdown option reveals as much anyway.
  try {
    document.documentElement.setAttribute('data-arena-ask-bridge', ext().runtime.getManifest().version);
  } catch {
    /* ignore */
  }

  /** This page's chapter key; null while #chapter-data doesn't name the chapter of the URL. */
  const chapterKey = (): string | null => {
    if (chapterKeyCache) return chapterKeyCache;
    const c = ownChapter(chapterPathOf(location.pathname), readChapter(document));
    const key = c ? chapterKeyFor(c.id) : null;
    if (key && document.readyState !== 'loading') chapterKeyCache = key; // #chapter-data is parsed by now
    return key;
  };

  type ToPage = { type: 'ack' } | { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; message: string };
  const post = (id: string, msg: ToPage) => window.postMessage({ source: BRIDGE_SOURCE, id, ...msg }, ARENA_ORIGIN);

  // --- DOM upkeep: dropdown option (survives re-renders), styles, bubble enhancement -----------

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tick();
    }, 60);
  };
  function tick() {
    if (document.readyState === 'loading') return;
    injectStyles(document);
    // Our options, and the viewer's remembered choice restored (then it counts as chosen: lib/gesture.ts).
    ensureModelOptions(document, PROVIDERS, wantModel, (v) => capture.noteModel(v));
    const key = chapterKey();
    if (!key) return;
    if (key !== metaChapter) {
      metaChapter = key;
      void meta.load(key).then(schedule);
      return;
    }
    if (meta.size) scanBubbles(document, meta.lookup, seen);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', schedule);
  schedule();

  // --- ARENA's "Clear chat history" (a trusted click on the real button): the next question -----
  // starts a new claude.ai conversation.

  onClear = () => {
    const key = chapterKey();
    if (!key) return;
    try {
      void ext()
        .runtime.sendMessage({ type: 'reset', chapterKey: key })
        .catch(() => {});
    } catch {
      /* extension reloaded under the page */
    }
    void meta.clear(key);
  };

  // --- Questions from the MAIN-world interceptor ------------------------------------------------

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== ARENA_ORIGIN) return;
    const r = parsePageMessage(e.data);
    if (r.kind === 'ignore') return;
    if (r.kind === 'cancel') {
      // ARENA gave up on its request: stop the answer (the relay aborts and stops claude.ai).
      if (r.id === inflight) cancelInflight?.();
      return;
    }
    if (r.kind === 'invalid') {
      if (r.id) post(r.id, { type: 'error', message: r.message });
      return;
    }
    const { id, context } = r.msg;
    if (inflight) {
      // A second ask for the Send whose ask is running: one of the two didn't come from ARENA's
      // own code (e.g. a script raced it with the user's question and its own context). Stop both.
      if (gate.alreadyUsed(r.msg.prompt)) {
        console.warn('[arena-ask] two questions arrived for one Send; stopped both');
        failInflight?.(humanError('invalid', refusalMessage('duplicate')));
        return post(id, { type: 'error', message: humanError('invalid', refusalMessage('duplicate')) });
      }
      return post(id, { type: 'error', message: humanError('busy') });
    }
    // Only a question the user typed and sent (lib/gesture.ts), once, from the same chapter, to the
    // model the user chose at that Send (ARENA's request naming another one is refused).
    const g = gate.consume(r.msg.prompt, { chapterPath: chapterPathOf(location.pathname), boxClean: capture.boxClean(), model: r.msg.model });
    if (!g.ok) {
      console.warn(`[arena-ask] refused a question (${g.why}): only a question typed in the box and sent with Send or Enter goes out`);
      return post(id, { type: 'error', message: humanError('invalid', refusalMessage(g.why)) });
    }
    // The chapter read at the gesture must be the one this page was loaded for (not one a script
    // wrote into #chapter-data or pushed into the URL): its key picks the conversation and history.
    const chapter = ownChapter(g.gesture.chapterPath, g.gesture.chapter);
    if (!chapter) {
      console.warn("[arena-ask] refused a question: the page's chapter data doesn't match its address");
      return post(id, { type: 'error', message: humanError('invalid', refusalMessage('mismatch')) });
    }
    if (!extAlive()) return post(id, { type: 'error', message: humanError('disconnected') });
    if (!limiter.allow()) return post(id, { type: 'error', message: humanError('too_many') });
    post(id, { type: 'ack' });
    const site = g.gesture.model ? providerByOption(g.gesture.model) : undefined;
    if (!site) return post(id, { type: 'error', message: humanError('invalid', refusalMessage('model')) });
    ask(id, g.gesture.prompt, context, chapter, site);
  });

  function lastAssistantBubble(): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>(`${ARENA_SEL.messages} ${ARENA_SEL.assistantBubble}`);
    const el = all[all.length - 1] ?? null;
    return el && !el.hasAttribute(STATE_ATTR) ? el : null;
  }

  /** `chapter`: ARENA's chapter when the user sent the question; `site`: the model ARENA's request named. */
  function ask(id: string, prompt: string, context: string, chapter: ArenaChapter, site: Provider) {
    const gpt = site.id === 'chatgpt';
    inflight = id;
    const key = chapterKeyFor(chapter.id);
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(arenaHistoryKey(chapter.id)); // ARENA saved the question before fetching
    } catch {
      /* unreadable: treated as unknown history */
    }
    const h = parseArenaHistory(raw, prompt);
    const bubble = lastAssistantBubble();
    bubble?.setAttribute(STATE_ATTR, 'streaming');

    let text = '';
    let ended = false;
    let port: Port;
    let ping: ReturnType<typeof setInterval> | undefined;
    const end = () => {
      ended = true;
      clearStatus(bubble);
      clearInterval(ping);
      inflight = null;
      cancelInflight = null;
      failInflight = null;
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    };
    cancelInflight = () => {
      if (ended) return;
      end();
      bubble?.removeAttribute(STATE_ATTR);
    };
    const onError = (message: string, convUuid?: string) => {
      if (text) {
        // Keep what arrived; ARENA saves it with the note.
        const note = interruptionNote(message);
        text += note;
        post(id, { type: 'delta', text: note });
        post(id, { type: 'done' });
        end();
        void finalize(bubble, key, text, { c: convUuid ?? null, u: null, w: null, t: Date.now(), ...(gpt ? { p: 'g' as const } : {}) });
      } else {
        post(id, { type: 'error', message });
        end();
        bubble?.removeAttribute(STATE_ATTR);
      }
    };

    failInflight = (message: string) => {
      if (!ended) onError(message); // ends the port: the background stops the relay and claude.ai
    };

    try {
      port = ext().runtime.connect({ name: PORT_ASK });
    } catch {
      inflight = null;
      cancelInflight = null;
      failInflight = null;
      bubble?.removeAttribute(STATE_ATTR);
      return post(id, { type: 'error', message: humanError('disconnected') });
    }
    ping = setInterval(() => {
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        /* disconnect handler reports it */
      }
    }, KEEPALIVE_MS);

    port.onMessage.addListener((m: unknown) => {
      if (ended) return;
      const ev = validateStreamEvent(m, false);
      if (!ev) return;
      if (ev.type === 'status') {
        setStatus(bubble, ev.text); // a tool is running (full mode): shown, never saved
      } else if (ev.type === 'delta') {
        clearStatus(bubble);
        text += ev.text;
        post(id, { type: 'delta', text: ev.text });
      } else if (ev.type === 'done') {
        if (!text) {
          text = gpt ? GPT_EMPTY_ANSWER_NOTE : EMPTY_ANSWER_NOTE;
          post(id, { type: 'delta', text });
        }
        post(id, { type: 'done' });
        end();
        void finalize(bubble, key, text, {
          c: ev.convUuid,
          u: ev.util5h,
          w: ev.util7d,
          t: Date.now(),
          v: ev.via,
          ...(gpt ? { p: 'g' as const } : {}),
          ...(ev.model ? { m: ev.model } : {}),
        });
      } else if (ev.type === 'error') {
        onError(ev.message, ev.convUuid);
      }
    });
    port.onDisconnect.addListener(() => {
      void ext().runtime.lastError;
      if (!ended) onError(humanError('disconnected'));
    });

    const req: AskRequest = {
      type: 'ask',
      provider: site.id,
      chapterKey: key,
      chapterTitle: chapter.title,
      prompt,
      context,
      history: h.history,
      priorCount: h.priorCount,
      anchor: h.anchor,
    };
    port.postMessage(req);
  }

  /** Record the answer's metadata, then enhance its bubble once ARENA has written the final text. */
  async function finalize(bubble: HTMLElement | null, key: string, text: string, m: BubbleMeta) {
    await meta.put(key, { hash: textHash(text), index: bubble ? answerIndexOf(bubble) : -1 }, m);
    if (bubble) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (bubble.isConnected && bubble.textContent === text) return enhanceBubble(bubble, text, m);
        if (!bubble.isConnected) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      bubble.removeAttribute(STATE_ATTR);
    }
    schedule(); // ARENA re-rendered (or the text differs): let the scanner find it by hash
  }
}
