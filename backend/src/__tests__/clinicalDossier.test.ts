import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';
import prisma from '../lib/prisma';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    pet: { findFirst: jest.fn(), findMany: jest.fn() },
    petProfileMedia: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    petCoOwner: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), delete: jest.fn() },
    petVaccine: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    petDocument: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    clinicalEvolution: { findMany: jest.fn(), create: jest.fn() },
    mediaFile: { findFirst: jest.fn() },
    mediaPetLink: { findUnique: jest.fn(), upsert: jest.fn() },
    consultation: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  },
}));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'owner-1',
  email: 'owner@huellicam.com',
  password: 'hash',
  firstName: 'Ana',
  lastName: 'Gomez',
  phone: '+5491155551111',
  role: 'CLIENT',
  vetStatus: null,
  licenseNumber: null,
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
  ...overrides,
});

describe('Phase 1: Clinical Dossier, Vaccines, Documents, Evolutions & Co-Owners', () => {
  const owner = makeUser({ id: 'owner-1', role: 'CLIENT' });
  const vetTwo = makeUser({
    id: 'vet-2',
    email: 'vet2@huellicam.com',
    role: 'VET',
    vetStatus: 'APPROVED',
    licenseNumber: 'MP-9911',
  });
  const coTutor = makeUser({ id: 'co-1', email: 'cotutor@huellicam.com', role: 'CLIENT' });

  const ownerToken = jwt.sign({ userId: owner.id, role: 'CLIENT', tokenVersion: 1 }, JWT_SECRET, { algorithm: 'HS256' });
  const vetToken = jwt.sign({ userId: vetTwo.id, role: 'VET', tokenVersion: 1 }, JWT_SECRET, { algorithm: 'HS256' });
  const coToken = jwt.sign({ userId: coTutor.id, role: 'CLIENT', tokenVersion: 1 }, JWT_SECRET, { algorithm: 'HS256' });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists vaccines via POST /api/pets/:id/vaccines and retrieves them', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(owner);
    (prisma.pet.findFirst as jest.Mock).mockResolvedValue({ id: 'pet-1', ownerId: owner.id, deletedAt: null });
    (prisma.petVaccine.create as jest.Mock).mockResolvedValue({
      id: 'vac-1',
      petId: 'pet-1',
      createdById: owner.id,
      name: 'Antirrábica',
      appliedAt: new Date('2026-05-01T12:00:00Z'),
      nextDueAt: new Date('2027-05-01T12:00:00Z'),
      status: 'UP_TO_DATE',
      notes: 'Lote AR-92',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    const res = await request(app)
      .post('/api/pets/pet-1/vaccines')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Antirrábica', status: 'UP_TO_DATE', appliedAt: '2026-05-01', nextDueAt: '2027-05-01' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Antirrábica');
  });

  it('allows an attending VET to access clinical media uploaded for the pet by another user', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(vetTwo);
    (prisma.mediaFile.findFirst as jest.Mock).mockResolvedValue({
      id: 'media-99',
      ownerId: owner.id,
      consultationId: null,
      fileName: 'radiografia.pdf',
      fileSize: 4096,
      mimeType: 'application/pdf',
      localPath: '/tmp/nonexistent-test.pdf',
      s3Key: null,
      deletedAt: null,
      consultation: null,
    });
    (prisma.mediaPetLink.findUnique as jest.Mock).mockResolvedValue({ mediaFileId: 'media-99', petId: 'pet-1' });
    (prisma.petDocument.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.pet.findFirst as jest.Mock).mockResolvedValue({ id: 'pet-1', ownerId: owner.id, deletedAt: null });
    (prisma.petCoOwner.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.consultation.findFirst as jest.Mock).mockResolvedValue({ id: 'cons-2', petId: 'pet-1', vetId: vetTwo.id });

    const res = await request(app)
      .get('/api/media/media-99')
      .set('Authorization', `Bearer ${vetToken}`);

    // Should pass authorization (403 would mean access denied; 404 is expected because file doesn't exist on disk)
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FILE_NOT_FOUND_ON_DISK');
  });

  it('allows co-owners to read pet clinical dossier and blocks non-vet evolution creation', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(coTutor);
    (prisma.pet.findFirst as jest.Mock).mockResolvedValue({
      id: 'pet-1',
      ownerId: owner.id,
      name: 'Milo',
      species: 'Canino',
      breed: 'Labrador',
      deletedAt: null,
      owner,
    });
    (prisma.petCoOwner.findFirst as jest.Mock).mockResolvedValue({ id: 'co-link-1', petId: 'pet-1', userId: coTutor.id });
    (prisma.petProfileMedia.findUnique as jest.Mock).mockResolvedValue({ petId: 'pet-1', photoUrl: '/api/media/photo-1' });
    (prisma.petVaccine.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.petDocument.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.clinicalEvolution.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.petCoOwner.findMany as jest.Mock).mockResolvedValue([]);

    const dossierRes = await request(app)
      .get('/api/pets/pet-1/dossier')
      .set('Authorization', `Bearer ${coToken}`);

    expect(dossierRes.status).toBe(200);
    expect(dossierRes.body.data.pet.photoUrl).toBe('/api/media/photo-1');

    const evoRes = await request(app)
      .post('/api/pets/pet-1/evolutions')
      .set('Authorization', `Bearer ${coToken}`)
      .send({ summary: 'Control clínico sin permiso' });

    expect(evoRes.status).toBe(403);
  });
});
