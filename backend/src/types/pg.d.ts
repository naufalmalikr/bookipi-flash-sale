/**
 * Ambient types for `pg` (untyped dependency — no @types/pg installed).
 * Minimal surface used by the backend: Pool, PoolClient, query results.
 * Justification for the narrow hand-rolled declarations: keeps the
 * Dockerfile slim (no extra dev dep) while staying strict-safe.
 */
declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
    command: string;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    statement_timeout?: number | string;
    lock_timeout?: number | string;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  }

  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    release(): void;
  }

  export interface ClientConfig {
    connectionString?: string;
  }

  export class Client {
    constructor(config?: ClientConfig | string);
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  const pg: {
    Pool: typeof Pool;
    Client: typeof Client;
  };

  export default pg;
}
