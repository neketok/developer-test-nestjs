import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios from 'axios';
import { RedisService } from '../redis/redis.service';
import { WALLET_CACHE_KEYS, WALLET_CACHE_TTL } from '../redis/keys';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';
import { BlockchainException } from '../blockchain/exceptions/blockchain.exception';
import { WatchWalletDto } from './dto/watch-wallet.dto';
import {
  WalletBalance,
  Transaction,
  TransactionList,
  WatchedWalletWithBalance,
  BalanceAlert,
  TokenBalance,
  NftItem,
} from '../blockchain/types/blockchain.types';
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from './events/wallet-balance-changed.event';
import { formatBalance, hasBalanceChanged } from '../utils/decimal.utils';

const EXPLORER_TIMEOUT_MS = 10_000;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly network: string;

  constructor(
    private readonly redis: RedisService,
    private readonly evm: EvmProvider,
    private readonly sol: SolanaProvider,
    private readonly web3: Web3Provider,
    private readonly ton: TonProvider,
    private readonly moralis: MoralisProvider,
    private readonly metaplex: MetaplexProvider,
    private readonly configService: ConfigService,
    private readonly events: EventEmitter2,
  ) {
    this.network = this.configService.get<string>('NETWORK', 'ethereum');
  }

  private get symbol(): string {
    return this.evm.config?.symbol ?? 'ETH';
  }

  private get decimals(): number {
    return this.evm.config?.decimals ?? 18;
  }

  private normalizeAddress(address: string): string {
    return address.toLowerCase();
  }

  private ensureMoralis(): void {
    if (!this.moralis.isAvailable()) {
      throw new BlockchainException('Moralis API key is not configured', 'moralis');
    }
  }

  async getBalance(address: string): Promise<WalletBalance> {
    const addr = this.normalizeAddress(address);

    const { data, cached } = await this.redis.getOrSet<Omit<WalletBalance, 'cached'>>(
      WALLET_CACHE_KEYS.balance(addr),
      WALLET_CACHE_TTL.balance,
      async () => {
        this.logger.log(`Fetching on-chain balance for ${addr}`);

        try {
          const rawBalance = await this.evm.provider.getBalance(addr);
          return {
            address: addr,
            balance: formatBalance(rawBalance, this.decimals),
            symbol: this.symbol,
            network: this.network,
          };
        } catch (error) {
          throw BlockchainException.rpcError(this.network, error);
        }
      },
    );

    return { ...data, cached };
  }

  async getTransactions(address: string, limit = 10): Promise<TransactionList> {
    const addr = this.normalizeAddress(address);

    const { data, cached } = await this.redis.getOrSet<Omit<TransactionList, 'cached'>>(
      WALLET_CACHE_KEYS.transactions(addr, limit),
      WALLET_CACHE_TTL.transactions,
      async () => ({
        address: addr,
        transactions: await this.fetchExplorerTransactions(addr, limit),
        network: this.network,
      }),
    );

    return { ...data, cached };
  }

  private async fetchExplorerTransactions(
    address: string,
    limit: number,
  ): Promise<Transaction[]> {
    const apiKey = this.evm.explorerApiKey;

    if (!apiKey) {
      this.logger.warn(`Explorer API key not set for ${this.network}`);
      return [];
    }

    try {
      const { data } = await axios.get(this.evm.config.explorerApiUrl, {
        timeout: EXPLORER_TIMEOUT_MS,
        params: {
          module: 'account',
          action: 'txlist',
          address,
          sort: 'desc',
          page: 1,
          offset: limit,
          apikey: apiKey,
        },
      });

      if (data.status !== '1' || !Array.isArray(data.result)) {
        this.logger.warn(`Explorer API: status=${data.status}, message=${data.message}`);
        return [];
      }

      return data.result.map(
        (tx: Record<string, string>): Transaction => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: formatBalance(BigInt(tx.value), this.decimals),
          timestamp: Number(tx.timeStamp),
          status: tx.isError === '0' ? 'success' : 'failed',
        }),
      );
    } catch (error) {
      throw BlockchainException.explorerError(this.network, error);
    }
  }

  async watchWallet(dto: WatchWalletDto): Promise<{ success: boolean; address: string }> {
    const addr = this.normalizeAddress(dto.address);
    const exists = await this.redis.hexists(WALLET_CACHE_KEYS.watchlist, addr);

    if (exists) {
      this.logger.log(`Wallet ${addr} already in watchlist — updating`);
    }

    await this.redis.hset(
      WALLET_CACHE_KEYS.watchlist,
      addr,
      JSON.stringify({ address: addr, label: dto.label ?? null, addedAt: Date.now() }),
    );

    return { success: true, address: addr };
  }

  async getWatchedWallets(): Promise<WatchedWalletWithBalance[]> {
    const all = await this.redis.hgetall(WALLET_CACHE_KEYS.watchlist);
    const entries = Object.values(all).map(
      (v) => JSON.parse(v) as { address: string; label?: string; addedAt: number },
    );

    if (entries.length === 0) return [];

    const settled = await Promise.allSettled(
      entries.map(async (entry) => {
        const { balance, symbol } = await this.getBalance(entry.address);
        await this.detectAndEmitBalanceChange(entry.address, balance, symbol);
        return { ...entry, balance, symbol };
      }),
    );

    return settled.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;

      this.logger.error(`Failed to fetch balance for ${entries[i].address}`, result.reason);
      return {
        address: entries[i].address,
        label: entries[i].label,
        addedAt: entries[i].addedAt,
        balance: '0',
        symbol: this.symbol,
      };
    });
  }

  private async detectAndEmitBalanceChange(
    address: string,
    currentBalance: string,
    symbol: string,
  ): Promise<void> {
    const previousBalance = await this.redis.get(WALLET_CACHE_KEYS.lastBalance(address));
    await this.redis.set(WALLET_CACHE_KEYS.lastBalance(address), currentBalance);

    if (previousBalance !== null && hasBalanceChanged(previousBalance, currentBalance)) {
      const event: WalletBalanceChangedEvent = {
        address,
        network: this.network,
        symbol,
        previousBalance,
        currentBalance,
        detectedAt: Date.now(),
      };

      this.events.emit(WALLET_BALANCE_CHANGED, event);
      this.logger.warn(
        `Balance changed for ${address}: ${previousBalance} -> ${currentBalance} ${symbol}`,
      );
    }
  }

  async getAlerts(): Promise<BalanceAlert[]> {
    const raw = await this.redis.lrange(WALLET_CACHE_KEYS.alerts, 0, -1);
    return raw.map((item) => JSON.parse(item) as BalanceAlert);
  }

  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    this.ensureMoralis();
    const addr = this.normalizeAddress(address);

    const { data } = await this.redis.getOrSet<TokenBalance[]>(
      WALLET_CACHE_KEYS.tokens(addr),
      WALLET_CACHE_TTL.tokens,
      async () => {
        this.logger.log(`Fetching ERC-20 tokens for ${addr}`);

        try {
          const response = await this.moralis.sdk.EvmApi.token.getWalletTokenBalances({
            address: addr,
            chain: this.moralis.evmChainId,
          });

          return response.result.map((item): TokenBalance => {
            const decimals = item.token?.decimals ?? 18;
            return {
              contractAddress: item.token?.contractAddress?.lowercase ?? '',
              name: item.token?.name ?? 'Unknown',
              symbol: item.token?.symbol ?? '',
              decimals,
              balance: formatBalance(BigInt(item.value ?? '0'), decimals),
              network: this.network,
            };
          });
        } catch (error) {
          throw BlockchainException.rpcError('moralis', error);
        }
      },
    );

    return data;
  }

  async getNfts(address: string): Promise<NftItem[]> {
    this.ensureMoralis();
    const addr = this.normalizeAddress(address);

    const { data } = await this.redis.getOrSet<NftItem[]>(
      WALLET_CACHE_KEYS.nfts(addr),
      WALLET_CACHE_TTL.nfts,
      async () => {
        this.logger.log(`Fetching NFTs for ${addr}`);

        try {
          const response = await this.moralis.sdk.EvmApi.nft.getWalletNFTs({
            address: addr,
            chain: this.moralis.evmChainId,
          });

          return response.result.map(
            (item): NftItem => ({
              contractAddress: item.tokenAddress?.lowercase ?? '',
              tokenId: String(item.tokenId ?? ''),
              name: item.name ?? 'Unnamed',
              symbol: item.symbol ?? '',
              network: this.network,
            }),
          );
        } catch (error) {
          throw BlockchainException.rpcError('moralis', error);
        }
      },
    );

    return data;
  }
}
