import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type ListenerFn = (...args: unknown[]) => void;

interface MockSocket {
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  __trigger: (event: string, ...args: unknown[]) => void;
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Set<ListenerFn>>();
  const sock: MockSocket = {
    connected: false,
    on: vi.fn((event: string, fn: ListenerFn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return sock;
    }),
    off: vi.fn((event: string, fn?: ListenerFn) => {
      if (!fn) listeners.delete(event);
      else listeners.get(event)?.delete(fn);
      return sock;
    }),
    emit: vi.fn(),
    __trigger: (event: string, ...args: unknown[]) => {
      if (event === 'connect') sock.connected = true;
      if (event === 'disconnect') sock.connected = false;
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
  };
  return sock;
}

const { mockState, apiGetMock, apiPostMock, apiPatchMock, ioMock } = vi.hoisted(() => ({
  mockState: {
    user: {
      id: 'client-1',
      role: 'CLIENT' as 'CLIENT' | 'VET',
      firstName: 'Tobias',
      lastName: 'Vera',
    },
    socket: null as MockSocket | null,
    consultationStatus: 'ACTIVE' as string,
    consultationUpdatedAt: '2026-11-21T10:00:00Z',
    emitEvent: vi.fn(() => true),
    joinConsultation: vi.fn(),
    leaveConsultation: vi.fn(),
    lastOnDisconnected: undefined as ((reason?: unknown) => void) | undefined,
  },
  apiGetMock: vi.fn(async (url: string) => {
    if (url.startsWith('/api/consultations/') && url !== '/api/consultations/mine') {
      if (url.endsWith('/messages')) {
        return { data: { success: true, data: [] } };
      }
      const consultId = url.replace('/api/consultations/', '');
      return {
        data: {
          success: true,
          data: {
            id: consultId,
            petId: 'p1',
            status: mockState.consultationStatus,
            updatedAt: mockState.consultationUpdatedAt,
            pet: { id: 'p1', name: 'Milo', species: 'Canino' },
            client: { firstName: 'Tobias', lastName: 'Vera' },
            vet: { firstName: 'Ana', lastName: 'Gomez' },
            notes: 'Control general',
          },
        },
      };
    }
    return { data: { success: true, data: [] } };
  }),
  apiPostMock: vi.fn(async (url: string, _body?: unknown) => {
    if (url.includes('/token')) {
      return { data: { success: true, data: { token: 'lk-token', wsUrl: 'wss://lk.test' } } };
    }
    return { data: { success: false } };
  }),
  apiPatchMock: vi.fn().mockResolvedValue({ data: { success: true, data: {} } }),
  ioMock: vi.fn(),
}));

vi.mock('../services/api', () => ({
  default: {
    get: (url: string) => apiGetMock(url),
    post: (...args: unknown[]) => apiPostMock(...(args as [string, unknown?])),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    defaults: { baseURL: '' },
  },
  getAccessToken: () => 'tok',
  getDeviceId: () => 'dev',
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockState.user }),
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({
    socket: mockState.socket,
    isConnected: Boolean(mockState.socket?.connected),
    joinConsultation: mockState.joinConsultation,
    leaveConsultation: mockState.leaveConsultation,
    emitEvent: mockState.emitEvent,
  }),
}));

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => {
    ioMock(...args);
    return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() };
  },
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ onDisconnected }: { onDisconnected?: (reason?: unknown) => void }) => {
    mockState.lastOnDisconnected = onDisconnected;
    return <div data-testid="lk-room" />;
  },
  VideoConference: () => null,
  useLocalParticipant: () => ({ localParticipant: null }),
}));

vi.mock('@livekit/components-styles', () => ({}));
vi.mock('../components/ui/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../vet/Consultations', () => ({
  EvolutionEditor: () => null,
  FichaClinica: () => null,
}));

import CallRoom from '../vet/CallRoom';
import { VetProvider } from '../vet/vetkit';

