import { ARENA_SEL } from './arena-selectors';
import { PROVIDERS, type Provider } from './provider';

/**
 * ARENA's model dropdown: add our option(s) (again, if ARENA ever re-renders the select) and restore
 * the viewer's last choice. The choice is kept in the extension's own storage (the bridge loads it
 * and saves it on the viewer's trusted change of the dropdown, see lib/gesture.ts), never in the
 * page's localStorage, which page scripts can write: the choice also decides which account a
 * question goes to.
 */

/** The page-localStorage key older builds used (removed on start; never read). */
export const LEGACY_MODEL_PREF_KEY = 'arena-ask:model';
/** chrome.storage.local key of the viewer's last dropdown choice. */
export const MODEL_CHOICE_KEY = 'arenaAsk.modelChoice';
export const MODEL_CHOICE_RE = /^[A-Za-z0-9._:-]{1,100}$/;

/** Remove the page-localStorage copy older builds kept. Never throws. */
export function dropLegacyModelPref(): void {
  try {
    localStorage.removeItem(LEGACY_MODEL_PREF_KEY);
  } catch {
    /* storage unavailable */
  }
}

const restored = new WeakSet<HTMLSelectElement>();

/**
 * Ensure our options exist in `#chat-model`; restore `want` (the remembered choice) once per select
 * element, after parsing (so a server-rendered `selected` attribute can't override it), and again if
 * ARENA re-renders the options. `onRestored(value)` is told when the select ends up showing `want`
 * because of that restore. Returns the select.
 */
export function ensureModelOptions(
  doc: Document,
  providers: readonly Provider[] = PROVIDERS,
  want: string | null = null,
  onRestored: (value: string) => void = () => {},
): HTMLSelectElement | null {
  if (doc.readyState === 'loading') return null;
  const sel = doc.querySelector<HTMLSelectElement>(ARENA_SEL.modelSelect);
  if (!sel) return null;
  let added = false;
  for (const p of providers) {
    if ([...sel.options].some((o) => o.value === p.optionValue)) continue;
    const opt = doc.createElement('option');
    opt.value = p.optionValue;
    opt.textContent = p.optionLabel;
    opt.setAttribute('data-arena-ask', '');
    sel.appendChild(opt);
    added = true;
  }
  const ours = !!want && providers.some((p) => p.optionValue === want);
  if (want && (!restored.has(sel) || (added && ours))) {
    restored.add(sel);
    if ([...sel.options].some((o) => o.value === want)) {
      if (sel.value !== want) sel.value = want;
      if (sel.value === want) onRestored(want);
    }
  }
  return sel;
}
