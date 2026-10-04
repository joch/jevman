export interface Me {
  mode: 'player' | 'dev' | 'none';
  user?: { name?: string; email?: string };
  projectName?: string;
  walletUrl: string;
  loginAvailable: boolean;
}

export type AccountView = { kind: 'player' | 'dev' | 'demo' | 'signed-out'; me: Me };

const FALLBACK: Me = { mode: 'none', walletUrl: 'https://platform.opper.ai/wallet', loginAvailable: false };

export async function fetchMe(): Promise<Me> {
  try {
    const res = await fetch('/api/me');
    if (res.ok) return (await res.json()) as Me;
  } catch {
    // offline or no server: behave as signed out
  }
  return FALLBACK;
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
