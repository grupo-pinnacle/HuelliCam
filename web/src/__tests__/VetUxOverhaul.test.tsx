import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const apiDeleteMock = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
    defaults: { baseURL: 'http://localhost:3001' },
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'vet-overhaul-1', firstName: 'Doctor', lastName: 'Uno', role: 'VET' },
  }),
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({
    socket: null,
    isConnected: false,
    reconnectingConsultations: {},
    joinConsultation: vi.fn(),
    leaveConsultation: vi.fn(),
    emitEvent: vi.fn(),
  }),
}));

import { VetProvider } from '../vet/vetkit';
import { MessagesPage as VetMessagesPage } from '../vet/Messages';
import { PatientsPage } from '../vet/Patients';
import { FollowUpsPage, VetEarningsPage } from '../vet/Admin';

const mockConsults = [
  {
    id: 'cons-finished-1',
    clientId: 'cli-1',
    vetId: 'vet-overhaul-1',
    petId: 'pet-finished-1',
    status: 'COMPLETED',
    notes: 'Control general finalizado',
    createdAt: '2026-11-26T10:00:00.000Z',
    startedAt: '2026-11-26T10:05:00.000Z',
    pet: {
      id: 'pet-finished-1',
      ownerId: 'cli-1',
      name: 'Rocko',
      species: 'Perro',
      breed: 'Mestizo',
      createdAt: '2026-11-26T10:00:00.000Z',
      updatedAt: '2026-11-26T10:00:00.000Z',
    },
    client: { id: 'cli-1', firstName: 'Tobias', lastName: 'Vera', email: 'tobias@test.com' },
  },
  {
    id: 'cons-active-1',
    clientId: 'cli-2',
    vetId: 'vet-overhaul-1',
    petId: 'pet-active-1',
    status: 'ACTIVE',
    notes: 'Atención respiratoria en curso',
    createdAt: '2026-11-27T14:00:00.000Z',
    startedAt: '2026-11-27T14:02:00.000Z',
    pet: {
      id: 'pet-active-1',
      ownerId: 'cli-2',
      name: 'Princesa',
      species: 'Perro',
      breed: 'Pastor Alemán',
      createdAt: '2026-11-27T14:00:00.000Z',
      updatedAt: '2026-11-27T14:00:00.000Z',
    },
    client: { id: 'cli-2', firstName: 'Iara', lastName: 'Bouso', email: 'iara@test.com' },
  },
];

const mockFollowUps = [
  {
    id: 'fu-ov-1',
    petId: 'pet-active-1',
    consultationId: 'cons-active-1',
    title: 'Control respiratorio',
    notes: 'Evaluar frecuencia respiratoria',
    dueAt: '2026-11-29T13:00:00.000Z',
    status: 'PENDING',
  },
];

describe('Vet UX Overhaul: Delete Chat Modal, Active/History Patients, FollowUps & Earnings Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();

    apiPatchMock.mockResolvedValue({ data: { success: true, data: {} } });
    apiPostMock.mockResolvedValue({ data: { success: true, data: { id: 'fu-new-1' } } });
    apiDeleteMock.mockResolvedValue({ data: { success: true, data: { deletedMessages: 3, deletedMedia: 1 } } });
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/mine') {
        return { data: { success: true, data: mockConsults } };
      }
      if (url === '/api/scheduling/follow-ups') {
        return { data: { success: true, data: mockFollowUps } };
      }
      if (url === '/api/payments/vet/earnings') {
        return {
          data: {
            success: true,
            data: {
              totalGrossCents: 20000,
              totalFeeCents: 4000,
              totalNetCents: 16000,
              currency: 'ARS',
              mode: 'SIMULATED_PAGOFLEX_PREP',
              entries: [
                {
                  id: 'led-ov-1',
                  consultationId: 'cons-12345678',
                  grossCents: 20000,
                  platformFeeCents: 4000,
                  netCents: 16000,
                  currency: 'ARS',
                  status: 'SIMULATED',
                  provider: 'SIMULATED_NOOP',
                  settledAt: null,
                  createdAt: '2026-11-27T14:00:00.000Z',
                },
              ],
            },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });
  });

  it('opens delete confirmation modal via 3-dots menu and calls DELETE /api/consultations/:id/messages in Vet MessagesPage', async () => {
    window.localStorage.setItem('huellicam_chat_cons-finished-1', JSON.stringify([{ id: 'm1', text: 'hola' }]));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <VetProvider forceEmpty={false}>
          <VetMessagesPage />
        </VetProvider>
      </QueryClientProvider>
    );

    const moreBtn = await screen.findByTestId('vet-chat-more-cons-finished-1');
    fireEvent.click(moreBtn);
    fireEvent.click(screen.getByRole('menuitem', { name: /Eliminar chat/i }));

    expect(await screen.findByText(/Se borrarán permanentemente todos los mensajes/i)).toBeTruthy();
    expect(apiDeleteMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Eliminar chat$/i }));

    await waitFor(() => {
      expect(apiDeleteMock).toHaveBeenCalledWith('/api/consultations/cons-finished-1/messages');
      expect(screen.queryByTestId('vet-chat-more-cons-finished-1')).toBeNull();
    });
    expect(window.localStorage.getItem('huellicam_chat_cons-finished-1')).toBeNull();
  });

  it('separates active/follow-up patients from finished historical patients in PatientsPage', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <VetProvider forceEmpty={false}>
          <PatientsPage />
        </VetProvider>
      </QueryClientProvider>
    );

    expect(await screen.findAllByText('Princesa')).toBeTruthy();
    expect(screen.queryByText('Rocko')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Historial de atendidos/i }));
    expect(await screen.findAllByText('Rocko')).toBeTruthy();
    expect(screen.queryByText('Princesa')).toBeNull();
  });

  it('cancels a follow-up and opens Nuevo seguimiento modal in FollowUpsPage', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <VetProvider forceEmpty={false}>
          <FollowUpsPage />
        </VetProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Control respiratorio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Abrir seguimiento/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancelar seguimiento/i }));

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/scheduling/follow-ups/fu-ov-1', {
        status: 'CANCELLED',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /Nuevo seguimiento/i }));
    expect(await screen.findByText(/Nuevo seguimiento clínico/i)).toBeTruthy();
  });

  it('renders 4-card KPI dashboard and movements table in VetEarningsPage', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <VetEarningsPage />
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Honorarios/i)).toBeTruthy();
    expect(await screen.findByText(/Consultas liquidables/i)).toBeTruthy();
    expect(screen.getByText(/Desglose de honorarios/i)).toBeTruthy();
    expect(screen.getByText(/SIMULATED_PAGOFLEX_PREP/i)).toBeTruthy();
    expect(screen.getAllByText(/Consulta #cons-123/i).length).toBeGreaterThan(0);
  });
});
