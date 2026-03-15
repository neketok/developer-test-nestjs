import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
    });

    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err) => this.logger.error('Redis error', err));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.client.hdel(key, field);
  }

  async hexists(key: string, field: string): Promise<boolean> {
    return (await this.client.hexists(key, field)) === 1;
  }

  async lpush(key: string, ...values: string[]): Promise<void> {
    await this.client.lpush(key, ...values);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async getOrSet<T>(
    key: string,
    ttl: number,
    fetchFn: () => Promise<T>,
  ): Promise<{ data: T; cached: boolean }> {
    const raw = await this.get(key);

    if (raw !== null) {
      return { data: JSON.parse(raw) as T, cached: true };
    }

    const data = await fetchFn();
    await this.set(key, JSON.stringify(data), ttl);
    return { data, cached: false };
  }
}
