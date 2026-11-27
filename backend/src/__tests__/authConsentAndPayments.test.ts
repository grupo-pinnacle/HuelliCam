import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, VetStatus } from '@prisma/client';
import app from '../app';
import prisma from '../lib/prisma';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    emailVerificationToken: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    telemedicineConsent: { findFirst: jest.fn(), create: jest.fn() },
    vetLedgerEntry: { findMany: jest.fn(), upsert: jest.fn() },
    platformFeatureFlag: { upsert: jest.fn() },
    platformPricingSetting: { upsert: jest.fn() },
    auditLog: { create: jest.fn() },
  },
}));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

describe('Email Verification, Telemedicine Consent & PagoFlex Readiness', () => {
  const clientUser = {
    id: 'client-p5-1',
    email: 'ana.p5@huellicam.com',
    firstName: 'Ana',
    lastName: 'Pérez',
    role: Role.CLIENT,
    vetStatus: null,
    deletedAt: null,
  };
  const vetUser = {
    id: 'vet-p5-1',
    email: 'vet.p5@huellicam.com',
    firstName: 'Laura',
    lastName: 'Gómez',
    role: Role.VET,
    vetStatus: VetStatus.APPROVED,
    deletedAt: null,
  };
  const clientToken = jwt.sign({ userId: clientUser.id, role: Role.CLIENT }, JWT_SECRET);
  const vetToken = jwt.sign({ userId: vetUser.id, role: Role.VET }, JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies user email via POST /api/auth/verify-email with SHA-256 OTP', async () => {
    const code = '482910';
    const hash = crypto.createHash('sha256').update(code).digest('hex');

    (prisma.user.findUnique as jest.Mock).mockResolvedValue(clientUser);
    (prisma.emailVerificationToken.findUnique as jest.Mock).mockResolvedValue({
      userId: clientUser.id,
      email: clientUser.email,
      codeHash: hash,
      expiresAt: new Date(Date.now() + 3600_000),
      verifiedAt: null,
    });
    (prisma.emailVerificationToken.update as jest.Mock).mockResolvedValue({
      userId: clientUser.id,
      verifiedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.data.emailVerified).toBe(true);
    expect(prisma.emailVerificationToken.update).toHaveBeenCalled();
  });

  it('records and retrieves TelemedicineConsent via /api/users/telemedicine-consent', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(clientUser);
    (prisma.telemedicineConsent.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const getEmpty = await request(app)
      .get('/api/users/telemedicine-consent')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(getEmpty.status).toBe(200);
    expect(getEmpty.body.data.accepted).toBe(false);

    (prisma.telemedicineConsent.create as jest.Mock).mockResolvedValue({
      id: 'consent-1',
      userId: clientUser.id,
      version: '1.0',
      acceptedAt: new Date('2026-11-27T15:00:00.000Z'),
    });

    const postRes = await request(app)
      .post('/api/users/telemedicine-consent')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ version: '1.0' });

    expect(postRes.status).toBe(201);
    expect(postRes.body.data.version).toBe('1.0');
  });

  it('returns simulated PagoFlex-ready earnings ledger via GET /api/payments/vet/earnings', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(vetUser);
    (prisma.vetLedgerEntry.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'led-1',
        consultationId: 'cons-1',
        vetId: vetUser.id,
        grossAmount: 15000,
        platformFee: 3000,
        vetNetAmount: 12000,
        currency: 'ARS',
        status: 'SIMULATED',
        externalProvider: 'SIMULATED_NOOP',
        createdAt: new Date('2026-11-27T14:00:00.000Z'),
      },
    ]);

    const res = await request(app)
      .get('/api/payments/vet/earnings')
      .set('Authorization', `Bearer ${vetToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('SIMULATED_PAGOFLEX_PREP');
    expect(res.body.data.totalNetCents).toBe(12000);
    expect(res.body.data.entries).toHaveLength(1);
  });
});
