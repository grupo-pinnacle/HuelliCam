import request from 'supertest';
import app from '../app';
import {
  resolveOrCreateCorrelationId,
  runWithLogContext,
  getLogContext,
  sanitizeCorrelationId,
} from '../lib/logger';

describe('Structured Logging & Correlation IDs (M4)', () => {
  it('sanitizes valid correlation IDs and rejects CRLF/spaces/oversized IDs', () => {
    expect(sanitizeCorrelationId('req-abc-123_45.6:7')).toBe('req-abc-123_45.6:7');
    expect(sanitizeCorrelationId('bad id with spaces')).toBeUndefined();
    expect(sanitizeCorrelationId('bad\r\ninjection')).toBeUndefined();
    expect(sanitizeCorrelationId('a'.repeat(129))).toBeUndefined();

    const generated = resolveOrCreateCorrelationId('invalid $id');
    expect(generated.length).toBeGreaterThan(0);
    expect(generated).not.toMatch(/[\r\n\s]/);
  });

  it('propagates request context inside AsyncLocalStorage', () => {
    expect(getLogContext()).toBeUndefined();
    const inside = runWithLogContext({ requestId: 'req-als-1', correlationId: 'corr-als-1' }, () => {
      return getLogContext();
    });
    expect(inside).toEqual({ requestId: 'req-als-1', correlationId: 'corr-als-1' });
    expect(getLogContext()).toBeUndefined();
  });

  it('echoes valid X-Request-Id and sanitizes malformed X-Request-Id on HTTP responses', async () => {
    const validRes = await request(app).get('/health').set('X-Request-Id', 'req-trace-42');
    expect(validRes.status).toBe(200);
    expect(validRes.headers['x-request-id']).toBe('req-trace-42');

    const badRes = await request(app).get('/health').set('X-Request-Id', 'bad id $crlf');
    expect(badRes.status).toBe(200);
    expect(badRes.headers['x-request-id']).toBeDefined();
    expect(badRes.headers['x-request-id']).not.toBe('bad id $crlf');
    expect(badRes.headers['x-request-id']).not.toMatch(/[\r\n\s]/);
  });

  it('embeds matching requestId in 413 PAYLOAD_TOO_LARGE error envelope', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('X-Correlation-Id', 'corr-413-check')
      .send(JSON.stringify({ data: 'x'.repeat(110 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.error.requestId).toBe('corr-413-check');
  });
});
