import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, VetStatus } from '@prisma/client';
import app from '../app';
import prisma from '../lib/prisma';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    clinicalTemplate: { findMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    consultation: { findUnique: jest.fn() },
    consultationMetadata: { upsert: jest.fn() },
    consultationAuditLog: { create: jest.fn() },
    notification: { create: jest.fn() },
    notificationPreference: { findUnique: jest.fn() },
    webPushSubscription: { findMany: jest.fn() },
    pushToken: { findMany: jest.fn() },
  },
}));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

describe('Clinical Templates & Call Resilience Incident Endpoints', () => {
  const vetUser = {
    id: 'vet-tpl-1',
    email: 'vet.tpl@huellicam.com',
    firstName: 'Martín',
    lastName: 'Suárez',
    role: Role.VET,
    vetStatus: VetStatus.APPROVED,
    deletedAt: null,
  };
  const clientUser = {
    id: 'client-tpl-1',
    email: 'client.tpl@huellicam.com',
    firstName: 'Ana',
    lastName: 'Pérez',
    role: Role.CLIENT,
    vetStatus: null,
    deletedAt: null,
  };
  const vetToken = jwt.sign({ userId: vetUser.id, role: Role.VET }, JWT_SECRET);
  const clientToken = jwt.sign({ userId: clientUser.id, role: Role.CLIENT }, JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists built-in and custom clinical templates via GET /api/templates and creates custom template', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(vetUser);
    (prisma.clinicalTemplate.findMany as jest.Mock).mockResolvedValue([]);

    const listRes = await request(app)
      .get('/api/templates?kind=EVOLUTION')
      .set('Authorization', `Bearer ${vetToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(3);
    expect(listRes.body.data[0].kind).toBe('EVOLUTION');

    (prisma.clinicalTemplate.create as jest.Mock).mockResolvedValue({
      id: 'tpl-custom-1',
      vetId: vetUser.id,
      kind: 'EVOLUTION',
      name: 'Otitis Externa Rápida',
      category: 'Oftalmología / ORL',
      payload: { summary: 'Otoscopía sugerida y limpieza con solución otológica.' },
    });

    const createRes = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({
        kind: 'EVOLUTION',
        title: 'Otitis Externa Rápida',
        category: 'Oftalmología / ORL',
        content: { summary: 'Otoscopía sugerida y limpieza con solución otológica.' },
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.title).toBe('Otitis Externa Rápida');
  });

  it('records call technical incident and notifies counterpart via POST /api/calls/:consultationId/incident', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(clientUser);
    (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
      id: 'cons-call-1',
      clientId: clientUser.id,
      vetId: vetUser.id,
      status: 'ACTIVE',
      deletedAt: null,
    });
    (prisma.consultationMetadata.upsert as jest.Mock).mockResolvedValue({
      consultationId: 'cons-call-1',
      incidentCode: 'MEDIA_DEVICE_FAILURE',
    });
    (prisma.consultationAuditLog.create as jest.Mock).mockResolvedValue({ id: 'audit-inc-1' });
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: 'notif-inc-1' });
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.pushToken.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/calls/cons-call-1/incident')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ reason: 'Sin señal estable en cámara', errorCode: 'MEDIA_DEVICE_FAILURE' });

    expect(res.status).toBe(200);
    expect(res.body.data.incidentCode).toBe('MEDIA_DEVICE_FAILURE');
    expect(prisma.consultationMetadata.upsert).toHaveBeenCalled();
    expect(prisma.consultationAuditLog.create).toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalled();
  });
});
