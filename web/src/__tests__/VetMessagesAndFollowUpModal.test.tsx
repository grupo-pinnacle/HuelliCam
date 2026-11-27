import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn().mockResolvedValue({ data: { success: true, data: {} } });
const apiPatchMock = vi.fn().mockResolvedValue({ data: { success: true } });

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    defaults: { baseURL: 'http://localhost:3001' },
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'vet-1', firstName: 'Doctor', lastName: 'Uno', role: 'VET' },
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
import { ConsultationDetail } from '../vet/Consultations';

const backendConsultations = [
  {
    id: 'cons-done',
    clientId: 'client-1',
    vetId: 'vet-1',
    petId: 'pet-done',
    status: 'COMPLETED',
    notes: 'Control dermatológico',
    createdAt: '2026-11-27T15:00:00.000Z',
    startedAt: '2026-11-27T15:05:00.000Z',
    pet: { id: 'pet-done', ownerId: 'client-1', name: 'Milo', species: 'Perro', breed: 'Golden', createdAt: '2026-11-27T15:00:00.000Z', updatedAt: '2026-11-27T15:00:00.000Z' },
    client: { id: 'client-1', firstName: 'Iara', lastName: 'Bouso', email: 'iara@test.com' },
  },
  {
    id: 'cons-active',
    clientId: 'client-2',
    vetId: 'vet-1',
    petId: 'pet-active',
    status: 'ACTIVE',
    notes: 'Dificultad para respirar',
    createdAt: '2026-11-27T15:40:00.000Z',
    startedAt: '2026-11-27T15:41:00.000Z',
    pet: { id: 'pet-active', ownerId: 'client-2', name: 'Princesa', species: 'Perro', breed: 'Pastor Alemán', createdAt: '2026-11-27T15:40:00.000Z', updatedAt: '2026-11-27T15:40:00.000Z' },
    client: { id: 'client-2', firstName: 'Tobias', lastName: 'Vera', email: 'tobias@test.com' },
  },
];

describe('Unified Vet Messages & Follow-Up Proposal flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/mine') {
        return { data: { success: true, data: backendConsultations } };
      }
      if (url.includes('/dossier')) {
        return { data: { success: false, data: null } };
      }
      if (url.includes('/slots')) {
        return { data: { success: true, data: { slots: [] } } };
      }
      return { data: { success: true, data: [] } };
    });
  });

  it('Vet MessagesPage uses unified Tutor layout and shows online badge ONLY for Activa consultations (not Finalizada)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <VetProvider forceEmpty={false}>
          <VetMessagesPage />
        </VetProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByTestId('vet-messages-chat-container')).toBeTruthy();
    expect(container.querySelector('.hc-messages-page-wrapper')).toBeTruthy();
    expect(container.querySelector('.hc-chat-hero')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Todos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'En curso' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finalizadas' })).toBeTruthy();

    // First selected consultation is cons-done (Finalizada): must show "Estado: Finalizada", NOT fake "En línea"
    expect(await screen.findByText(/Estado: Finalizada/)).toBeTruthy();
    expect(screen.queryByText(/^En línea\s*·/)).toBeNull();

    // Only 1 conversation is Activa -> exactly 1 online dot across the list
    const onlineDots = container.querySelectorAll('.wa-online-badge');
    expect(onlineDots).toHaveLength(1);
  });

  it('Programar seguimiento opens proposal modal first and posts only after vet picks date/time and confirms', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <VetProvider forceEmpty={false}>
          <ConsultationDetail id="cons-done" />
        </VetProvider>
      </QueryClientProvider>
    );

    const followUpBtn = await screen.findByRole('button', { name: /Programar seguimiento/i });
    fireEvent.click(followUpBtn);

    // Must NOT auto-create immediately on click
    expect(apiPostMock).not.toHaveBeenCalled();

    expect(await screen.findByText('Proponer seguimiento al tutor')).toBeTruthy();
    const confirmBtn = screen.getByRole('button', { name: 'Enviar propuesta' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/scheduling/follow-ups',
        expect.objectContaining({
          petId: 'pet-done',
          consultationId: 'cons-done',
          title: 'Control: Control dermatológico',
        })
      );
    });
  });
});
