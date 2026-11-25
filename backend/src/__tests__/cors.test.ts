import request from 'supertest';
import app from '../app';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
}));

describe('CORS Preflight & Header Policy', () => {
  it('should allow X-Device-Id in CORS preflight response headers', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, x-device-id');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-headers']).toBeDefined();
    
    const allowedHeaders = res.headers['access-control-allow-headers'].toLowerCase();
    expect(allowedHeaders).toContain('x-device-id');
    expect(allowedHeaders).toContain('content-type');
  });

  it('should allow GET /api/auth/me preflight from localhost:5173', async () => {
    const res = await request(app)
      .options('/api/auth/me')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization, x-device-id');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const allowedHeaders = res.headers['access-control-allow-headers'].toLowerCase();
    expect(allowedHeaders).toContain('x-device-id');
    expect(allowedHeaders).toContain('authorization');
  });

  it('should REJECT unauthorized or wildcard origins not present in strict whitelist', async () => {
    const maliciousRes = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://huellicam-attacker.vercel.app')
      .set('Access-Control-Request-Method', 'POST');

    expect(maliciousRes.headers['access-control-allow-origin']).toBeUndefined();

    const ngrokRes = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://random-tunnel.ngrok.io')
      .set('Access-Control-Request-Method', 'POST');

    expect(ngrokRes.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('should allow production whitelisted domain https://app.huellicam.com.ar', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://app.huellicam.com.ar')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.huellicam.com.ar');
  });
});
