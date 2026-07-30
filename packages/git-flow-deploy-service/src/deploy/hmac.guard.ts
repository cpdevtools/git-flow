import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { validateHmac, validateTimestamp } from '@cpdevtools/git-flow-deploy';
import { ConfigService } from './config.service.js';

/**
 * Guards POST /deploy.
 * Validates X-Deploy-Signature-256 and X-Deploy-Timestamp.
 * Requires rawBody to be available (NestFactory.create must be called with { rawBody: true }).
 */
@Injectable()
export class HmacGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const signature = req.headers['x-deploy-signature-256'];
    const ts = req.headers['x-deploy-timestamp'];

    if (typeof signature !== 'string' || typeof ts !== 'string') {
      throw new UnauthorizedException(
        'Missing X-Deploy-Signature-256 or X-Deploy-Timestamp',
      );
    }

    if (!validateTimestamp(ts)) {
      throw new UnauthorizedException('Timestamp outside 60s window');
    }

    const rawBody = req.rawBody?.toString('utf-8') ?? '';
    const secret = this.config.hmacSecret;

    if (!validateHmac(secret, signature, ts, rawBody)) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    return true;
  }
}
