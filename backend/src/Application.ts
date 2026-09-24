/** Application container: Config + service/repository interfaces, wired in src/index.ts. */
import type { AppConfig } from './Config.ts';
import type { SaleService, PurchaseService } from './services/index.ts';
import type { Database } from './repositories/database/index.ts';
import type { Cache } from './repositories/cache/index.ts';
import type { Logger } from './repositories/logger/index.ts';

export interface Application {
  config: AppConfig;
  saleService: SaleService;
  purchaseService: PurchaseService;
  database: Database;
  cache: Cache;
  logger: Logger;
}
