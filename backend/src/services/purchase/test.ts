import { describe, it, expect } from 'vitest';
import { canonicalizeUserId } from './index.ts';
import { userIdSchema } from '../../models/requests/purchase.request.ts';

describe('canonicalizeUserId', () => {
  it('4-way Gmail equivalence: dots/+tag/googlemail/case collapse to one id', () => {
    const variants = [
      'foobar@gmail.com',
      'foo.bar@gmail.com',
      'foobar+baz@gmail.com',
      'FooBar@GoogleMail.COM',
    ];
    const canonical = variants.map((v) => canonicalizeUserId(v));
    for (const c of canonical) {
      expect(c).toBe('foobar@gmail.com');
    }
  });

  it('maps googlemail.com to gmail.com', () => {
    expect(canonicalizeUserId('Foo.Bar@googlemail.com')).toBe('foobar@gmail.com');
  });

  it('strips plus-tag and dots together', () => {
    expect(canonicalizeUserId('f.o.o+baz123@gmail.com')).toBe('foo@gmail.com');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(canonicalizeUserId('  FooBar@GMAIL.com  ')).toBe('foobar@gmail.com');
  });

  it('non-Gmail keeps dots distinct (only trim+lowercase)', () => {
    expect(canonicalizeUserId('user@outlook.com')).toBe('user@outlook.com');
    expect(canonicalizeUserId('u.s.e.r@outlook.com')).toBe('u.s.e.r@outlook.com');
    expect(canonicalizeUserId('u.s.e.r@outlook.com')).not.toBe(
      canonicalizeUserId('user@outlook.com'),
    );
  });

  it('non-Gmail lowercases but preserves plus-tag and dots', () => {
    expect(canonicalizeUserId('User+Tag@Outlook.COM')).toBe('user+tag@outlook.com');
  });

  it('empty/whitespace/non-email inputs throw invalid-userId', () => {
    const bad = ['', '   ', 'not-an-email', 'no-at-sign.com', '@gmail.com', 'foo@', 'a b@gmail.com', 'foo@@gmail.com'];
    for (const input of bad) {
      expect(() => canonicalizeUserId(input)).toThrowError('invalid-userId');
    }
  });

  it('NFKC-normalizes fullwidth spoof separators before validation (m4)', () => {
    expect(canonicalizeUserId('foo＠gmail.com')).toBe('foo@gmail.com');
    expect(canonicalizeUserId('foo．bar@gmail.com')).toBe('foobar@gmail.com');
  });

  it('rejects zero-width chars and overlong input (m4)', () => {
    expect(() => canonicalizeUserId('fo​o@gmail.com')).toThrowError('invalid-userId');
    expect(() => canonicalizeUserId(`${'a'.repeat(250)}@example.com`)).toThrowError('invalid-userId');
    expect(() => canonicalizeUserId('x'.repeat(300))).toThrowError('invalid-userId');
  });

  it('pins Zod/canonicalize divergence set (Zod 400 first, canonicalize second)', () => {
    const longLocal = `${'a'.repeat(300)}@example.com`;
    expect(userIdSchema.safeParse(longLocal).success).toBe(true);
    expect(() => canonicalizeUserId(longLocal)).toThrowError('invalid-userId');
    for (const addr of ['f@example.c', 'foo@exam_ple.com', 'user%tag@example.com']) {
      expect(userIdSchema.safeParse(addr).success).toBe(false);
      expect(() => canonicalizeUserId(addr)).not.toThrow();
    }
  });

  it('Zod userIdSchema trims padding, rejects empty/whitespace/non-email (purchase-path 400 source)', () => {
    for (const input of ['', '   ', 'not-an-email']) {
      expect(userIdSchema.safeParse(input).success).toBe(false);
    }
    expect(userIdSchema.safeParse('foobar@gmail.com').success).toBe(true);
    const padded = userIdSchema.safeParse('  FooBar@GMAIL.com  ');
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data).toBe('FooBar@GMAIL.com'.trim());
  });
});
