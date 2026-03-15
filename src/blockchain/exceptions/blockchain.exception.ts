import { HttpException, HttpStatus } from '@nestjs/common';

export class BlockchainException extends HttpException {
  constructor(
    message: string,
    public readonly provider: string,
    status: HttpStatus = HttpStatus.BAD_GATEWAY,
    public readonly originalCause?: unknown,
  ) {
    super({ statusCode: status, error: 'BlockchainError', message, provider }, status);
  }

  static rpcError(provider: string, cause: unknown): BlockchainException {
    const msg = cause instanceof Error ? cause.message : 'Unknown RPC error';
    return new BlockchainException(`RPC call failed: ${msg}`, provider, HttpStatus.BAD_GATEWAY, cause);
  }

  static explorerError(provider: string, cause: unknown): BlockchainException {
    const msg = cause instanceof Error ? cause.message : 'Explorer API unavailable';
    return new BlockchainException(`Explorer API error: ${msg}`, provider, HttpStatus.BAD_GATEWAY, cause);
  }

  static unsupportedNetwork(network: string): BlockchainException {
    return new BlockchainException(
      `Network "${network}" is not supported by this endpoint`,
      network,
      HttpStatus.BAD_REQUEST,
    );
  }
}
