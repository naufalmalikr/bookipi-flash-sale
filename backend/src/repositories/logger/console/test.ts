import { describe, it, expect } from 'vitest';
import { ConsoleLogger } from './index.ts';

describe('ConsoleLogger', () => {
  it('exposes info/warn/error/debug and runs without throw', () => {
    const log = new ConsoleLogger();
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(() => {
      log.info('i');
      log.warn('w');
      log.error('e');
      log.debug('d');
    }).not.toThrow();
  });
});
