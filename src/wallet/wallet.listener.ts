import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '../redis/redis.service';
import { WALLET_CACHE_KEYS, MAX_ALERTS } from '../redis/keys';
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from './events/wallet-balance-changed.event';

@Injectable()
export class WalletListener {
  private readonly logger = new Logger(WalletListener.name);

  constructor(private readonly redis: RedisService) {}

  @OnEvent(WALLET_BALANCE_CHANGED)
  async handleBalanceChanged(event: WalletBalanceChangedEvent): Promise<void> {
    this.logger.warn(
      `Balance changed for ${event.address} on ${event.network}: ` +
        `${event.previousBalance} -> ${event.currentBalance} ${event.symbol}`,
    );

    await this.redis.lpush(WALLET_CACHE_KEYS.alerts, JSON.stringify(event));
    await this.redis.ltrim(WALLET_CACHE_KEYS.alerts, 0, MAX_ALERTS - 1);
  }
}
