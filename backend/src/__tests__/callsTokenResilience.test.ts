import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';

jest.mock('../lib/prisma', () => {
  const actual = jest.requireActual('../lib/prisma');
  return {
    __esModule: true,
    ...actual,
    default: {
      user: { findUnique: jest.fn() },
      consultation: { findUnique: jest.fn(), updateMany: jest.fn() },
      call: { findFirst: jest.fn(), create: jest.fn() },
      platformFeatureFlag: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

describe('Calls LiveKit token resilience against schema lag', () => {
  const vetUser = {
    id: 'vet-call-res-1',
    email: 'vet-call@huellicam.com',
    password: 'hash',
    firstName: 'Diego',
    lastName: 'Suarez',
    phone: '+5491155551111',
    role: 'VET',
    vetStatus: 'APPROVED',
    licenseNumber: 'MP-1234',
    bio: null,
    photoUrl: null,
    tokenVersion: 1,
    ratingAvg: 0,
    ratingCount: 0,
    isOnline: true,
    lastSeen: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const vetToken = jwt.sign(
    { userId: vetUser.id, role: 'VET', tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(vetUser);
  });

  it('POST /api/calls/:id/token succeeds when prisma.call telemetry table/columns throw P2022', async () => {
    (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
      id: 'cons-call-1',
      clientId: 'client-1',
      vetId: vetUser.id,
      petId: 'pet-1',
      status: 'ACTIVE',
      activeDeviceId: null,
      deletedAt: null,
    });
    (prisma.call.findFirst as jest.Mock).mockRejectedValue({
      code: 'P2022',
      message: 'The column `calls.disconnect_reason` does not exist in the current database.',
    });

    const res = await request(app)
      .post('/api/calls/cons-call-1/token')
      .set('Authorization', `Bearer ${vetToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.token.length).toBeGreaterThan(20);
  });
});
