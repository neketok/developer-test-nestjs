import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EvmGuard } from './evm.guard';
import { EvmProvider } from '../providers/evm.provider';
import { BlockchainException } from '../exceptions/blockchain.exception';

const mockContext = {} as ExecutionContext;

describe('EvmGuard', () => {
  let guard: EvmGuard;
  let evmProvider: { isEvmNetwork: jest.Mock };

  beforeEach(async () => {
    evmProvider = { isEvmNetwork: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvmGuard,
        { provide: EvmProvider, useValue: evmProvider },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) =>
              key === 'NETWORK' ? 'solana' : fallback,
          },
        },
      ],
    }).compile();

    guard = module.get<EvmGuard>(EvmGuard);
  });

  it('allows request when network is EVM', () => {
    evmProvider.isEvmNetwork.mockReturnValue(true);
    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('throws BlockchainException when network is not EVM', () => {
    evmProvider.isEvmNetwork.mockReturnValue(false);
    expect(() => guard.canActivate(mockContext)).toThrow(BlockchainException);
  });

  it('includes network name in the error message', () => {
    evmProvider.isEvmNetwork.mockReturnValue(false);

    try {
      guard.canActivate(mockContext);
      fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BlockchainException);
      const response = (error as BlockchainException).getResponse() as Record<string, string>;
      expect(response.message).toContain('solana');
    }
  });
});
