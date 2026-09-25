import { describe, it, expect } from 'vitest';
import { purchaseBodySchema } from './purchase.request.ts';

describe('purchaseBodySchema valid vectors', () => {
  it('accepts a plain valid email', () => {
    expect(purchaseBodySchema.safeParse({ userId: 'buyer@example.com' }).success).toBe(true);
  });

  it('accepts Gmail variants (dots/+tag/googlemail/case) — canonicalization is downstream', () => {
    const variants = [
      'foobar@gmail.com',
      'foo.bar+baz@gmail.com',
      'FooBar@GoogleMail.COM',
      'USER+TAG@OUTLOOK.COM',
    ];
    for (const userId of variants) {
      expect(purchaseBodySchema.safeParse({ userId }).success).toBe(true);
    }
  });

  it('accepts a well-formed 300-char local part (no Zod length cap; columns are TEXT)', () => {
    const userId = `${'a'.repeat(300)}@example.com`;
    expect(purchaseBodySchema.safeParse({ userId }).success).toBe(true);
  });

  it('strips unknown extra keys but still validates', () => {
    const parsed = purchaseBodySchema.safeParse({ userId: 'a@b.com', junk: 1 });
    expect(parsed.success).toBe(true);
  });
});

describe('purchaseBodySchema invalid vectors', () => {
  it('rejects malformed emails (no @, double @, empty local/domain)', () => {
    const bad = ['not-an-email', '12345', 'foo@@gmail.com', '@gmail.com', 'foo@'];
    for (const userId of bad) {
      expect(purchaseBodySchema.safeParse({ userId }).success).toBe(false);
    }
  });

  it('rejects empty and whitespace-only userId', () => {
    for (const userId of ['', '   ', '\t\n ']) {
      expect(purchaseBodySchema.safeParse({ userId }).success).toBe(false);
    }
  });

  it('trims padded email (trim-then-validate at schema layer)', () => {
    const parsed = purchaseBodySchema.safeParse({ userId: '  a@b.com  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.userId).toBe('a@b.com');
  });

  it('rejects whitespace inside the address', () => {
    expect(purchaseBodySchema.safeParse({ userId: 'a b@gmail.com' }).success).toBe(false);
  });

  it('rejects bad domains (no dot TLD, leading/trailing/consecutive dots)', () => {
    const bad = ['foo@bar', '.foo@gmail.com', 'foo.@gmail.com', 'a..b@gmail.com', 'foo@bar.'];
    for (const userId of bad) {
      expect(purchaseBodySchema.safeParse({ userId }).success).toBe(false);
    }
  });

  it('rejects overlong input without email shape', () => {
    expect(purchaseBodySchema.safeParse({ userId: 'x'.repeat(500) }).success).toBe(false);
  });

  it('pins strict-TLD / underscore / percent divergence vs canonicalizeUserId', () => {
    for (const userId of ['f@example.c', 'foo@exam_ple.com', 'user%tag@example.com']) {
      expect(purchaseBodySchema.safeParse({ userId }).success).toBe(false);
    }
  });

  it('rejects missing userId and wrong key', () => {
    expect(purchaseBodySchema.safeParse({}).success).toBe(false);
    expect(purchaseBodySchema.safeParse({ user: 'a@b.com' }).success).toBe(false);
  });

  it('rejects non-string userId (number, null, array, object)', () => {
    const bad: unknown[] = [123, null, ['a@b.com'], { userId: 'a@b.com' }];
    for (const userId of bad) {
      expect(purchaseBodySchema.safeParse({ userId }).success).toBe(false);
    }
  });

  it('rejects null/array top-level bodies', () => {
    expect(purchaseBodySchema.safeParse(null).success).toBe(false);
    expect(purchaseBodySchema.safeParse([]).success).toBe(false);
    expect(purchaseBodySchema.safeParse('a@b.com').success).toBe(false);
  });
});
