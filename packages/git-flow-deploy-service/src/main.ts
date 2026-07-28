import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getServiceInfo } from './version';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = parseInt(process.env['PORT'] ?? '3700', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  const { name, version } = getServiceInfo();
  console.log(`${name}@${version} starting on ${host}:${port}`);

  await app.listen(port, host);
}

bootstrap();
