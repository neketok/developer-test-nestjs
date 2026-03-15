import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EvmProvider } from '../providers/evm.provider';
import { BlockchainException } from '../exceptions/blockchain.exception';

@Injectable()
export class EvmGuard implements CanActivate {
  constructor(
    private readonly evm: EvmProvider,
    private readonly config: ConfigService,
  ) {}

  canActivate(_context: ExecutionContext): boolean {
    if (!this.evm.isEvmNetwork()) {
      throw BlockchainException.unsupportedNetwork(
        this.config.get<string>('NETWORK', 'ethereum'),
      );
    }
    return true;
  }
}
