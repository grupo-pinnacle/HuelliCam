import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EvolutionEditor } from '../vet/Consultations';
import { NewPrescription } from '../vet/Prescriptions';
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
  useSocket: () => ({ socket: null, reconnectingConsultations: {} }),
}));

vi.mock('../vet/vetkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vet/vetkit')>();
  return {
    ...actual,
    useVet: () => ({
      avail: 'Disponible',
      requestAvail: vi.fn(),
      notify: vi.fn(),
      queue: [],
      accept: vi.fn(),
      consults: [],
      consultsLoading: false,
      consultsError: false,
      refetchConsults: vi.fn(),
      finish: vi.fn(),
      threads: [],
      send: vi.fn(),
      markRead: vi.fn(),
      unread: 0,
      events: [],
      setEvents: vi.fn(),
      rx: [],
      rxLoading: false,
      rxError: false,
      refetchRx: vi.fn(),
      setRx: vi.fn(),
      followUps: [],
      setFollowUps: vi.fn(),
      patientsList: [{ id: 'pet-1', name: 'Milo', kind: 'Perro', tutor: 'Ana', allergies: [], meds: [] }],
      forceEmpty: false,
    }),
  };
});

const patient: Patient = {
  id: 'pet-1',
  name: 'Milo',
  kind: 'Perro',
  breed: 'Golden',
  age: '4 años',
  weight: '28 kg',
  sex: 'Macho',
  chip: 'No informado',
  tutor: 'Ana',
  tutorPhone: '+54 11 5555 0000',
  tutorEmail: 'ana@test.com',
  photo: '',
  last: 'Hoy',
  lastDays: 0,
  state: 'Activo',
  allergies: ['Ninguna'],
  meds: [],
  history: [],
  vaccines: [],
  past: [],
  studies: [],
  docs: [],
  evolution: [],
};

describe('Phase 4 Clinical Templates (Evolution & Prescription)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts an evolution template fetched from /api/templates?kind=EVOLUTION', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            id: 'tpl-1',
            vetId: null,
            kind: 'EVOLUTION',
            title: 'SOAP Clínica General',
            category: 'SOAP',
            isDefault: true,
            content: { summary: 'S: Control estable. O: Mucosas rosadas.' },
          },
        ],
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <EvolutionEditor p={patient} consultationId="cons-1" />
      </QueryClientProvider>
    );

    const chip = await screen.findByRole('button', { name: /\+ SOAP Clínica General/i });
    fireEvent.click(chip);

    const textarea = screen.getByLabelText('Contenido de la evolución') as HTMLTextAreaElement;
    expect(textarea.value).toContain('S: Control estable');
  });

  it('populates prescription fields when selecting a PRESCRIPTION template', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            id: 'tpl-rx-1',
            vetId: null,
            kind: 'PRESCRIPTION',
            title: 'Protector Gástrico',
            category: 'Gastro',
            isDefault: true,
            content: {
              medication: 'Omeprazol 10mg',
              dosage: '1 comp',
              frequency: 'Cada 24 horas',
              durationDays: 7,
              indications: 'En ayunas',
            },
          },
        ],
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <NewPrescription />
      </QueryClientProvider>
    );

    const chip = await screen.findByRole('button', { name: /\+ Protector Gástrico/i });
    fireEvent.click(chip);

    await waitFor(() => {
      expect((screen.getByDisplayValue('Omeprazol 10mg') as HTMLInputElement).value).toBe('Omeprazol 10mg');
      expect((screen.getByDisplayValue('1 comp') as HTMLInputElement).value).toBe('1 comp');
    });
  });
});
