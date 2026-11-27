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
      pet: { findMany: jest.fn(), findFirst: jest.fn() },
      petCoOwner: { findMany: jest.fn(), findFirst: jest.fn() },
      petProfileMedia: { findMany: jest.fn(), findUnique: jest.fn() },
      consultation: { findMany: jest.fn(), findFirst: jest.fn() },
      consultationMetadata: { findMany: jest.fn(), findFirst: jest.fn() },
    },
  };
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

describe('Resilience when extension tables lag behind schema (Prisma P2021)', () => {
  const clientUser = {
    id: 'client-res-1',
    email: 'client-res@huellicam.com',
    password: 'hash',
    firstName: 'Tobias',
    lastName: 'Vera',
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
  };

  const clientToken = jwt.sign(
    { userId: clientUser.id, role: 'CLIENT', tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(clientUser);
  });

  it('GET /api/pets succeeds and returns owned pets when petCoOwner and petProfileMedia fail with P2021', async () => {
    const ownedPets = [
      {
        id: 'pet-1',
        ownerId: clientUser.id,
        name: 'Milo',
        species: 'Perro',
        breed: 'Mestizo',
        weightKg: 12,
        sex: 'Macho',
        birthDate: null,
        microchip: null,
        allergies: null,
        chronicConditions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ];

    (prisma.pet.findMany as jest.Mock).mockResolvedValue(ownedPets);
    (prisma.petCoOwner.findMany as jest.Mock).mockRejectedValue({
      code: 'P2021',
      message: 'The table `public.pet_co_owners` does not exist in the current database.',
    });
    (prisma.petProfileMedia.findMany as jest.Mock).mockRejectedValue({
      code: 'P2021',
      message: 'The table `public.pet_profile_media` does not exist in the current database.',
    });

    const res = await request(app)
      .get('/api/pets')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Milo');
  });

  it('GET /api/consultations/mine succeeds when consultationMetadata fails with P2021', async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'cons-1',
        clientId: clientUser.id,
        vetId: 'vet-1',
        petId: 'pet-1',
        status: 'COMPLETED',
        transportStatus: 'ENDED',
        stateVersion: 1,
        activeDeviceId: null,
        claimedAt: null,
        notes: 'Control general',
        diagnosisNotes: 'Todo bien',
        startedAt: new Date(),
        endedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        pet: { id: 'pet-1', name: 'Milo', species: 'Perro' },
        vet: { id: 'vet-1', firstName: 'Laura', lastName: 'Perez' },
        review: null,
        prescriptions: [],
      },
    ]);
    (prisma.consultationMetadata.findMany as jest.Mock).mockRejectedValue({
      code: 'P2021',
      message: 'The table `public.consultation_metadata` does not exist in the current database.',
    });

    const res = await request(app)
      .get('/api/consultations/mine')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('cons-1');
  });
});
