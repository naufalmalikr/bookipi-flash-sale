import type { Logger } from '../index.js';

export class ConsoleLogger implements Logger {
  info(msg: string, ...args: unknown[]): void {
    console.info(msg, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    console.warn(msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    console.error(msg, ...args);
  }

  debug(msg: string, ...args: unknown[]): void {
    console.debug(msg, ...args);
  }
}
