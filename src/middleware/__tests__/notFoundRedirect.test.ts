/**
 * Browsing the API host should NOT greet a human with raw JSON.
 *
 * The rule under test: a BROWSER navigating to an unknown path gets bounced to
 * the public site; every machine client still gets the loud JSON 404 it relies
 * on. Turning genuine API 404s into redirects would be a silent failure — a
 * client expecting a JSON error would instead follow a 302 to an HTML page and
 * misreport what happened.
 */
import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const SITE = 'https://carrottickets.com';

describe('unknown routes — browser navigation', () => {
  it('redirects a browser hitting the API root to the public site', async () => {
    const res = await request(app).get('/').set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(SITE);
  });

  it('redirects a browser hitting any unknown deep path', async () => {
    const res = await request(app).get('/api/secret-looking-path').set('Accept', 'text/html,*/*;q=0.8');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(SITE);
  });

  it('leaks no route detail in the redirect', async () => {
    const res = await request(app).get('/api/internal/thing').set('Accept', 'text/html');

    expect(res.headers['location']).toBe(SITE);
    expect(res.headers['location']).not.toContain('internal');
  });
});

describe('unknown routes — machine clients still get a loud 404', () => {
  it('returns JSON 404 for an explicit application/json client', async () => {
    const res = await request(app).get('/api/nope').set('Accept', 'application/json');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns JSON 404 for a wildcard Accept (curl, axios defaults)', async () => {
    // The trap: req.accepts(['html','json']) resolves */* to 'html', which would
    // silently redirect ordinary API clients. Must stay a 404.
    const res = await request(app).get('/api/nope').set('Accept', '*/*');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns JSON 404 when no Accept header is sent at all', async () => {
    const res = await request(app).get('/api/nope');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns JSON 404 for a POST even from a browser-ish Accept', async () => {
    // A form/webhook POST to a wrong path must fail loudly, not redirect.
    const res = await request(app).post('/api/nope').set('Accept', 'text/html').send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('real routes are unaffected', () => {
  it('still serves a genuine API route to a browser Accept header', async () => {
    const res = await request(app).get('/health').set('Accept', 'text/html');

    expect(res.status).toBe(200);
  });
});
