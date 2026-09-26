/**
 * The chat backends ARENA Ask can answer from, each through the user's own logged-in web session
 * via a relay content script running inside the provider's site (an invisible frame in the
 * extension's offscreen document, or a pinned tab). The ARENA side (dropdown, fetch intercept,
 * gate, bridge, enhancer) is provider-agnostic apart from `AskRequest.provider`.
 *
 * - `claude`: claude.ai's internal REST API from inside claude.ai (lib/relay.ts, lib/claude.ts).
 * - `chatgpt`: chatgpt.com's own UI, driven inside chatgpt.com (lib/gpt-relay.ts): the page's own
 *   code sends the message (it handles chatgpt.com's sentinel / proof-of-work), and a MAIN-world
 *   wrapper checks the request before it leaves and tees the answer stream (lib/gpt-page.ts).
 */
export type ProviderId = 'claude' | 'chatgpt';
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'chatgpt'];

export interface Provider {
  id: ProviderId;
  /** Human name ("Claude", "ChatGPT"). */
  name: string;
  /** `<option value>` added to ARENA's `#chat-model`. */
  optionValue: string;
  /** `<option>` label. */
  optionLabel: string;
  /** The model id sent to the provider; null = whatever the provider's page picks. */
  model: string | null;
  /** The site's origin. */
  origin: string;
  /** Match pattern for tabs that can host the relay. */
  tabMatch: string;
  /** URL opened (pinned, inactive) when no relay tab exists, and loaded in the invisible frame. */
  newTabUrl: string;
  /** "Open this conversation" link. */
  chatUrl: (convUuid: string) => string;
  /** The footer link's text. */
  openLabel: string;
}

export const CLAUDE: Provider = {
  id: 'claude',
  name: 'Claude',
  optionValue: 'my-claude',
  optionLabel: 'My Claude (Opus 5.5)',
  model: 'claude-opus-5-5',
  origin: 'https://claude.ai',
  tabMatch: 'https://claude.ai/*',
  newTabUrl: 'https://claude.ai/new',
  chatUrl: (convUuid) => `https://claude.ai/chat/${convUuid}`,
  openLabel: 'Open in claude.ai ↗',
};

export const CHATGPT: Provider = {
  id: 'chatgpt',
  name: 'ChatGPT',
  optionValue: 'my-chatgpt',
  optionLabel: 'My ChatGPT',
  model: null,
  origin: 'https://chatgpt.com',
  tabMatch: 'https://chatgpt.com/*',
  newTabUrl: 'https://chatgpt.com/',
  chatUrl: (convUuid) => `https://chatgpt.com/c/${convUuid}`,
  openLabel: 'Open in ChatGPT ↗',
};

export const PROVIDERS: readonly Provider[] = [CLAUDE, CHATGPT];

export function providerByOption(value: string): Provider | undefined {
  return PROVIDERS.find((p) => p.optionValue === value);
}

export function providerById(id: ProviderId): Provider {
  return id === 'chatgpt' ? CHATGPT : CLAUDE;
}

export const isProviderId = (x: unknown): x is ProviderId => x === 'claude' || x === 'chatgpt';
