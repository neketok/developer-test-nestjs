import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios from 'axios';
import { WalletService } from './wallet.service';
import { RedisService } from '../redis/redis.service';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';
import { BlockchainException } from '../blockchain/exceptions/blockchain.exception';
import { WALLET_BALANCE_CHANGED } from './events/wallet-balance-changed.event';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ADDR_LOWER = ADDR.toLowerCase();

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, val: string) => {
      store.set(key, val);
      return Promise.resolve();
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    hset: jest.fn(),
    hget: jest.fn(),
    hgetall: jest.fn().mockResolvedValue({}),
    hexists: jest.fn().mockResolvedValue(false),
    hdel: jest.fn(),
    lrange: jest.fn().mockResolvedValue([]),
    lpush: jest.fn(),
    ltrim: jest.fn(),
    getOrSet: jest.fn(
      async <T>(key: string, _ttl: number, fn: () => Promise<T>) => {
        const raw = store.get(key);
        if (raw !== undefined) return { data: JSON.parse(raw) as T, cached: true };
        const data = await fn();
        store.set(key, JSON.stringify(data));
        return { data, cached: false };
      },
    ),
    _store: store,
  };
}

const mockEvmProvider = {
  provider: { getBalance: jest.fn() },
  config: {
    symbol: 'ETH',
    decimals: 18,
    explorerApiUrl: 'https://api.etherscan.io/api',
    explorerApiKeyEnv: 'ETHERSCAN_API_KEY',
  },
  explorerApiKey: 'test-key',
  network: 'ethereum',
  isEvmNetwork: jest.fn().mockReturnValue(true),
};

const mockEvents = { emit: jest.fn() };

function buildModule(redis: ReturnType<typeof createMockRedis>) {
  return Test.createTestingModule({
    providers: [
      WalletService,
      { provide: RedisService, useValue: redis },
      { provide: EvmProvider, useValue: mockEvmProvider },
      { provide: SolanaProvider, useValue: {} },
      { provide: Web3Provider, useValue: {} },
      { provide: TonProvider, useValue: {} },
      { provide: MoralisProvider, useValue: { isAvailable: () => false } },
      { provide: MetaplexProvider, useValue: {} },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, fallback?: string) =>
            key === 'NETWORK' ? 'ethereum' : fallback,
        },
      },
      { provide: EventEmitter2, useValue: mockEvents },
    ],
  }).compile();
}

