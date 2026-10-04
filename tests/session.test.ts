import { describe, expect, it } from 'vitest';
import { openSession, parseCookies, safeEqual, sealSession, serializeCookie, SESSION_MAX_AGE_S, type SessionData } from '../server/session';

const SECRET = 'a'.repeat(64);
const data = (over: Partial<SessionData> = {}): SessionData => ({ v: 1, apiKey: 'op-test-key', user: { name: 'Ada', email: 'ada@example.com' }, issuedAt: 1_000, ...over });

describe('session cookie', () => {
  it('round-trips sealed data and hides the key', () => {
    const sealed = sealSession(data(), SECRET);
    expect(sealed).not.toContain('op-test-key');
    expect(openSession(sealed, SECRET, 2_000)).toEqual(data());
  });
  it('produces a different ciphertext each time', () => {
    expect(sealSession(data(), SECRET)).not.toBe(sealSession(data(), SECRET));
  });
  it('rejects tampering, the wrong secret, malformed input and missing values', () => {
    const sealed = sealSession(data(), SECRET);
    const [iv, ct, tag] = sealed.split('.');
    const flipped = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + ct.slice(-1);
    expect(openSession(`${iv}.${flipped}.${tag}`, SECRET, 2_000)).toBeNull();
    const tagBytes = Buffer.from(tag, 'base64url');
    tagBytes[0] ^= 0xff;
    expect(openSession(`${iv}.${ct}.${tagBytes.toString('base64url')}`, SECRET, 2_000)).toBeNull();
    expect(openSession(sealed, 'b'.repeat(64), 2_000)).toBeNull();
    expect(openSession('garbage', SECRET)).toBeNull();
    expect(openSession('a.b.c', SECRET)).toBeNull();
    expect(openSession(undefined, SECRET)).toBeNull();
    expect(openSession(sealSession(data({ apiKey: '' }), SECRET), SECRET, 2_000)).toBeNull();
  });
  it('expires at expiresAt and after the 30-day cap', () => {
    const exp = sealSession(data({ expiresAt: new Date(5_000).toISOString() }), SECRET);
    expect(openSession(exp, SECRET, 4_999)).not.toBeNull();
    expect(openSession(exp, SECRET, 5_000)).toBeNull();
    const old = sealSession(data({ issuedAt: 0 }), SECRET);
    expect(openSession(old, SECRET, SESSION_MAX_AGE_S * 1000 + 1)).toBeNull();
  });
  it('compares strings in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
  it('parses and serializes cookies', () => {
    expect(parseCookies('a=1; jevman_session=x%3Dy; bad')).toEqual({ a: '1', jevman_session: 'x=y' });
    expect(parseCookies(undefined)).toEqual({});
    expect(serializeCookie('s', 'v=1', { maxAge: 60.7, path: '/', httpOnly: true, secure: true })).toBe('s=v%3D1; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(serializeCookie('s', '', { maxAge: 0, path: '/auth' })).toBe('s=; Max-Age=0; Path=/auth; SameSite=Lax');
  });
});
