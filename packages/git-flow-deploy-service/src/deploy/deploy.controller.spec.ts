import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { signRequest } from '@cpdevtools/git-flow-deploy';
import { DeployModule } from './deploy.module';
import { ConfigService } from './config.service';
import { ReposConfigService } from './repos-config.service';
import { DeployStore } from './deploy-store';

const HMAC_SECRET = 'test-secret-key';

function hmacHeaders(body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'Content-Type': 'application/json',
    'X-Deploy-Signature-256': signRequest(HMAC_SECRET, ts, body),
    'X-Deploy-Timestamp': ts,
  };
}

describe('DeployController', () => {
  let app: INestApplication;
  let store: DeployStore;
  let reposAllowed: jest.Mock;
  let workDir: string;

  beforeEach(async () => {
    reposAllowed = jest.fn().mockReturnValue(true);
    workDir = mkdtempSync(join(tmpdir(), 'gf-deploy-'));
    process.env['DEPLOY_WORK_DIR'] = workDir;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [DeployModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        hmacSecret: HMAC_SECRET,
        githubToken: 'test-token',
        workDir,
        sharedStorageBaseDir: undefined,
      })
      .overrideProvider(ReposConfigService)
      .useValue({ isAllowed: reposAllowed })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    store = moduleRef.get(DeployStore);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    delete process.env['DEPLOY_WORK_DIR'];
    rmSync(workDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // GET /health
  // ---------------------------------------------------------------------------
  describe('GET /health', () => {
    it('returns 200 with ok:true and service info', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.ok).toBe(true);
          expect(typeof res.body.name).toBe('string');
          expect(typeof res.body.version).toBe('string');
        });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /deploy
  // ---------------------------------------------------------------------------
  describe('POST /deploy', () => {
    it('returns 202 for a new deploy', () => {
      const body = JSON.stringify({ repo: 'owner/repo', release_id: 1001 });
      return request(app.getHttpServer())
        .post('/deploy')
        .set(hmacHeaders(body))
        .send(body)
        .expect(202);
    });

    it('returns 200 when deploy is already running', async () => {
      store.start(1002, 'owner/repo');
      const body = JSON.stringify({ repo: 'owner/repo', release_id: 1002 });
      return request(app.getHttpServer())
        .post('/deploy')
        .set(hmacHeaders(body))
        .send(body)
        .expect(200);
    });

    it('returns 401 when HMAC signature is wrong', () => {
      return request(app.getHttpServer())
        .post('/deploy')
        .set({
          'Content-Type': 'application/json',
          'X-Deploy-Signature-256':
            'sha256=0000000000000000000000000000000000000000000000000000000000000000',
          'X-Deploy-Timestamp': String(Math.floor(Date.now() / 1000)),
        })
        .send({ repo: 'owner/repo', release_id: 1003 })
        .expect(401);
    });

    it('returns 401 when HMAC headers are missing', () => {
      return request(app.getHttpServer())
        .post('/deploy')
        .set('Content-Type', 'application/json')
        .send({ repo: 'owner/repo', release_id: 1004 })
        .expect(401);
    });

    it('returns 401 when timestamp is stale', () => {
      const staleTs = String(Math.floor(Date.now() / 1000) - 120);
      const body = JSON.stringify({ repo: 'owner/repo', release_id: 1005 });
      const sig = signRequest(HMAC_SECRET, staleTs, body);
      return request(app.getHttpServer())
        .post('/deploy')
        .set({
          'Content-Type': 'application/json',
          'X-Deploy-Signature-256': sig,
          'X-Deploy-Timestamp': staleTs,
        })
        .send(body)
        .expect(401);
    });

    it('returns 403 when repo is denied', () => {
      reposAllowed.mockReturnValue(false);
      const body = JSON.stringify({ repo: 'denied/repo', release_id: 1006 });
      return request(app.getHttpServer())
        .post('/deploy')
        .set(hmacHeaders(body))
        .send(body)
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /deploy/:id
  // ---------------------------------------------------------------------------
  describe('GET /deploy/:id', () => {
    it('returns 404 for unknown release_id', () => {
      return request(app.getHttpServer()).get('/deploy/99999').expect(404);
    });

    it('returns 404 for non-numeric id', () => {
      return request(app.getHttpServer()).get('/deploy/notanumber').expect(404);
    });

    it('returns status JSON for a known running deploy', async () => {
      store.start(2001, 'owner/repo');
      const res = await request(app.getHttpServer())
        .get('/deploy/2001')
        .expect(200);
      expect(res.body).toMatchObject({
        release_id: 2001,
        repo: 'owner/repo',
        status: 'running',
      });
      expect(res.body.startedAt).toBeDefined();
    });

    it('returns completed status after deploy finishes', async () => {
      const record = store.start(2002, 'owner/repo');
      store.finish(record, 0);
      const res = await request(app.getHttpServer())
        .get('/deploy/2002')
        .expect(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.completedAt).toBeDefined();
    });

    it('returns failed status after deploy exits non-zero', async () => {
      const record = store.start(2003, 'owner/repo');
      store.finish(record, 1);
      const res = await request(app.getHttpServer())
        .get('/deploy/2003')
        .expect(200);
      expect(res.body.status).toBe('failed');
    });
  });
});