describe('WalletService', () => {
  let service: WalletService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    jest.clearAllMocks();
    redis = createMockRedis();
    const module: TestingModule = await buildModule(redis);
    service = module.get<WalletService>(WalletService);
  });

  describe('getBalance', () => {
    it('fetches from chain on cache miss and returns cached: false', async () => {
      mockEvmProvider.provider.getBalance.mockResolvedValueOnce(
        BigInt('1523456000000000000'),
      );

      const result = await service.getBalance(ADDR);

      expect(result).toEqual({
        address: ADDR_LOWER,
        balance: '1.523456',
        symbol: 'ETH',
        network: 'ethereum',
        cached: false,
      });
      expect(mockEvmProvider.provider.getBalance).toHaveBeenCalledWith(ADDR_LOWER);
    });

    it('returns cached data without calling the provider', async () => {
      const cached = {
        address: ADDR_LOWER,
        balance: '2.000000',
        symbol: 'ETH',
        network: 'ethereum',
      };
      redis._store.set(`balance:${ADDR_LOWER}`, JSON.stringify(cached));

      const result = await service.getBalance(ADDR);

      expect(result).toEqual({ ...cached, cached: true });
      expect(mockEvmProvider.provider.getBalance).not.toHaveBeenCalled();
    });

    it('normalizes address to lowercase for cache consistency', async () => {
      mockEvmProvider.provider.getBalance.mockResolvedValueOnce(BigInt('0'));

      await service.getBalance('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');

      expect(mockEvmProvider.provider.getBalance).toHaveBeenCalledWith(
        '0xabcdef1234567890abcdef1234567890abcdef12',
      );
    });

    it('wraps RPC errors in BlockchainException', async () => {
      mockEvmProvider.provider.getBalance.mockRejectedValueOnce(
        new Error('RPC timeout'),
      );

      await expect(service.getBalance(ADDR)).rejects.toThrow(BlockchainException);
    });
  });

  describe('getTransactions', () => {
    const explorerResponse = {
      data: {
        status: '1',
        message: 'OK',
        result: [
          {
            hash: '0xabc',
            from: '0x111',
            to: '0x222',
            value: '100000000000000000',
            timeStamp: '1700000000',
            isError: '0',
          },
        ],
      },
    };

    it('fetches from explorer API and maps to Transaction[]', async () => {
      mockedAxios.get.mockResolvedValueOnce(explorerResponse);

      const result = await service.getTransactions(ADDR, 5);

      expect(result.cached).toBe(false);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toEqual({
        hash: '0xabc',
        from: '0x111',
        to: '0x222',
        value: '0.100000',
        timestamp: 1700000000,
        status: 'success',
      });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.etherscan.io/api',
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it('returns empty list when explorer API key is missing', async () => {
      const saved = mockEvmProvider.explorerApiKey;
      mockEvmProvider.explorerApiKey = '';

      const result = await service.getTransactions(ADDR, 5);

      expect(result.transactions).toEqual([]);
      mockEvmProvider.explorerApiKey = saved;
    });

    it('wraps axios errors in BlockchainException', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      await expect(service.getTransactions(ADDR, 5)).rejects.toThrow(
        BlockchainException,
      );
    });

    it('returns empty list when explorer responds with error status', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' },
      });

      const result = await service.getTransactions(ADDR, 5);
      expect(result.transactions).toEqual([]);
    });
  });

  describe('watchWallet', () => {
    it('stores wallet in Redis hash and returns success', async () => {
      const result = await service.watchWallet({
        address: ADDR,
        label: 'Vitalik',
      });

      expect(result).toEqual({ success: true, address: ADDR_LOWER });
      expect(redis.hset).toHaveBeenCalledWith(
        'watchlist',
        ADDR_LOWER,
        expect.stringContaining('"label":"Vitalik"'),
      );
    });

    it('normalizes address before storing', async () => {
      await service.watchWallet({ address: ADDR });

      expect(redis.hset).toHaveBeenCalledWith(
        'watchlist',
        ADDR_LOWER,
        expect.any(String),
      );
    });
  });

  describe('getWatchedWallets', () => {
    it('returns empty array when watchlist is empty', async () => {
      const result = await service.getWatchedWallets();
      expect(result).toEqual([]);
    });

    it('fetches balances in parallel and returns enriched list', async () => {
      redis.hgetall.mockResolvedValueOnce({
        [ADDR_LOWER]: JSON.stringify({
          address: ADDR_LOWER,
          label: 'Vitalik',
          addedAt: 1700000000000,
        }),
      });
      mockEvmProvider.provider.getBalance.mockResolvedValueOnce(
        BigInt('2000000000000000000'),
      );

      const result = await service.getWatchedWallets();

      expect(result).toHaveLength(1);
      expect(result[0].balance).toBe('2.000000');
      expect(result[0].label).toBe('Vitalik');
    });

    it('emits WALLET_BALANCE_CHANGED when balance changes', async () => {
      redis.hgetall.mockResolvedValueOnce({
        [ADDR_LOWER]: JSON.stringify({
          address: ADDR_LOWER,
          label: 'Test',
          addedAt: 1700000000000,
        }),
      });
      redis.get.mockImplementation(async (key: string) => {
        if (key === `last_balance:${ADDR_LOWER}`) return '1.000000';
        return redis._store.get(key) ?? null;
      });
      mockEvmProvider.provider.getBalance.mockResolvedValueOnce(
        BigInt('2000000000000000000'),
      );

      await service.getWatchedWallets();

      expect(mockEvents.emit).toHaveBeenCalledWith(
        WALLET_BALANCE_CHANGED,
        expect.objectContaining({
          address: ADDR_LOWER,
          previousBalance: '1.000000',
          currentBalance: '2.000000',
        }),
      );
    });

    it('gracefully handles failed balance fetches', async () => {
      redis.hgetall.mockResolvedValueOnce({
        [ADDR_LOWER]: JSON.stringify({
          address: ADDR_LOWER,
          label: 'Broken',
          addedAt: 1700000000000,
        }),
      });
      mockEvmProvider.provider.getBalance.mockRejectedValueOnce(
        new Error('RPC down'),
      );

      const result = await service.getWatchedWallets();

      expect(result).toHaveLength(1);
      expect(result[0].balance).toBe('0');
    });
  });

  describe('getAlerts', () => {
    it('returns parsed alerts from Redis list', async () => {
      const alert = {
        address: ADDR_LOWER,
        network: 'ethereum',
        symbol: 'ETH',
        previousBalance: '1.000000',
        currentBalance: '2.000000',
        detectedAt: 1700000000000,
      };
      redis.lrange.mockResolvedValueOnce([JSON.stringify(alert)]);

      const result = await service.getAlerts();
      expect(result).toEqual([alert]);
    });

    it('returns empty array when no alerts exist', async () => {
      const result = await service.getAlerts();
      expect(result).toEqual([]);
    });
  });
});
