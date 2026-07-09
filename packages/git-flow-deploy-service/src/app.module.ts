import { Module } from '@nestjs/common';
import { DeployModule } from './deploy/deploy.module.js';

@Module({
  imports: [DeployModule],
})
export class AppModule {}
