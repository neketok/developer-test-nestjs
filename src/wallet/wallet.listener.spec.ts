import { Test, TestingModule } from '@nestjs/testing';
import { WalletListener } from './wallet.listener';
import { RedisService } from '../redis/redis.service';
import { WalletBalanceChangedEvent } from './events/wallet-balance-changed.event';

const mockRedis = {
  lpush: jest.fn(),
  ltrim: jest.fn(),
};

describe('WalletListener', () => {
  let listener: WalletListener;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletListener,
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    listener = module.get<WalletListener>(WalletListener);
  });

  it('persists the event as a JSON alert in Redis', async () => {
    const event: WalletBalanceChangedEvent = {
      address: '0xabc',
      network: 'ethereum',
      symbol: 'ETH',
      previousBalance: '1.000000',
      currentBalance: '2.000000',
      detectedAt: 1700000000000,
    };

    await listener.handleBalanceChanged(event);

    expect(mockRedis.lpush).toHaveBeenCalledWith('wallet:alerts', JSON.stringify(event));
  });

  it('trims the alerts list to 50 entries', async () => {
    const event: WalletBalanceChangedEvent = {
      address: '0xabc',
      network: 'ethereum',
      symbol: 'ETH',
      previousBalance: '0',
      currentBalance: '1',
      detectedAt: Date.now(),
    };

    await listener.handleBalanceChanged(event);

    expect(mockRedis.ltrim).toHaveBeenCalledWith('wallet:alerts', 0, 49);
  });
});
