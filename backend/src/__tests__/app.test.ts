import request from 'supertest';
import app from '../app';

describe('GET /health', () => {
  it('should return 200 OK with health status information', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('uptime');
    expect(response.body).toHaveProperty('database');
  });
});

describe('Payload Size Limit (VULN-10)', () => {
  it('should reject request bodies exceeding 100kb with 413 PAYLOAD_TOO_LARGE', async () => {
    // Generate a payload exceeding 100kb
    const largeString = 'a'.repeat(105 * 1024);
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send({ email: 'test@example.com', password: largeString });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
