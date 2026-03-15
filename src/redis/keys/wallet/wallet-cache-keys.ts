export const WALLET_CACHE_KEYS = {
  balance: (addr: string) => `balance:${addr}`,
  transactions: (addr: string, limit: number) => `txs:${addr}:${limit}`,
  tokens: (addr: string) => `tokens:${addr}`,
  nfts: (addr: string) => `nfts:${addr}`,
  lastBalance: (addr: string) => `last_balance:${addr}`,
  watchlist: 'watchlist',
  alerts: 'wallet:alerts',
} as const;
