import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AvailabilityPage, AppointmentsPage } from '../vet/Agenda';
import { FollowUpsPage } from '../vet/Admin';
import { ConsultationsPage } from '../pages/ClientApp';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    defaults: { baseURL: 'http://localhost:3001' },
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', firstName: 'Ana', lastName: 'Pérez', role: 'CLIENT', email: 'ana@test.com' },
  }),
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, reconnectingConsultations: {} }),
}));

const notifyMock = vi.fn();
const setEventsMock = vi.fn();
const setFollowUpsMock = vi.fn();

vi.mock('../vet/vetkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vet/vetkit')>();
  return {
    ...actual,
    useVet: () => ({
      avail: 'Disponible',
      requestAvail: vi.fn(),
      notify: notifyMock,
      queue: [],
      accept: vi.fn(),
      consults: [
        {
          id: 'cons-1',
          petId: 'milo',
          day: 'Hoy',
          date: 'Hoy',
          time: '18:00',
          reason: 'Control anual',
          status: 'Próxima',
          mode: 'Videoconsulta',
        },
      ],
      consultsLoading: false,
      consultsError: false,
      refetchConsults: vi.fn(),
      finish: vi.fn(),
      threads: [],
      send: vi.fn(),
      markRead: vi.fn(),
      unread: 0,
      events: [
        {
          id: 'ev-c-cons-1',
          day: 6,
          time: '18:00',
          petId: 'milo',
          type: 'Videoconsulta',
          status: 'Pendiente',
          consultId: 'cons-1',
        },
      ],
      setEvents: setEventsMock,
      rx: [],
      rxLoading: false,
      rxError: false,
      refetchRx: vi.fn(),
      setRx: vi.fn(),
      followUps: [
        {
          id: 'fu-1',
          petId: 'milo',
          title: 'Control post cirugía',
          when: 'Mañana · 10:00',
          status: 'Pendiente',
          note: 'Revisar puntos',
        },
      ],
      setFollowUps: setFollowUpsMock,
      patientsList: [],
      forceEmpty: false,
    }),
  };
});

describe('Phase 2 Scheduling, Rescheduling & Follow-ups UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves vet weekly availability via PUT /api/scheduling/vets/me/availability', async () => {
    apiGetMock.mockResolvedValue({ data: { success: true, data: [] } });
    apiPutMock.mockResolvedValue({ data: { success: true, data: [] } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <AvailabilityPage />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Editar disponibilidad/i }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar disponibilidad/i }));

    await waitFor(() => {
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/scheduling/vets/me/availability',
        expect.objectContaining({ slots: expect.any(Array) })
      );
    });
  });

  it('marks a clinical follow-up as COMPLETED via PATCH /api/scheduling/follow-ups/:id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiPatchMock.mockResolvedValue({ data: { success: true, data: { id: 'fu-1', status: 'COMPLETED' } } });

    render(
      <QueryClientProvider client={qc}>
        <FollowUpsPage />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Abrir seguimiento/i }));
    fireEvent.click(screen.getByRole('button', { name: /Marcar como realizado/i }));

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/scheduling/follow-ups/fu-1', {
        status: 'COMPLETED',
      });
    });
  });

  it('opens client appointment booking modal and submits POST /api/scheduling/appointments', async () => {
    const slotIso = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/pets') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'pet-1',
                ownerId: 'user-1',
                name: 'Milo',
                species: 'Perro',
                breed: 'Golden',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        };
      }
      if (url === '/api/scheduling/vets') {
        return {
          data: {
            success: true,
            data: [{ id: 'vet-1', firstName: 'Laura', lastName: 'Gómez', specialty: null }],
          },
        };
      }
      if (url.startsWith('/api/scheduling/vets/vet-1/slots')) {
        return {
          data: {
            success: true,
            data: { slots: [{ startIso: slotIso, label: '10:00', available: true }] },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });
    apiPostMock.mockResolvedValue({ data: { success: true, data: { id: 'cons-booked' } } });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <ConsultationsPage initialTab="Agenda" />
      </QueryClientProvider>
    );

    const bookBtn = await screen.findByRole('button', { name: /Programar turno/i });
    fireEvent.click(bookBtn);

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/scheduling/vets');
    });

    const reasonInput = screen.getByPlaceholderText(/Control anual, vacunación/i);
    fireEvent.change(reasonInput, { target: { value: 'Control dermatológico' } });
    const submitBtn = screen.getByRole('button', { name: /Confirmar turno/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/scheduling/appointments',
        expect.objectContaining({
          petId: 'pet-1',
          vetId: 'vet-1',
          notes: 'Control dermatológico',
        })
      );
    });
  });

  it('allows vet to reschedule an agenda consultation via PATCH /api/consultations/:id/reschedule', async () => {
    apiGetMock.mockResolvedValue({ data: { success: true, data: [] } });
    apiPatchMock.mockResolvedValue({ data: { success: true, data: { id: 'cons-1' } } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <AppointmentsPage />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('tab', { name: /Próximas consultas/i }));
    fireEvent.click(screen.getByRole('button', { name: /Reprogramar/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar cambio/i }));

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith(
        '/api/consultations/cons-1/reschedule',
        expect.objectContaining({ scheduledAt: expect.any(String) })
      );
    });
  });
});
