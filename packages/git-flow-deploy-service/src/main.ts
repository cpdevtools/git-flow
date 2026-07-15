import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = parseInt(process.env['PORT'] ?? '3700', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  try {
    const { version, name } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(`${name}@${version} starting on ${host}:${port}`);
  } catch {
    // package.json not found — skip
  }

  await app.listen(port, host);
}

bootstrap();
