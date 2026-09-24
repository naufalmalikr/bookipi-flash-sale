/** Application container: Config + service/repository interfaces, wired in src/index.ts. */
import type { AppConfig } from './Config.js';
import type { SaleService, PurchaseService } from './services/index.js';
import type { Database } from './repositories/database/index.js';
import type { Cache } from './repositories/cache/index.js';
import type { Logger } from './repositories/logger/index.js';

export interface Application {
  config: AppConfig;
  saleService: SaleService;
  purchaseService: PurchaseService;
  database: Database;
  cache: Cache;
  logger: Logger;
}