describe('vet/CallRoom CLIENT role isolation & handleFinalize singleton socket emit', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mockState.user = {
      id: 'client-1',
      role: 'CLIENT',
      firstName: 'Tobias',
      lastName: 'Vera',
    };
    mockState.socket = null;
    mockState.consultationStatus = 'ACTIVE';
    mockState.consultationUpdatedAt = '2026-11-21T10:00:00Z';
    window.history.pushState({}, '', '/call/consult-client-1?from=client');
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  it('never fires /api/consultations/mine, /api/prescriptions, or /api/users/profile when user is CLIENT in CallRoom', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="consult-client-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/consultations/consult-client-1');
    });

    const getUrls = apiGetMock.mock.calls.map(([url]) => url);
    expect(getUrls).not.toContain('/api/consultations/mine');
    expect(getUrls).not.toContain('/api/prescriptions');

    const profilePatchCalls = apiPatchMock.mock.calls.filter(([url]) => url === '/api/users/profile');
    expect(profilePatchCalls).toHaveLength(0);
  });

  it('still loads /api/consultations/mine for VET users in VetProvider when forceEmpty is false', async () => {
    mockState.user = {
      id: 'vet-1',
      role: 'VET',
      firstName: 'Ana',
      lastName: 'Gomez',
    };

    render(
      <QueryClientProvider client={queryClient}>
        <VetProvider forceEmpty={false}>
          <div />
        </VetProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/consultations/mine');
    });
  });

  it('emits call:ended via useSocket().emitEvent on handleFinalize without creating an ephemeral io() socket', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="consult-client-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Finalizar')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Finalizar'));
    const confirmBtn = await screen.findByText('Finalizar llamada');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/consultations/consult-client-1/complete', {
        diagnosisNotes: 'Consulta finalizada por el tutor.',
      });
    });

    expect(mockState.emitEvent).toHaveBeenCalledWith('call:ended', {
      consultationId: 'consult-client-1',
    });
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('stays in ended state ("Consulta finalizada") after call:ended even if consultation refetch still returns ACTIVE', async () => {
    const sock = createMockSocket();
    sock.connected = true;
    mockState.socket = sock;

    render(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="consult-client-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('lk-room')).toBeTruthy();
    });

    // Update consultation payload field (e.g. updatedAt) while status remains ACTIVE to simulate stale DB refetch race
    mockState.consultationUpdatedAt = '2026-11-21T10:05:00Z';

    await act(async () => {
      sock.__trigger('call:ended', { consultationId: 'consult-client-1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Consulta finalizada')).toBeTruthy();
    });

    // Ensure subsequent refetch returning ACTIVE does not snap back to LiveKitRoom
    await waitFor(() => {
      expect(apiGetMock.mock.calls.filter(([u]) => u === '/api/consultations/consult-client-1').length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.getByText('Consulta finalizada')).toBeTruthy();
    expect(screen.queryByTestId('lk-room')).toBeNull();
  });

  it('invalidates consultation on initial socket connect when WAITING to close handshake race', async () => {
    const sock = createMockSocket();
    sock.connected = false;
    mockState.socket = sock;
    mockState.consultationStatus = 'WAITING';

    render(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="consult-client-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/consultations/consult-client-1');
    });
    expect(screen.queryByTestId('lk-room')).toBeNull();

    // Server transitions consultation to ACTIVE before initial socket 'connect' fires
    mockState.consultationStatus = 'ACTIVE';

    act(() => {
      sock.__trigger('connect');
    });

    await waitFor(() => {
      expect(screen.getByTestId('lk-room')).toBeTruthy();
    });
  });

  it('resets ended state and mounts LiveKitRoom when rerendering CallRoom from an ended id to an ACTIVE id', async () => {
    const sock = createMockSocket();
    sock.connected = true;
    mockState.socket = sock;
    mockState.consultationStatus = 'ACTIVE';

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="c-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('lk-room')).toBeTruthy();
    });

    await act(async () => {
      sock.__trigger('call:ended', { consultationId: 'c-1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Consulta finalizada')).toBeTruthy();
    });

    apiPostMock.mockClear();

    rerender(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="c-2" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.queryByText('Consulta finalizada')).toBeNull();
      expect(apiPostMock).toHaveBeenCalledWith('/api/calls/c-2/token');
      expect(screen.getByTestId('lk-room')).toBeTruthy();
    });
  });

  it('clears 15s disconnectTimerRef on unmount/id-switch so old consultation never fires PATCH /complete', async () => {
    const sock = createMockSocket();
    sock.connected = true;
    mockState.socket = sock;
    mockState.consultationStatus = 'ACTIVE';

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <CallRoom id="c-timer-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('lk-room')).toBeTruthy();
    });
    expect(mockState.lastOnDisconnected).toBeTypeOf('function');

    vi.useFakeTimers();
    try {
      act(() => {
        mockState.lastOnDisconnected?.('transient_network_drop');
      });

      // Switch CallRoom id before the 15s timer fires
      rerender(
        <QueryClientProvider client={queryClient}>
          <CallRoom id="c-timer-2" />
        </QueryClientProvider>
      );

      await act(async () => {
        vi.advanceTimersByTime(16000);
        await Promise.resolve();
        await Promise.resolve();
      });

      const c1CompleteCalls = apiPatchMock.mock.calls.filter(
        ([url]) => url === '/api/consultations/c-timer-1/complete'
      );
      expect(c1CompleteCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts CallChatPanel.handleAttachFile before POST /messages when unmounted mid-/api/media', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-call-doc');
    const defaultPostImpl = apiPostMock.getMockImplementation();

    let resolveMedia!: (val: { data: { success: boolean; data: { id: string; url: string } } }) => void;
    const deferredMedia = new Promise<{ data: { success: boolean; data: { id: string; url: string } } }>(
      (resolve) => {
        resolveMedia = resolve;
      }
    );

    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/api/media') {
        return deferredMedia as unknown as { data: { success: boolean; data: { token: string; wsUrl: string } } };
      }
      if (url.includes('/token')) {
        return { data: { success: true, data: { token: 'lk-token', wsUrl: 'wss://lk.test' } } };
      }
      return { data: { success: false } };
    });

    try {
      const { unmount } = render(
        <QueryClientProvider client={queryClient}>
          <CallRoom id="c-attach-unmount" />
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('file-upload-pdf')).toBeTruthy();
      });

      const file = new File(['pdf'], 'radiografia.pdf', { type: 'application/pdf' });
      fireEvent.change(screen.getByTestId('file-upload-pdf'), { target: { files: [file] } });

      await waitFor(() => {
        expect(apiPostMock).toHaveBeenCalledWith('/api/media', expect.any(FormData));
      });

      // Unmount while /api/media upload is still in-flight
      unmount();

      await act(async () => {
        resolveMedia({ data: { success: true, data: { id: 'med-1', url: '/api/media/med-1' } } });
        await Promise.resolve();
        await Promise.resolve();
      });

      const msgPostCalls = apiPostMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/consultations/c-attach-unmount/messages')
      );
      expect(msgPostCalls).toHaveLength(0);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      if (defaultPostImpl) apiPostMock.mockImplementation(defaultPostImpl);
    }
  });
});
