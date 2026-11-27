import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type ListenerFn = (...args: unknown[]) => void;

const { mockState, apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  mockState: {
    user: {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Lucia',
      lastName: 'Perez',
      role: 'CLIENT' as 'CLIENT' | 'VET' | 'ADMIN',
      licenseNumber: 'MP-999',
    },
    logoutMock: vi.fn().mockResolvedValue(undefined),
    socketListeners: new Map<string, Set<ListenerFn>>(),
  },
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

const mockSocket = {
  connected: true,
  on: vi.fn((evt: string, fn: ListenerFn) => {
    if (!mockState.socketListeners.has(evt)) mockState.socketListeners.set(evt, new Set());
    mockState.socketListeners.get(evt)!.add(fn);
  }),
  off: vi.fn((evt: string, fn?: ListenerFn) => {
    if (!fn) mockState.socketListeners.delete(evt);
    else mockState.socketListeners.get(evt)?.delete(fn);
  }),
  emit: vi.fn(),
};

function triggerSocket(evt: string, ...args: unknown[]) {
  mockState.socketListeners.get(evt)?.forEach((fn) => fn(...args));
}

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    defaults: { baseURL: 'http://localhost:3001' },
  },
  setAccessToken: vi.fn(),
  getAccessToken: () => 'jwt-token',
  getDeviceId: () => 'device-1234',
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({
    socket: mockSocket,
    isConnected: true,
    reconnectingConsultations: {},
    joinConsultation: vi.fn(),
    leaveConsultation: vi.fn(),
    emitEvent: vi.fn(),
  }),
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children?: React.ReactNode }) => <div data-testid="lk-room">{children}</div>,
  VideoConference: () => null,
  useLocalParticipant: () => ({ localParticipant: null }),
}));
vi.mock('@livekit/components-styles', () => ({}));

import ClientApp, { AppointmentsPage, MessagesPage, TriageResult } from '../pages/ClientApp';
import VetApp from '../vet/VetApp';
import AdminApp from '../pages/AdminApp';
import PrescriptionView from '../pages/PrescriptionView';
import CallRoom from '../vet/CallRoom';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { AuthenticatedMediaImage, downloadAuthenticatedMedia } from '../lib/authenticatedMedia';

