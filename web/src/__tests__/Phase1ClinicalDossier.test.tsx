import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PetDossierModal from '../components/dashboard/PetDossierModal';
import ClinicalMediaViewer from '../components/common/ClinicalMediaViewer';
import { EvolutionEditor } from '../vet/Consultations';
import type { Pet, PetDossierDTO } from '../types';
import type { Patient } from '../vet/data';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    defaults: { baseURL: 'http://localhost:3001' },
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'vet-1', firstName: 'Laura', lastName: 'Gómez', role: 'VET' },
  }),
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({ reconnectingConsultations: {} }),
}));

const samplePet: Pet = {
  id: 'pet-1',
  ownerId: 'user-1',
  name: 'Milo',
  species: 'Perro',
  breed: 'Golden Retriever',
  sex: 'Macho',
  weightKg: 28,
  microchip: '981098109810981',
  allergies: 'Polen',
  chronicConditions: 'Ninguna',
  createdAt: '2026-01-10T10:00:00.000Z',
  updatedAt: '2026-01-10T10:00:00.000Z',
};

const sampleDossier: PetDossierDTO = {
  pet: {
    ...samplePet,
    photoUrl: '/api/media/photo-1',
    owner: { id: 'user-1', firstName: 'Ana', lastName: 'Pérez', email: 'ana@test.com' },
  },
  vaccines: [
    {
      id: 'vac-1',
      petId: 'pet-1',
      name: 'Antirrábica anual',
      appliedAt: '2026-02-15T10:00:00.000Z',
      nextDueAt: '2027-02-15T10:00:00.000Z',
      lotNumber: 'L-99',
      notes: null,
      status: 'AL_DIA',
      createdAt: '2026-02-15T10:00:00.000Z',
    },
  ],
  documents: [
    {
      id: 'doc-1',
      petId: 'pet-1',
      mediaFileId: 'media-1',
      consultationId: null,
      category: 'ESTUDIO',
      title: 'Hemograma Completo',
      mimeType: 'application/pdf',
      sizeBytes: 204800,
      url: '/api/media/media-1',
      uploadedById: 'user-1',
      createdAt: '2026-03-01T12:00:00.000Z',
    },
  ],
  evolutions: [
    {
      id: 'evo-1',
      petId: 'pet-1',
      consultationId: 'cons-1',
      vetId: 'vet-1',
      vetName: 'Dra. Laura Gómez',
      summary: 'Paciente estable con buena evolución dérmica.',
      diagnosis: 'Dermatitis controlada',
      createdAt: '2026-03-02T15:00:00.000Z',
    },
  ],
  coOwners: [
    {
      id: 'co-1',
      petId: 'pet-1',
      userId: 'user-2',
      email: 'carlos@test.com',
      name: 'Carlos Pérez',
      role: 'CO_OWNER',
      status: 'ACTIVE',
      createdAt: '2026-03-01T09:00:00.000Z',
    },
  ],
  consultations: [
    {
      id: 'cons-1',
      status: 'COMPLETED',
      startedAt: '2026-03-02T14:30:00.000Z',
      endedAt: '2026-03-02T15:00:00.000Z',
      createdAt: '2026-03-02T14:20:00.000Z',
      notes: 'Control de piel',
      diagnosisNotes: 'Dermatitis controlada',
      triagePriority: 'VERDE',
      vet: { id: 'vet-1', firstName: 'Laura', lastName: 'Gómez' },
      prescriptions: [
        {
          id: 'rx-1',
          medication: 'Oclacitinib 16mg',
          dosage: '1 comp',
          frequency: 'Cada 24h',
          durationDays: 14,
          indications: 'Con alimento',
          issuedAt: '2026-03-02T14:55:00.000Z',
        },
      ],
    },
  ],
  sharedMedia: [],
};

const samplePatient: Patient = {
  id: 'pet-1',
  name: 'Milo',
  kind: 'Perro',
  breed: 'Golden',
  age: '4 años',
  weight: '28 kg',
  sex: 'Macho',
  chip: '981098109810981',
  tutor: 'Ana Pérez',
  tutorPhone: '+54 11 5555 0000',
  tutorEmail: 'ana@test.com',
  photo: '',
  last: 'Hoy',
  lastDays: 0,
  state: 'Activo',
  allergies: ['Polen'],
  meds: [],
  history: [],
  vaccines: [],
  past: [],
  studies: [],
  docs: [],
  evolution: [],
};

describe('Phase 1 Clinical Dossier, Media Viewer & Evolutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:http://localhost/mock-media'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders full backend clinical dossier sections in PetDossierModal', () => {
    render(
      <PetDossierModal
        pet={samplePet}
        dossier={sampleDossier}
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Antirrábica anual')).toBeDefined();
    expect(screen.getByText(/Hemograma Completo/)).toBeDefined();
    expect(screen.getByText(/Paciente estable con buena evolución dérmica/)).toBeDefined();
    expect(screen.getByText(/Carlos Pérez/)).toBeDefined();
    expect(screen.getByText(/Oclacitinib 16mg/)).toBeDefined();
  });

  it('fetches authenticated media blob in ClinicalMediaViewer', async () => {
    apiGetMock.mockResolvedValueOnce({
      data: new Blob(['pdf-binary'], { type: 'application/pdf' }),
    });

    render(
      <ClinicalMediaViewer
        open={true}
        url="/api/media/media-1"
        title="Hemograma Completo"
        mimeType="application/pdf"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith(
        '/api/media/media-1',
        expect.objectContaining({ responseType: 'blob' })
      );
    });
    const iframe = await screen.findByTitle('Hemograma Completo');
    expect(iframe.getAttribute('src')).toBe('blob:http://localhost/mock-media');
  });

  it('persists clinical evolution note via POST /api/pets/:id/evolutions', async () => {
    apiPostMock.mockResolvedValueOnce({ data: { success: true, data: { id: 'evo-new' } } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <EvolutionEditor p={samplePatient} consultationId="cons-1" />
      </QueryClientProvider>
    );

    const textarea = screen.getByLabelText('Contenido de la evolución');
    fireEvent.change(textarea, { target: { value: 'Control favorable sin lesiones activas.' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar evolución/i }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/pets/pet-1/evolutions', {
        summary: 'Control favorable sin lesiones activas.',
        consultationId: 'cons-1',
      });
    });

    expect(await screen.findByText(/Control favorable sin lesiones activas/i)).toBeDefined();
  });
});
