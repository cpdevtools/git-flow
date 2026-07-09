import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = parseInt(process.env['PORT'] ?? '3700', 10);
  await app.listen(port);
}

bootstrap();
