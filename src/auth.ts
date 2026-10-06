export interface Me {
  mode: 'player' | 'dev' | 'none';
  user?: { name?: string; email?: string };
  projectName?: string;
  walletUrl: string;
  loginAvailable: boolean;
  /** True when /api/me could not be read, so the server's real state is unknown. */
  unavailable?: boolean;
  /** In dev mode: whether the server's key calls Opper or TypeSafe directly. */
  devProvider?: 'opper' | 'typesafe';
  /** The decision models this key can play, and the one the server uses when the game names none. */
  models?: string[];
  defaultModel?: string;
}

export type AccountView = {
  kind: 'player' | 'dev' | 'demo' | 'signed-out';
  me: Me;
  notice?: string;
  /** Makes the notice a link (opened in a new tab), e.g. to the wallet. */
  noticeLink?: string;
};

const DEFAULT_WALLET_URL = 'https://platform.opper.ai/wallet';
const ME_TIMEOUT_MS = 2500;

// A transient failure must not read as "not configured", so sign-in stays enabled.
const fallbackMe = (): Me => ({ mode: 'none', walletUrl: DEFAULT_WALLET_URL, loginAvailable: true, unavailable: true });

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function httpsUrl(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_WALLET_URL;
  try {
    return new URL(v).protocol === 'https:' ? v : DEFAULT_WALLET_URL;
  } catch {
    return DEFAULT_WALLET_URL;
  }
}

function parseMe(body: unknown): Me | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.mode !== 'player' && b.mode !== 'dev' && b.mode !== 'none') return null;
  const me: Me = { mode: b.mode, walletUrl: httpsUrl(b.walletUrl), loginAvailable: b.loginAvailable === true };
  if (typeof b.user === 'object' && b.user !== null) {
    const u = b.user as Record<string, unknown>;
    me.user = { name: text(u.name), email: text(u.email) };
  }
  const projectName = text(b.projectName);
  if (projectName) me.projectName = projectName;
  if (b.devProvider === 'opper' || b.devProvider === 'typesafe') me.devProvider = b.devProvider;
  const defaultModel = text(b.defaultModel);
  if (defaultModel) me.defaultModel = defaultModel;
  if (Array.isArray(b.models)) me.models = b.models.filter((m): m is string => typeof m === 'string' && m.length > 0).slice(0, 20);
  return me;
}

export async function fetchMe(): Promise<Me> {
  try {
    const res = await fetch('/api/me', { signal: AbortSignal.timeout(ME_TIMEOUT_MS) });
    if (res.ok) return parseMe(await res.json()) ?? fallbackMe();
  } catch {
    // offline, timed out, or bad JSON: behave as signed out
  }
  return fallbackMe();
}

export function signIn(): void {
  window.location.href = '/auth/login';
}

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  window.location.reload();
}

const AUTH_ERRORS: Record<string, string> = {
  state: 'Sign-in could not be verified (it may have timed out). Please try again.',
  denied: 'Sign-in was cancelled.',
  exchange: 'Opper sign-in failed. Please try again.',
};

/** Reads and removes `?auth_error=` from the address bar. */
export function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('auth_error');
  if (!code) return null;
  url.searchParams.delete('auth_error');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return AUTH_ERRORS[code] ?? 'Sign-in failed. Please try again.';
}

/** The notice the account bar starts with: a sign-in error, else a warning that /api/me was unreachable. */
export function accountNotice(me: Me, authError: string | null, demo: boolean): string | undefined {
  if (authError) return authError;
  if (me.unavailable) return demo ? "Couldn't reach the server — showing the recorded demo" : "Couldn't reach the server";
  return undefined;
}

/** The notice for a player whose Opper wallet ran dry (HTTP 402 from /api/decide). */
export function walletNotice(walletUrl: string): { notice: string; noticeLink: string } {
  return { notice: 'Your Opper wallet is empty — top up to keep playing', noticeLink: httpsUrl(walletUrl) };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function signInButton(me: Me): HTMLButtonElement {
  const b = el('button', 'Sign in with Opper', 'signin');
  b.disabled = !me.loginAvailable;
  if (!me.loginAvailable) b.title = 'Login with Opper is not configured on this server';
  b.addEventListener('click', signIn);
  return b;
}

export const REPO_URL = 'https://github.com/joch/jevman';

/** The alternative to signing in: run jevman locally with your own TypeSafe (or Opper) key. */
function runItYourself(lead: string): HTMLElement {
  const hint = el('p', lead, 'hint');
  const link = el('a', 'clone the repo and use your own TypeSafe key');
  link.href = `${REPO_URL}#option-c--your-own-typesafe-key-jev-straight-from-typesafe`;
  link.target = '_blank';
  link.rel = 'noopener';
  hint.append(link);
  return hint;
}

/**
 * The account area of the page header: a badge and one line saying how jev is paid for, an optional hint below it,
 * and the actions (sign in, wallet, sign out) beside it.
 */
export function renderAccount(root: HTMLElement, view: AccountView): void {
  const { me } = view;
  const text = el('div', undefined, 'account-text');
  const actions = el('div', undefined, 'account-actions');
  const line = (badge: string, message: string) => {
    const p = el('p', undefined, 'status');
    p.append(el('span', badge, 'badge'), el('span', message));
    text.append(p);
  };
  // With a notice, "Try again" takes the place of the view's own sign-in button.
  const retry = Boolean(view.notice) && view.kind !== 'player';
  if (view.kind === 'player') {
    const who = me.user?.name ?? me.user?.email ?? 'Opper user';
    line('Live', `Signed in as ${who}${me.projectName ? ` · ${me.projectName}` : ''}`);
    text.append(el('p', 'The AI plays live; calls bill your Opper wallet.', 'hint'));
    const wallet = el('a', 'My wallet ↗', 'button');
    wallet.href = me.walletUrl;
    wallet.target = '_blank';
    wallet.rel = 'noopener';
    const out = el('button', 'Sign out');
    out.addEventListener('click', () => void signOut());
    actions.append(wallet, out);
  } else if (view.kind === 'dev') {
    line('Local key', me.devProvider === 'typesafe' ? 'Playing with your TypeSafe key from .env' : 'Playing with the local dev key from .env');
    text.append(el('p', me.devProvider === 'typesafe' ? 'Calls go straight to TypeSafe.' : 'Calls go through Opper with your key.', 'hint'));
    if (me.loginAvailable && !retry) actions.append(signInButton(me));
  } else if (view.kind === 'demo') {
    line('Recorded demo', 'Play free, or sign in to let the AI play live');
    text.append(runItYourself('Calls bill your own Opper wallet, or '));
    if (!retry) actions.append(signInButton(me));
  } else {
    line('Signed out', 'Sign in with Opper to keep the AI playing');
    text.append(runItYourself('Or '));
    if (!retry) actions.append(signInButton(me));
  }
  if (view.notice) {
    // No role="alert": the account area itself is an aria-live="polite" region.
    const notice = el('p', undefined, 'notice');
    if (view.noticeLink) {
      const link = el('a', `${view.notice} ↗`);
      link.href = view.noticeLink;
      link.target = '_blank';
      link.rel = 'noopener';
      notice.append(link);
    } else notice.textContent = view.notice;
    text.append(notice);
    if (retry) {
      const again = signInButton(me);
      again.textContent = 'Try again';
      actions.prepend(again);
    }
  }
  root.dataset.kind = view.kind;
  root.replaceChildren(text, ...(actions.childElementCount ? [actions] : []));
}
