import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { signRequest } from '@cpdevtools/git-flow-deploy';
import { AppModule } from '../src/app.module';

// Must be set before AppModule loads ConfigService (class field initializers run at instantiation)
const TEST_HMAC_SECRET = 'e2e-test-hmac-secret-do-not-use-in-prod';
process.env['DEPLOY_HMAC_SECRET'] = TEST_HMAC_SECRET;
process.env['GITHUB_TOKEN'] = 'ghs_fake_token_for_e2e_tests';
process.env['DEPLOY_WORK_DIR'] = '/tmp/e2e-deploy-test';

function signedHeaders(body: string, overrides?: { ts?: string; sig?: string }): Record<string, string> {
  const ts = overrides?.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = overrides?.sig ?? signRequest(TEST_HMAC_SECRET, ts, body);
  return {
    'Content-Type': 'application/json',
    'X-Deploy-Signature-256': sig,
    'X-Deploy-Timestamp': ts,
  };
}

describe('Deploy Service (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  describe('GET /health', () => {
    it('returns { ok: true } without authentication', async () => {
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ ok: true });
    });
  });

  // ---------------------------------------------------------------------------
  // HMAC authentication
  // ---------------------------------------------------------------------------

  describe('POST /deploy — authentication', () => {
    const body = JSON.stringify({ repo: 'cpdevtools/test-git-flow', release_id: 1 });

    it('rejects requests with no auth headers → 401', async () => {
      await request(app.getHttpServer())
        .post('/deploy')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(401);
    });

    it('rejects requests with a stale timestamp (>60 s old) → 401', async () => {
      const staleTs = String(Math.floor(Date.now() / 1000) - 120);
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body, { ts: staleTs }))
        .send(body)
        .expect(401);
    });

    it('rejects requests with an invalid HMAC signature → 401', async () => {
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body, { sig: 'sha256=0000000000000000000000000000000000000000000000000000000000000000' }))
        .send(body)
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Request body validation
  // ---------------------------------------------------------------------------

  describe('POST /deploy — body validation', () => {
    it('rejects missing repo field → 400', async () => {
      const body = JSON.stringify({ release_id: 42 });
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body))
        .send(body)
        .expect(400);
    });

    it('rejects missing release_id field → 400', async () => {
      const body = JSON.stringify({ repo: 'cpdevtools/test-git-flow' });
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body))
        .send(body)
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Deploy lifecycle
  // ---------------------------------------------------------------------------

  describe('POST /deploy — accepted', () => {
    const releaseId = 9001;
    const body = JSON.stringify({ repo: 'cpdevtools/test-git-flow', release_id: releaseId });

    it('accepts a valid signed request → 202', async () => {
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body))
        .send(body)
        .expect(202);
    });

    it('returns 200 when the same release_id is already being processed', async () => {
      // The deploy for releaseId is running (making a real network call that will
      // fail with the fake token — but it hasn't failed yet when this runs)
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body))
        .send(body)
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Status endpoint
  // ---------------------------------------------------------------------------

  describe('GET /deploy/:id', () => {
    const releaseId = 9010;

    beforeAll(async () => {
      const body = JSON.stringify({ repo: 'cpdevtools/test-git-flow', release_id: releaseId });
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body))
        .send(body)
        .expect(202);
    });

    it('returns running status for an in-progress deploy', async () => {
      const res = await request(app.getHttpServer()).get(`/deploy/${releaseId}`).expect(200);
      expect(res.body).toMatchObject({
        release_id: releaseId,
        repo: 'cpdevtools/test-git-flow',
        status: 'running',
      });
      expect(res.body.startedAt).toBeDefined();
    });

    it('returns 404 for an unknown release_id', async () => {
      await request(app.getHttpServer()).get('/deploy/99998').expect(404);
    });

    it('returns 404 for a non-numeric id', async () => {
      await request(app.getHttpServer()).get('/deploy/notanumber').expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Log streaming
  // ---------------------------------------------------------------------------

  describe('GET /deploy/:id/logs', () => {
    const releaseId = 9002;

    beforeAll(async () => {
      // Trigger a deploy so we have a log record to stream
      const body = JSON.stringify({ repo: 'cpdevtools/test-git-flow', release_id: releaseId });
      await request(app.getHttpServer())
        .post('/deploy')
        .set(signedHeaders(body))
        .send(body)
        .expect(202);
    });

    it('streams logs for a known release_id → 200 text/plain', async () => {
      const res = await request(app.getHttpServer())
        .get(`/deploy/${releaseId}/logs`)
        .expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      // The deploy starts logging immediately (▸ Fetching deploy.zip…)
      expect(typeof res.text).toBe('string');
    });

    it('returns 404 for an unknown release_id', async () => {
      await request(app.getHttpServer())
        .get('/deploy/99999/logs')
        .expect(404);
    });

    it('returns 404 for a non-numeric id', async () => {
      await request(app.getHttpServer())
        .get('/deploy/notanumber/logs')
        .expect(404);
    });
  });
});
