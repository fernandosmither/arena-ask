import { ext } from '@/lib/ext';
import { ISSUES_URL, PRIVACY_URL, README_URL } from '@/lib/links';
import { MSG_SETTINGS, type SettingsRequest, type SettingsResponse, type SettingsSnapshot } from '@/lib/settings';

/**
 * The Options page. Every read and change goes to the background as a runtime message, which it
 * accepts only from this page (lib/settings.ts). Nothing here touches storage directly.
 */

type Op = SettingsRequest extends infer R ? (R extends { type: string } ? Omit<R, 'type'> : never) : never;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modeSet = $<HTMLFieldSetElement>('mode');
const dnr = $<HTMLInputElement>('gpt-dnr');
const forget = { claude: $<HTMLButtonElement>('forget-claude'), chatgpt: $<HTMLButtonElement>('forget-chatgpt') };
const pinState = { claude: $('pin-claude'), chatgpt: $('pin-chatgpt') };
const status = $('status');
const loadError = $('load-error');

let current: SettingsSnapshot | null = null;
let busy = false;

async function call(op: Op): Promise<SettingsSnapshot> {
  const r = (await ext().runtime.sendMessage({ type: MSG_SETTINGS, ...op })) as SettingsResponse | undefined;
  if (!r || r.ok !== true) throw new Error((r && 'error' in r && r.error) || 'no answer');
  return r.settings;
}

let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** A short confirmation (or error) toast; errors stay until the next change. */
function say(text: string, error = false): void {
  clearTimeout(hideTimer);
  status.textContent = text;
  status.classList.toggle('error', error);
  status.classList.add('shown');
  if (!error) hideTimer = setTimeout(() => status.classList.remove('shown'), 4000);
}

function render(s: SettingsSnapshot): void {
  current = s;
  for (const r of modeSet.querySelectorAll<HTMLInputElement>('input[name=mode]')) r.checked = r.value === s.mode;
  dnr.checked = s.gptDoNotRemember;
  for (const p of ['claude', 'chatgpt'] as const) {
    pinState[p].textContent = s.pinned[p] ? 'Pinned' : 'Not pinned yet';
    pinState[p].classList.toggle('pinned', s.pinned[p]);
    forget[p].disabled = busy || !s.pinned[p];
  }
  modeSet.disabled = busy;
  dnr.disabled = busy;
}

async function apply(op: Op, done: (s: SettingsSnapshot) => string): Promise<void> {
  busy = true;
  if (current) render(current);
  try {
    const s = await call(op);
    busy = false;
    render(s);
    say(done(s));
  } catch {
    busy = false;
    say("Couldn't save that change. Reload the page and try again.", true);
    await refresh();
  }
}

async function refresh(): Promise<void> {
  try {
    const s = await call({ op: 'get' });
    loadError.hidden = true;
    render(s);
  } catch {
    loadError.hidden = false;
  }
}

modeSet.addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (v !== 'full' && v !== 'locked') return;
  void apply({ op: 'setMode', mode: v }, (s) =>
    s.mode === 'full' ? 'Saved: full account access.' : 'Saved: locked. My ChatGPT is off in this mode.',
  );
});

dnr.addEventListener('change', () => {
  void apply({ op: 'setGptDoNotRemember', on: dnr.checked }, (s) =>
    s.gptDoNotRemember
      ? 'Saved: from the next question, ARENA chats on ChatGPT are "don\'t remember".'
      : 'Saved: from the next question, ARENA chats on ChatGPT are normal chats (a marked chat is unmarked when you next ask in it).',
  );
});

for (const p of ['claude', 'chatgpt'] as const) {
  forget[p].addEventListener('click', () => {
    void apply({ op: 'forgetAccount', provider: p }, () =>
      `${p === 'claude' ? 'Claude' : 'ChatGPT'} account forgotten. The next question pins the account you're signed in to.`,
    );
  });
}

$<HTMLAnchorElement>('link-readme').href = README_URL;
$<HTMLAnchorElement>('link-privacy').href = PRIVACY_URL;
$<HTMLAnchorElement>('link-issues').href = ISSUES_URL;
$('version').textContent = `Version ${ext().runtime.getManifest().version}`;

// Settings can also change from the service worker's console: re-read when the page comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !busy) void refresh();
});

void refresh();