describe('Web audit remediation regressions (Phases 1-3)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockState.socketListeners.clear();
    localStorage.clear();
    sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Lucia',
      lastName: 'Perez',
      role: 'CLIENT',
      licenseNumber: 'MP-999',
    };
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    apiGetMock.mockResolvedValue({ data: { success: true, data: [] } });
    apiPostMock.mockResolvedValue({ data: { success: true, data: {} } });
    apiPatchMock.mockResolvedValue({ data: { success: true, data: {} } });
  });

  it('calls PATCH /api/consultations/:id/cancel from AppointmentsCalendar instead of /status', async () => {
    const today = new Date();
    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: mockState.user } } };
      if (url === '/api/pets') return { data: { success: true, data: [{ id: 'p1', name: 'Toby', species: 'Perro', createdAt: today.toISOString() }] } };
      if (url === '/api/consultations/mine') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'c-cal-1',
                status: 'WAITING',
                notes: 'Control general',
                startedAt: today.toISOString(),
                createdAt: today.toISOString(),
                pet: { id: 'p1', name: 'Toby', species: 'Perro' },
              },
            ],
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppointmentsPage />
        </AuthProvider>
      </QueryClientProvider>
    );

    const cancelBtn = await screen.findByText('Cancelar turno');
    fireEvent.click(cancelBtn);
    const confirmCancelBtn = await screen.findByRole('button', { name: 'Cancelar consulta' });
    fireEvent.click(confirmCancelBtn);

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/consultations/c-cal-1/cancel', {
        reason: 'Cancelado desde la agenda del tutor',
      });
    });
  });

  it('clears queryClient cache and per-account localStorage keys while preserving huellicam_device_id in clearSession()', async () => {
    localStorage.setItem('huellicam_device_id', 'dev-persist-999');
    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    localStorage.setItem('huellicam_token', 'tok-123');
    localStorage.setItem('huellicam_vaccines_p1', '[]');
    localStorage.setItem('huellicam_docs_p1', '[]');
    localStorage.setItem('huellicam_chat_c1', '[]');
    localStorage.setItem('huellicam_pet_photo_p1', 'img');
    localStorage.setItem('huellicam_vet_rx', '[]');
    localStorage.setItem('huellicam_new_pet_draft', '{}');

    apiGetMock.mockResolvedValue({ data: { success: true, data: { user: mockState.user } } });
    queryClient.setQueryData(['consultations', 'mine'], [{ id: 'stale' }]);
    const clearSpy = vi.spyOn(queryClient, 'clear');

    const Probe = () => {
      const { clearSession } = useAuth();
      return <button onClick={clearSession}>clear-now</button>;
    };

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByText('clear-now'));

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('huellicam_device_id')).toBe('dev-persist-999');
    expect(localStorage.getItem('huellicam_user')).toBeNull();
    expect(localStorage.getItem('huellicam_token')).toBeNull();
    expect(localStorage.getItem('huellicam_vaccines_p1')).toBeNull();
    expect(localStorage.getItem('huellicam_docs_p1')).toBeNull();
    expect(localStorage.getItem('huellicam_chat_c1')).toBeNull();
    expect(localStorage.getItem('huellicam_pet_photo_p1')).toBeNull();
    expect(localStorage.getItem('huellicam_vet_rx')).toBeNull();
    expect(localStorage.getItem('huellicam_new_pet_draft')).toBeNull();
  });

  it('shows real ErrorState instead of empty state when GET /api/consultations/mine fails in ClientApp and VetApp', async () => {
    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    window.history.pushState({}, '', '/client/consultations');
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: mockState.user } } };
      if (url === '/api/consultations/mine') throw new Error('DB down');
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ClientApp />
        </AuthProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByTestId('consultations-error-state')).toBeTruthy();

    cleanup();
    const vetUser = { ...mockState.user, id: 'vet-1', role: 'VET' as const };
    localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.history.pushState({}, '', '/vet/queue');
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: vetUser } } };
      if (url === '/api/consultations/mine') throw new Error('DB down');
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <VetApp path="/vet/queue" />
        </AuthProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByTestId('vet-consultations-error-state')).toBeTruthy();
  });

  it('does not open ReviewModal or show rate button in CallRoom when consultation status is CANCELLED', async () => {
    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    window.history.pushState({}, '', '/call/c-cancelled-1?from=client');
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: mockState.user } } };
      if (url === '/api/consultations/c-cancelled-1') {
        return {
          data: {
            success: true,
            data: { id: 'c-cancelled-1', status: 'CANCELLED', notes: 'Triage' },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <CallRoom id="c-cancelled-1" />
        </AuthProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Consulta cancelada')).toBeTruthy();
    expect(screen.queryByTestId('review-modal')).toBeNull();
    expect(screen.queryByText(/Calificar atención/i)).toBeNull();
  });

  it('uploads attachment to POST /api/media, persists attachmentUrl, and deduplicates message:new by clientMsgId in MessagesPage', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview');
    URL.revokeObjectURL = vi.fn();

    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: mockState.user } } };
      if (url === '/api/consultations/mine') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'c-msg-1',
                status: 'ACTIVE',
                notes: 'Dermatitis',
                pet: { id: 'p1', name: 'Milo', species: 'Perro' },
              },
            ],
          },
        };
      }
      if (url === '/api/consultations/c-msg-1/messages') {
        return { data: { success: true, data: [] } };
      }
      return { data: { success: true, data: [] } };
    });
    apiPostMock.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url === '/api/media') {
        return { data: { success: true, data: { id: 'media-123' } } };
      }
      if (url === '/api/consultations/c-msg-1/messages') {
        return {
          data: {
            success: true,
            data: {
              id: 'srv-msg-1',
              clientMsgId: body?.clientMsgId,
              consultationId: 'c-msg-1',
              senderId: 'client-1',
              content: body?.content,
              attachmentUrl: body?.attachmentUrl,
              createdAt: new Date().toISOString(),
            },
          },
        };
      }
      return { data: { success: true, data: {} } };
    });

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <MessagesPage />
          </AuthProvider>
        </QueryClientProvider>
      );

      const fileInput = await screen.findByTestId('file-upload-pdf');
      const file = new File(['pdf-bytes'], 'laboratorio.pdf', { type: 'application/pdf' });
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(apiPostMock).toHaveBeenCalledWith('/api/media', expect.any(FormData));
        expect(apiPostMock).toHaveBeenCalledWith(
          '/api/consultations/c-msg-1/messages',
          expect.objectContaining({
            content: '📎 Adjunto: laboratorio.pdf',
            attachmentUrl: '/api/media/media-123',
          })
        );
      });

      const sentPayload = apiPostMock.mock.calls.find(([u]) => u === '/api/consultations/c-msg-1/messages')![1] as {
        clientMsgId: string;
      };

      act(() => {
        triggerSocket('message:new', {
          id: 'srv-msg-1',
          clientMsgId: sentPayload.clientMsgId,
          consultationId: 'c-msg-1',
          senderId: 'client-1',
          content: '📎 Adjunto: laboratorio.pdf',
          attachmentUrl: '/api/media/media-123',
          createdAt: new Date().toISOString(),
        });
      });

      expect(screen.getAllByTestId('chat-message-bubble')).toHaveLength(1);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it('fetches protected /api/media/:id via axios blob responseType in AuthenticatedMediaImage and downloadAuthenticatedMedia', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:auth-media');
    URL.revokeObjectURL = vi.fn();
    apiGetMock.mockResolvedValue({ data: new Blob(['img']) });

    try {
      const { unmount } = render(<AuthenticatedMediaImage src="/api/media/med-1" alt="rx" />);

      await waitFor(() => {
        expect(apiGetMock).toHaveBeenCalledWith('/api/media/med-1', {
          responseType: 'blob',
          signal: expect.any(AbortSignal),
        });
        expect((screen.getByAltText('rx') as HTMLImageElement).src).toBe('blob:auth-media');
      });

      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:auth-media');

      await downloadAuthenticatedMedia('/api/media/med-2', 'estudio.pdf');
      expect(apiGetMock).toHaveBeenCalledWith('/api/media/med-2', {
        responseType: 'blob',
        signal: undefined,
      });
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it('submits clean triage payload with real duration and symptom key without [Prioridad:] prefix', async () => {
    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    apiGetMock.mockResolvedValue({ data: { success: true, data: { user: mockState.user } } });
    apiPostMock.mockResolvedValue({ data: { success: true, data: { id: 'c-new-1' } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TriageResult
            evaluation={{
              tier: 'ROJO',
              badge: 'URGENCIA',
              title: 'Atención inmediata',
              description: 'Desc',
              estimate: '2 min',
              isEmergency: true,
              advice: [],
            }}
            symptom="Dificultad para respirar / Asfixia"
            petId="pet-1"
            timeframe="Hace varios días"
            isRoutine={false}
            onRestart={vi.fn()}
          />
        </AuthProvider>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Conectar|Videoconsulta|Hablar/i }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/consultations', {
        petId: 'pet-1',
        notes: 'Dificultad para respirar / Asfixia (Hace varios días)',
        symptoms: ['respiratory_distress'],
        duration: 'MORE_THAN_2_DAYS',
      });
    });
  });

  it('does not fallback to pets[0] in PetDetail when id is unknown and passes pet + sig in PrescriptionView', async () => {
    localStorage.setItem('huellicam_user', JSON.stringify(mockState.user));
    window.history.pushState({}, '', '/client/pets/non-existent-pet');
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: mockState.user } } };
      if (url === '/api/pets') {
        return {
          data: {
            success: true,
            data: [{ id: 'p1', name: 'Firulais', species: 'Perro', sex: 'Hembra', createdAt: new Date().toISOString() }],
          },
        };
      }
      if (url === '/api/prescriptions/rx-1') {
        return {
          data: {
            success: true,
            data: {
              id: 'rx-1',
              consultationId: 'c1',
              vetId: 'v1',
              medication: 'Amoxicilina',
              dosage: '10 mg',
              frequency: '12h',
              durationDays: 7,
              indications: 'Con alimento',
              createdAt: new Date().toISOString(),
              consultation: {
                pet: {
                  id: 'p1',
                  name: 'Firulais',
                  species: 'Perro',
                  breed: 'Mestizo',
                  weightKg: 12,
                  ownerId: 'client-1',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              },
            },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ClientApp />
        </AuthProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Mascota no encontrada')).toBeTruthy();

    cleanup();
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/prescriptions/rx-1?sig=hmac-abc']}>
            <Routes>
              <Route path="/prescriptions/:id" element={<PrescriptionView />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByTestId('prescription-patient-info')).toBeTruthy();
    expect(screen.getByTestId('prescription-pet-name').textContent).toBe('Firulais');
    expect(apiGetMock).toHaveBeenCalledWith('/api/prescriptions/rx-1', { params: { sig: 'hmac-abc' } });
  });

  it('avoids duplicate revoke-sessions call on AdminApp handleConfirmBan and refreshes executive metrics', async () => {
    const adminUser = { ...mockState.user, id: 'admin-1', role: 'ADMIN' as const };
    localStorage.setItem('huellicam_user', JSON.stringify(adminUser));
    window.history.pushState({}, '', '/admin/users');
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: adminUser } } };
      if (url === '/api/admin/stats') {
        return {
          data: {
            success: true,
            data: { totalUsers: 1, totalPets: 0, totalConsultations: 0, pendingVetsCount: 0, activeCallsCount: 0 },
          },
        };
      }
      if (url === '/api/admin/users?includeDeleted=true') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'u-ban-1',
                firstName: 'Carlos',
                lastName: 'Lopez',
                email: 'carlos@test.com',
                role: 'CLIENT',
                deletedAt: null,
              },
            ],
          },
        };
      }
      if (url === '/api/admin/executive-metrics') {
        return {
          data: {
            success: true,
            data: {
              gmvTotal: 0,
              netCommission: 0,
              noShowLostRevenue: 0,
              triageToPaidConversionRate: 0,
              counts: { totalConsultations: 0, completed: 0, cancelledOrNoShow: 0, waitingOrActive: 0 },
            },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/admin/users']}>
            <AdminApp />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );

    const banTrigger = await screen.findByTitle('Banear / Suspender Permanentemente');
    fireEvent.click(banTrigger);
    const confirmBanBtn = await screen.findByRole('button', { name: /Confirmar Baneo Definitivo/i });
    fireEvent.click(confirmBanBtn);

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/admin/users/u-ban-1/ban', expect.any(Object));
    });
    const revokeCalls = apiPostMock.mock.calls.filter(([u]) => String(u).includes('/revoke-sessions'));
    expect(revokeCalls).toHaveLength(0);
    expect(apiGetMock).toHaveBeenCalledWith('/api/admin/executive-metrics');
  });

  it('aborts chat attachment and vet avatar save without fallback payload when POST /api/media fails, and blocks NewPrescription on WAITING consultations', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:vet-preview');
    URL.revokeObjectURL = vi.fn();

    const vetUser = { ...mockState.user, id: 'vet-1', role: 'VET' as const };
    localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.history.pushState({}, '', '/vet/profile');

    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { data: { success: true, data: { user: vetUser } } };
      if (url === '/api/consultations/mine') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'c-wait-rx',
                status: 'WAITING',
                petId: 'p-rx-1',
                notes: 'Control',
                pet: { id: 'p-rx-1', name: 'Rocky', species: 'Perro', breed: 'Mestizo' },
                client: { firstName: 'Ana', lastName: 'Sol' },
              },
            ],
          },
        };
      }
      if (url === '/api/consultations/c-wait-rx') {
        return {
          data: {
            success: true,
            data: {
              id: 'c-wait-rx',
              status: 'ACTIVE',
              vetId: 'vet-1',
              petId: 'p-rx-1',
              notes: 'Control',
              pet: { id: 'p-rx-1', name: 'Rocky', species: 'Perro' },
              client: { firstName: 'Ana', lastName: 'Sol' },
            },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/api/media') throw new Error('429 quota');
      return { data: { success: true, data: {} } };
    });

    try {
      const { container } = render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <VetApp path="/vet/profile" />
          </AuthProvider>
        </QueryClientProvider>
      );

      const avatarInput = await screen.findByLabelText(/Subir foto obligatoria|Cambiar foto/i);
      const avatarFile = new File(['img'], 'avatar.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.change(avatarInput, { target: { files: [avatarFile] } });
        await Promise.resolve();
      });

      const profilePatchCalls = apiPatchMock.mock.calls.filter(
        ([u, body]) =>
          u === '/api/users/profile' &&
          Boolean(body) &&
          typeof body === 'object' &&
          'photoUrl' in (body as Record<string, unknown>)
      );
      expect(profilePatchCalls).toHaveLength(0);

      cleanup();
      window.history.pushState({}, '', '/vet/prescriptions/new?pet=p-rx-1');
      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <VetApp path="/vet/prescriptions/new" />
          </AuthProvider>
        </QueryClientProvider>
      );

      fireEvent.change(await screen.findByPlaceholderText(/Meloxicam/i), { target: { value: 'Cefalexina' } });
      fireEvent.change(screen.getByPlaceholderText(/0,2 ml/i), { target: { value: '1 comp' } });
      fireEvent.change(screen.getByPlaceholderText(/Cada 12 horas/i), { target: { value: 'Cada 12h' } });
      fireEvent.change(screen.getByPlaceholderText(/5 días/i), { target: { value: '7 días' } });

      fireEvent.click(screen.getByRole('button', { name: /Emitir receta/i }));
      fireEvent.click(await screen.findByRole('button', { name: /Confirmar emisión/i }));

      await waitFor(() => {
        expect(screen.getByText(/necesitás una consulta activa o finalizada/i)).toBeTruthy();
      });
      const rxPostCalls = apiPostMock.mock.calls.filter(([u]) => String(u).includes('/prescriptions'));
      expect(rxPostCalls).toHaveLength(0);

      cleanup();
      window.history.pushState({}, '', '/call/c-wait-rx');
      const callRender = render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <CallRoom id="c-wait-rx" />
          </AuthProvider>
        </QueryClientProvider>
      );

      const chatTabBtn = await screen.findByRole('button', { name: /Chat/i });
      fireEvent.click(chatTabBtn);

      const attachInput = await waitFor(
        () => callRender.container.querySelector('[data-testid="file-upload-pdf"]') as HTMLInputElement
      );
      expect(attachInput).toBeTruthy();
      const docFile = new File(['pdf'], 'estudio.pdf', { type: 'application/pdf' });
      await act(async () => {
        fireEvent.change(attachInput, { target: { files: [docFile] } });
        await Promise.resolve();
      });

      const msgPostCalls = apiPostMock.mock.calls.filter(([u]) => String(u).endsWith('/messages'));
      expect(msgPostCalls).toHaveLength(0);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});
