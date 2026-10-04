export interface Me {
  mode: 'player' | 'dev' | 'none';
  user?: { name?: string; email?: string };
  projectName?: string;
  walletUrl: string;
  loginAvailable: boolean;
  /** True when /api/me could not be read, so the server's real state is unknown. */
  unavailable?: boolean;
}

export type AccountView = { kind: 'player' | 'dev' | 'demo' | 'signed-out'; me: Me; notice?: string };

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

export function renderAccount(root: HTMLElement, view: AccountView): void {
  const { me } = view;
  const parts: HTMLElement[] = [];
  if (view.notice) {
    const notice = el('span', view.notice, 'notice');
    notice.setAttribute('role', 'alert');
    parts.push(notice);
    if (view.kind !== 'player') {
      const retry = signInButton(me);
      retry.textContent = 'Try again';
      parts.push(retry);
    }
  }
  if (view.kind === 'player') {
    const who = me.user?.name ?? me.user?.email ?? 'Opper user';
    parts.push(el('span', `Signed in as ${who}${me.projectName ? ` · ${me.projectName}` : ''}`));
    const wallet = el('a', 'My Opper wallet ↗');
    wallet.href = me.walletUrl;
    wallet.target = '_blank';
    wallet.rel = 'noopener';
    parts.push(wallet);
    const out = el('button', 'Sign out');
    out.addEventListener('click', () => void signOut());
    parts.push(out);
  } else if (view.kind === 'dev') {
    parts.push(el('span', 'Playing with the local dev key from .env'));
    if (me.loginAvailable) parts.push(signInButton(me));
  } else if (view.kind === 'demo') {
    parts.push(el('span', 'Recorded demo — sign in with Opper to let jev play live (calls bill your own Opper wallet)'));
    parts.push(signInButton(me));
  } else {
    parts.push(el('span', 'Signed out — sign in with Opper to keep jev playing'));
    parts.push(signInButton(me));
  }
  root.dataset.kind = view.kind;
  root.replaceChildren(...parts);
}
