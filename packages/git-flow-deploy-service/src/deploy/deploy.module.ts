import { Module } from '@nestjs/common';
import { DeployController } from './deploy.controller.js';
import { DeployStore } from './deploy-store.js';
import { HmacGuard } from './hmac.guard.js';
import { ConfigService } from './config.service.js';
import { ReposConfigService } from './repos-config.service.js';

@Module({
  controllers: [DeployController],
  providers: [DeployStore, HmacGuard, ConfigService, ReposConfigService],
})
export class DeployModule {}
