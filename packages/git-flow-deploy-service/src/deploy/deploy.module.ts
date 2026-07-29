import { Module } from '@nestjs/common';
import { DeployController } from './deploy.controller.js';
import { DeployStore } from './deploy-store.js';
import { HmacGuard } from './hmac.guard.js';
import { ConfigService } from './config.service.js';
import { ReposConfigService } from './repos-config.service.js';
import { DeploymentStateService } from './deployment-state.service.js';
import { SelfRegistrationService } from './self-registration.service.js';

@Module({
  controllers: [DeployController],
  providers: [
    DeployStore,
    HmacGuard,
    ConfigService,
    ReposConfigService,
    DeploymentStateService,
    SelfRegistrationService,
  ],
})
export class DeployModule {}
