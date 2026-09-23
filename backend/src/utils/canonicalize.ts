/**
 * Todo 5: Backend-authoritative Gmail canonicalization.
 *
 * Rules (STRATEGY.md:148-156):
 * - trim() + toLowerCase() always.
 * - Gmail-only (gmail.com | googlemail.com, case-insensitive -> gmail.com):
 *   strip dots in local part, strip +tag.
 * - Non-Gmail: only trim + lowercase.
 *
 * Throw Error('invalid-userId') on bad input (empty, no @, spaces inside,
 * etc.). HTTP mapping to 400 happens via Zod/catch in routes (see
 * backend/src/index.ts purchaseBody z.object({ userId: z.email() }) which
 * the error handler maps to 400 invalid-userId); this util throws so
 * service/route layers can catch and map identically.
 */
import { z } from 'zod';

/** Zod email schema feeding the purchase path (mirrors index.ts purchaseBody). */
export const userIdSchema = z.email();

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function canonicalizeUserId(raw: string): string {
  if (typeof raw !== 'string') {
    throw new Error('invalid-userId');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('invalid-userId');
  }
  const lowered = trimmed.toLowerCase();
  // Reject any whitespace inside (spaces, tabs, etc.).
  if (/\s/.test(lowered)) {
    throw new Error('invalid-userId');
  }
  const parts = lowered.split('@');
  if (parts.length !== 2) {
    throw new Error('invalid-userId');
  }
  const local = parts[0] as string;
  const domain = parts[1] as string;
  if (local === '' || domain === '') {
    throw new Error('invalid-userId');
  }
  // Minimal non-email guard: domain must contain a dot, local/domain must not
  // start or end with a dot, no consecutive dots.
  if (
    !domain.includes('.') ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    local.includes('..') ||
    domain.includes('..')
  ) {
    throw new Error('invalid-userId');
  }

  if (GMAIL_DOMAINS.has(domain)) {
    const withoutTag = local.split('+')[0] as string;
    const stripped = withoutTag.replace(/\./g, '');
    if (stripped === '') {
      throw new Error('invalid-userId');
    }
    return `${stripped}@gmail.com`;
  }

  return `${local}@${domain}`;
}
