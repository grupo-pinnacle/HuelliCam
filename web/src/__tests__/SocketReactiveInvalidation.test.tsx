import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

type ListenerFn = (...args: unknown[]) => void;

interface MockSocket {
  connected: boolean;
  auth: Record<string, unknown>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
  __trigger: (event: string, ...args: unknown[]) => void;
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Set<ListenerFn>>();
  const sock: MockSocket = {
    connected: false,
    auth: {},
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
    disconnect: vi.fn(() => {
      sock.connected = false;
    }),
    removeAllListeners: vi.fn(() => listeners.clear()),
    io: { on: vi.fn(), off: vi.fn() },
    __trigger: (event: string, ...args: unknown[]) => {
      if (event === 'connect') sock.connected = true;
      if (event === 'disconnect') sock.connected = false;
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
  };
  return sock;
}

const { mockState } = vi.hoisted(() => ({
  mockState: {
    socket: null as MockSocket | null,
    user: {
      id: 'vet-1',
      email: 'vet@huellicam.com',
      firstName: 'Ana',
      lastName: 'Gomez',
      role: 'VET' as 'VET' | 'CLIENT',
    },
    consultationStatus: 'WAITING' as string,
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    mockState.socket = createMockSocket();
    return mockState.socket;
  }),
}));

interface MockApiResponse {
  data: {
    success: boolean;
    data?: unknown;
  };
}

const defaultApiGetImpl = async (url: string): Promise<MockApiResponse> => {
  if (url.includes('/api/consultations/c-react-1/messages')) {
    return { data: { success: true, data: [] } };
  }
  if (url.includes('/api/consultations/c-react-1')) {
    return {
      data: {
        success: true,
        data: {
          id: 'c-react-1',
          status: mockState.consultationStatus,
          pet: { id: 'p1', name: 'Milo', species: 'Canino' },
        },
      },
    };
  }
  return { data: { success: true, data: [] } };
};

const defaultApiPostImpl = async (url: string, _body?: unknown): Promise<MockApiResponse> => {
  if (url.includes('/token')) {
    return { data: { success: true, data: { token: 'lk-token', wsUrl: 'wss://lk.test' } } };
  }
  return { data: { success: true, data: {} } };
};

const apiGetMock = vi.fn<(url: string, config?: unknown) => Promise<MockApiResponse>>(defaultApiGetImpl);
const apiPostMock = vi.fn<(url: string, body?: unknown) => Promise<MockApiResponse>>(defaultApiPostImpl);
const apiPatchMock = vi.fn<(url: string, body?: unknown) => Promise<MockApiResponse>>(async () => ({
  data: { success: true, data: {} },
}));

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...(args as [string, unknown?])),
    post: (...args: unknown[]) => apiPostMock(...(args as [string, unknown?])),
    patch: (...args: unknown[]) => apiPatchMock(...(args as [string, unknown?])),
    defaults: { baseURL: '' },
  },
  getAccessToken: () => 'jwt-token',
  getDeviceId: () => 'dev-1',
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockState.user,
    loading: false,
    refreshSession: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children, token }: { children?: React.ReactNode; token?: string }) => (
    <div data-testid="lk-room" data-token={token}>
      {children}
    </div>
  ),
  VideoConference: () => <div data-testid="lk-vc" />,
  useLocalParticipant: () => ({ localParticipant: null }),
}));

vi.mock('@livekit/components-styles', () => ({}));

import { SocketProvider } from '../context/SocketContext';
import { VetProvider, ChatPanel } from '../vet/vetkit';
import { ConsultationRoom } from '../pages/ConsultationRoom';

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      results.push(...collectTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('Reactive Socket.io invalidation & zero polling verification', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    apiGetMock.mockReset();
    apiGetMock.mockImplementation(defaultApiGetImpl);
    apiPostMock.mockReset();
    apiPostMock.mockImplementation(defaultApiPostImpl);
    apiPatchMock.mockReset();
    apiPatchMock.mockImplementation(async () => ({ data: { success: true, data: {} } }));
    Element.prototype.scrollIntoView = vi.fn();
    mockState.socket = null;
    mockState.user = {
      id: 'vet-1',
      email: 'vet@huellicam.com',
      firstName: 'Ana',
      lastName: 'Gomez',
      role: 'VET',
    };
    mockState.consultationStatus = 'WAITING';
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has zero refetchInterval / POLLING_INTERVAL_MS and only one io() module in web/src', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const files = collectTsFiles(srcRoot);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content, `Polling found in ${file}`).not.toMatch(/refetchInterval|POLLING_INTERVAL_MS/);

      const rel = path.relative(srcRoot, file).replace(/\\/g, '/');
      if (rel !== 'context/SocketContext.tsx') {
        expect(content, `Direct socket.io-client import in ${rel}`).not.toMatch(/from\s+['"]socket\.io-client['"]/);
        expect(content, `Direct io() call in ${rel}`).not.toMatch(/\bio\(/);
      }
    }
  });

  it('invalidates expected TanStack Query keys for all 7 reactive Socket.io contract events', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <div />
        </SocketProvider>
      </QueryClientProvider>
    );

    const sock = mockState.socket!;
    expect(sock).toBeTruthy();

    act(() => {
      sock.__trigger('consultation:new', { id: 'c-new' });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations', 'vet'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'], exact: true });

    invalidateSpy.mockClear();
    act(() => {
      sock.__trigger('consultation:assigned', {
        consultationId: 'c1',
        vetId: 'v1',
        clientId: 'u1',
        status: 'ACTIVE',
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultation', 'c1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations', 'vet'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations', 'mine'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'], exact: true });

    invalidateSpy.mockClear();
    act(() => {
      sock.__trigger('consultation:cancelled', {
        consultationId: 'c1',
        cancelledBy: 'u1',
        status: 'CANCELLED',
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultation', 'c1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations', 'vet'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations', 'mine'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'], exact: true });

    invalidateSpy.mockClear();
    act(() => {
      sock.__trigger('call:ended', { consultationId: 'c1', endedBy: 'v1' });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultation', 'c1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'] });

    invalidateSpy.mockClear();
    act(() => {
      sock.__trigger('notification:new', {
        id: 'n1',
        type: 'CONSULTATION_ASSIGNED',
        metadata: { consultationId: 'c2' },
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notifications'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultation', 'c2'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations', 'mine'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'], exact: true });

    invalidateSpy.mockClear();
    act(() => {
      sock.__trigger('prescription:new', {
        consultationId: 'c1',
        prescriptionId: 'rx1',
        petId: 'p1',
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prescriptions'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultation', 'c1'] });

    invalidateSpy.mockClear();
    act(() => {
      sock.__trigger('vet:presence', {
        vetId: 'v1',
        isOnline: true,
        lastSeen: '2026-11-18T20:00:00Z',
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'] });
  });

  it('does not poll /api/consultations/mine over 15s when VetProvider is mounted', async () => {
    vi.useFakeTimers();

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <VetProvider forceEmpty={false}>
            <div />
          </VetProvider>
        </SocketProvider>
      </QueryClientProvider>
    );

    // Flush initial queries
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/consultations/mine',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    apiGetMock.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });

    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('transitions ConsultationRoom from waiting -> active -> completed reactively via socket events without polling', async () => {
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c-react-1']}>
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    const sock = mockState.socket!;
    act(() => {
      sock.__trigger('connect');
    });

    mockState.consultationStatus = 'ACTIVE';
    act(() => {
      sock.__trigger('consultation:assigned', { consultationId: 'c-react-1', status: 'ACTIVE' });
    });

    await waitFor(() => {
      expect(screen.getByText(/Consulta Médica #c-react-/i)).toBeTruthy();
    });

    act(() => {
      sock.__trigger('call:ended', { consultationId: 'c-react-1' });
    });

    await waitFor(() => {
      expect(screen.getByText('Consulta Finalizada')).toBeTruthy();
    });
  });

  it('does not emit leave:consultation churn when ConsultationRoom transitions waiting -> active', async () => {
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c-react-1']}>
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    const sock = mockState.socket!;
    act(() => {
      sock.__trigger('connect');
    });

    expect(sock.emit.mock.calls.filter(([evt]) => evt === 'join:consultation')).toHaveLength(1);
    expect(sock.emit.mock.calls.filter(([evt]) => evt === 'leave:consultation')).toHaveLength(0);

    mockState.consultationStatus = 'ACTIVE';
    act(() => {
      sock.__trigger('consultation:assigned', { consultationId: 'c-react-1', status: 'ACTIVE' });
    });

    await waitFor(() => {
      expect(screen.getByText(/Consulta Médica #c-react-/i)).toBeTruthy();
    });

    expect(sock.emit.mock.calls.filter(([evt]) => evt === 'join:consultation')).toHaveLength(1);
    expect(sock.emit.mock.calls.filter(([evt]) => evt === 'leave:consultation')).toHaveLength(0);
  });

  it('syncs ConsultationRoom from waiting to active on initial socket connect after handshake transition', async () => {
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c-react-1']}>
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    // Consultation becomes ACTIVE on server while socket is still handshaking (before initial 'connect')
    mockState.consultationStatus = 'ACTIVE';
    const sock = mockState.socket!;
    expect(sock.connected).toBe(false);

    act(() => {
      sock.__trigger('connect');
    });

    await waitFor(() => {
      expect(screen.getByText(/Consulta Médica #c-react-/i)).toBeTruthy();
    });
    expect(apiPostMock).toHaveBeenCalledWith('/api/calls/c-react-1/token');
  });

  it('ignores unrelated notification:new without consultationId and avoids redundant token fetches while ACTIVE', async () => {
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };
    mockState.consultationStatus = 'ACTIVE';

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c-react-1']}>
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Consulta Médica #c-react-/i)).toBeTruthy();
    });

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    apiPostMock.mockClear();
    apiPostMock.mockRejectedValueOnce(new Error('Should not refetch token while active'));

    const sock = mockState.socket!;
    await act(async () => {
      sock.__trigger('connect');
      sock.__trigger('notification:new', { id: 'n-unrelated', type: 'GENERAL_INFO' });
      sock.__trigger('notification:new', {
        id: 'n-other',
        type: 'CONSULTATION_ASSIGNED',
        metadata: { consultationId: 'other-consult' },
      });
      sock.__trigger('consultation:assigned', { consultationId: 'c-react-1', status: 'ACTIVE' });
      sock.__trigger('disconnect');
      sock.__trigger('connect');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Error de Conexión')).toBeNull();
    expect(screen.getByText(/Consulta Médica #c-react-/i)).toBeTruthy();
  });

  it('keeps ConsultationRoom on Consulta Finalizada when call:ended arrives while fetchToken() is in-flight', async () => {
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };
    mockState.consultationStatus = 'WAITING';

    let resolveToken!: (value: { data: { success: boolean; data: { token: string; wsUrl: string } } }) => void;
    const deferredToken = new Promise<{ data: { success: boolean; data: { token: string; wsUrl: string } } }>(
      (resolve) => {
        resolveToken = resolve;
      }
    );
    apiPostMock.mockImplementationOnce(async () => deferredToken);

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c-react-1']}>
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    const sock = mockState.socket!;
    act(() => {
      sock.__trigger('connect');
    });

    mockState.consultationStatus = 'ACTIVE';
    act(() => {
      sock.__trigger('consultation:assigned', { consultationId: 'c-react-1', status: 'ACTIVE' });
    });

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/calls/c-react-1/token');
    });

    act(() => {
      sock.__trigger('call:ended', { consultationId: 'c-react-1' });
    });

    await waitFor(() => {
      expect(screen.getByText('Consulta Finalizada')).toBeTruthy();
    });

    await act(async () => {
      resolveToken({
        data: { success: true, data: { token: 'lk-late-token', wsUrl: 'wss://lk.test' } },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Consulta Finalizada')).toBeTruthy();
    expect(screen.queryByText(/Consulta Médica #c-react-/i)).toBeNull();
  });

  it('clears prior consultation messages in vetkit ChatPanel when switching c1 -> c2 and c2 fetch rejects', async () => {
    const defaultGetImpl = apiGetMock.getMockImplementation();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c1/messages') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'm-c1-1',
                consultationId: 'c1',
                content: 'Dato confidencial paciente 1',
                senderId: 'tutor-1',
                createdAt: '2026-11-21T10:00:00Z',
              },
            ],
          },
        };
      }
      if (url === '/api/consultations/c2/messages') {
        throw new Error('500 Internal Server Error');
      }
      return { data: { success: true, data: [] } };
    });

    try {
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId="c1" />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Dato confidencial paciente 1')).toBeTruthy();
      });

      rerender(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId="c2" />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(apiGetMock).toHaveBeenCalledWith('/api/consultations/c2/messages');
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByText('Dato confidencial paciente 1')).toBeNull();
    } finally {
      if (defaultGetImpl) {
        apiGetMock.mockImplementation(defaultGetImpl);
      }
    }
  });

  it('deduplicates ChatPanel attachment bubble when message:new arrives before handleAttachFile POST resolves', async () => {
    const defaultGetImpl = apiGetMock.getMockImplementation();
    const defaultPostImpl = apiPostMock.getMockImplementation();
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-doc');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let capturedClientMsgId = '';
    let resolveMsgPost!: (val: {
      data: {
        success: boolean;
        data: {
          id: string;
          consultationId: string;
          clientMsgId: string;
          content: string;
          senderId: string;
          createdAt: string;
        };
      };
    }) => void;
    const deferredMsgPost = new Promise<{
      data: {
        success: boolean;
        data: {
          id: string;
          consultationId: string;
          clientMsgId: string;
          content: string;
          senderId: string;
          createdAt: string;
        };
      };
    }>((resolve) => {
      resolveMsgPost = resolve;
    });

    apiGetMock.mockImplementation(async () => ({ data: { success: true, data: [] } }));
    apiPostMock.mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/api/media') {
        return { data: { success: true, data: { id: 'media-1', url: '/api/media/media-1' } } };
      }
      if (url === '/api/consultations/c-attach-1/messages') {
        capturedClientMsgId = (body as { clientMsgId?: string })?.clientMsgId || '';
        return deferredMsgPost;
      }
      return { data: { success: true, data: {} } };
    });

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId="c-attach-1" />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      const sock = mockState.socket!;
      act(() => {
        sock.__trigger('connect');
      });

      const file = new File(['pdf-bytes'], 'estudio.pdf', { type: 'application/pdf' });
      const fileInput = screen.getByTestId('file-upload-pdf');
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(apiPostMock).toHaveBeenCalledWith(
          '/api/consultations/c-attach-1/messages',
          expect.objectContaining({ content: '📎 Adjunto: estudio.pdf' })
        );
      });

      act(() => {
        sock.__trigger('message:new', {
          id: 'srv-msg-1',
          consultationId: 'c-attach-1',
          clientMsgId: capturedClientMsgId,
          content: '📎 Adjunto: estudio.pdf',
          senderId: 'vet-1',
          createdAt: '2026-11-21T10:01:00Z',
        });
      });

      await waitFor(() => {
        expect(screen.getAllByTestId('chat-message-bubble')).toHaveLength(1);
      });

      await act(async () => {
        resolveMsgPost({
          data: {
            success: true,
            data: {
              id: 'srv-msg-1',
              consultationId: 'c-attach-1',
              clientMsgId: capturedClientMsgId,
              content: '📎 Adjunto: estudio.pdf',
              senderId: 'vet-1',
              createdAt: '2026-11-21T10:01:00Z',
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getAllByTestId('chat-message-bubble')).toHaveLength(1);
      expect(screen.getByText('estudio.pdf')).toBeTruthy();

      const duplicateKeyWarnings = consoleErrorSpy.mock.calls.filter((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('same key'))
      );
      expect(duplicateKeyWarnings).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
      URL.createObjectURL = origCreateObjectURL;
      if (defaultGetImpl) apiGetMock.mockImplementation(defaultGetImpl);
      if (defaultPostImpl) apiPostMock.mockImplementation(defaultPostImpl);
    }
  });

  it('clears ChatPanel messages when activeConsultationId transitions from c1 to undefined with no demo thread', async () => {
    const defaultGetImpl = apiGetMock.getMockImplementation();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c1/messages') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'm-c1-secret',
                consultationId: 'c1',
                content: 'Secreto c1',
                senderId: 'tutor-1',
                createdAt: '2026-11-21T10:00:00Z',
              },
            ],
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    try {
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId="c1" />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Secreto c1')).toBeTruthy();
      });

      rerender(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId={undefined} />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.queryByText('Secreto c1')).toBeNull();
      });
    } finally {
      if (defaultGetImpl) {
        apiGetMock.mockImplementation(defaultGetImpl);
      }
    }
  });

  it('prevents ChatPanel in-flight handleAttachFile and submit from injecting c1 messages into c2 after switching', async () => {
    const defaultGetImpl = apiGetMock.getMockImplementation();
    const defaultPostImpl = apiPostMock.getMockImplementation();
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-doc-c1');

    let resolveC1AttachPost!: (val: MockApiResponse) => void;
    const deferredC1AttachPost = new Promise<MockApiResponse>((resolve) => {
      resolveC1AttachPost = resolve;
    });

    let resolveC1TextPost!: (val: MockApiResponse) => void;
    const deferredC1TextPost = new Promise<MockApiResponse>((resolve) => {
      resolveC1TextPost = resolve;
    });

    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c2/messages') {
        return {
          data: {
            success: true,
            data: [
              {
                id: 'm-c2-existing',
                consultationId: 'c2',
                content: 'Mensaje legitimo c2',
                senderId: 'tutor-2',
                createdAt: '2026-11-21T10:05:00Z',
              },
            ],
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    apiPostMock.mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/api/media') {
        return { data: { success: true, data: { id: 'media-c1', url: '/api/media/media-c1' } } };
      }
      if (url === '/api/consultations/c1/messages') {
        const payload = body as { attachmentUrl?: string };
        if (payload?.attachmentUrl) {
          return deferredC1AttachPost;
        }
        return deferredC1TextPost;
      }
      return { data: { success: true, data: {} } };
    });

    try {
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId="c1" />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      // Start an in-flight text submit (socket disconnected -> HTTP POST fallback) on c1
      const input = screen.getByTestId('chat-message-input');
      fireEvent.change(input, { target: { value: 'Texto privado c1' } });
      fireEvent.click(screen.getByTestId('chat-send-btn'));

      // Start an in-flight file attachment upload+POST on c1
      const file = new File(['pdf-bytes'], 'privado_c1.pdf', { type: 'application/pdf' });
      const fileInput = screen.getByTestId('file-upload-pdf');
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(apiPostMock).toHaveBeenCalledWith(
          '/api/consultations/c1/messages',
          expect.objectContaining({ content: 'Texto privado c1' })
        );
        expect(apiPostMock).toHaveBeenCalledWith(
          '/api/consultations/c1/messages',
          expect.objectContaining({ content: '📎 Adjunto: privado_c1.pdf' })
        );
      });

      // Switch ChatPanel to c2 before either c1 POST resolves
      rerender(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <VetProvider forceEmpty={true}>
              <ChatPanel petId="milo" consultationId="c2" />
            </VetProvider>
          </SocketProvider>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Mensaje legitimo c2')).toBeTruthy();
      });

      // Resolve both in-flight c1 POSTs after switching to c2
      await act(async () => {
        resolveC1TextPost({
          data: {
            success: true,
            data: {
              id: 'srv-c1-text',
              consultationId: 'c1',
              content: 'Texto privado c1',
              senderId: 'vet-1',
              createdAt: '2026-11-21T10:06:00Z',
            },
          },
        });
        resolveC1AttachPost({
          data: {
            success: true,
            data: {
              id: 'srv-c1-file',
              consultationId: 'c1',
              content: '📎 Adjunto: privado_c1.pdf',
              senderId: 'vet-1',
              createdAt: '2026-11-21T10:06:01Z',
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByText('Texto privado c1')).toBeNull();
      expect(screen.queryByText('privado_c1.pdf')).toBeNull();
      expect(screen.getByText('Mensaje legitimo c2')).toBeTruthy();
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      if (defaultGetImpl) apiGetMock.mockImplementation(defaultGetImpl);
      if (defaultPostImpl) apiPostMock.mockImplementation(defaultPostImpl);
    }
  });

  it('transitions ConsultationRoom cleanly from completed c-done to ACTIVE c-next-active on in-place route change', async () => {
    const defaultGetImpl = apiGetMock.getMockImplementation();
    const defaultPostImpl = apiPostMock.getMockImplementation();

    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };

    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c-done') {
        return {
          data: {
            success: true,
            data: {
              id: 'c-done',
              status: 'COMPLETED',
              pet: { id: 'p1', name: 'Milo', species: 'Canino' },
            },
          },
        };
      }
      if (url === '/api/consultations/c-next-active') {
        return {
          data: {
            success: true,
            data: {
              id: 'c-next-active',
              status: 'ACTIVE',
              pet: { id: 'p2', name: 'Luna', species: 'Felino' },
            },
          },
        };
      }
      if (url === '/api/consultations/c-next-active/messages') {
        return { data: { success: true, data: [] } };
      }
      return { data: { success: true, data: [] } };
    });

    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/api/calls/c-next-active/token') {
        return { data: { success: true, data: { token: 'lk-next-active-token', wsUrl: 'wss://lk.test' } } };
      }
      return { data: { success: true, data: {} } };
    });

    function RouteSwitcher({ to }: { to: string }) {
      const navigate = useNavigate();
      return (
        <button type="button" data-testid="switch-consultation-route" onClick={() => navigate(to)}>
          Cambiar consulta
        </button>
      );
    }

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <SocketProvider>
            <MemoryRouter initialEntries={['/call/c-done']}>
              <RouteSwitcher to="/call/c-next-active" />
              <Routes>
                <Route path="/call/:id" element={<ConsultationRoom />} />
              </Routes>
            </MemoryRouter>
          </SocketProvider>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Consulta Finalizada')).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId('switch-consultation-route'));

      await waitFor(() => {
        expect(screen.getByText(/Consulta Médica #c-next-a/i)).toBeTruthy();
      });
      expect(screen.queryByText('Consulta Finalizada')).toBeNull();
      expect(apiPostMock).toHaveBeenCalledWith('/api/calls/c-next-active/token');
    } finally {
      if (defaultGetImpl) apiGetMock.mockImplementation(defaultGetImpl);
      if (defaultPostImpl) apiPostMock.mockImplementation(defaultPostImpl);
    }
  });

  it('T2-F03-02: triggers <= 5 GET /api/consultations/mine requests (forwarding AbortSignal) on 5 consultation:new events after settle', async () => {
    const signals: AbortSignal[] = [];
    const pendingResolvers: Array<(val: MockApiResponse) => void> = [];
    let settledInitial = false;

    apiGetMock.mockImplementation(async (url: string, config?: unknown) => {
      if (url === '/api/consultations/mine') {
        const sig = (config as { signal?: AbortSignal } | undefined)?.signal;
        if (sig) signals.push(sig);
        if (!settledInitial) {
          return { data: { success: true, data: [] } };
        }
        return new Promise<MockApiResponse>((resolve) => {
          pendingResolvers.push(resolve);
        });
      }
      return { data: { success: true, data: [] } };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <VetProvider forceEmpty={false}>
            <div />
          </VetProvider>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      const mineCalls = apiGetMock.mock.calls.filter(([u]) => u === '/api/consultations/mine');
      expect(mineCalls).toHaveLength(1);
    });

    expect(signals.length).toBeGreaterThanOrEqual(1);
    settledInitial = true;
    apiGetMock.mockClear();
    signals.length = 0;

    const sock = mockState.socket!;
    for (let i = 1; i <= 5; i += 1) {
      await act(async () => {
        sock.__trigger('consultation:new', { id: `c-burst-${i}`, pet: { name: `Pet ${i}` } });
        await Promise.resolve();
      });
    }

    const mineCallsAfterBurst = apiGetMock.mock.calls.filter(([u]) => u === '/api/consultations/mine');
    expect(mineCallsAfterBurst.length).toBeLessThanOrEqual(5);
    expect(mineCallsAfterBurst.length).toBeGreaterThanOrEqual(1);
    // Prior superseded in-flight signals must have been aborted by TanStack Query cancelRefetch
    expect(signals.slice(0, -1).every((s) => s.aborted)).toBe(true);
    expect(signals[signals.length - 1]?.aborted).toBe(false);

    await act(async () => {
      while (pendingResolvers.length > 0) {
        pendingResolvers.shift()?.({ data: { success: true, data: [] } });
      }
      await Promise.resolve();
    });
  });

  it('guards ConsultationRoom against ABA (c1 -> c2 -> c1) fetchToken rejection and stale token resolution', async () => {
    mockState.user = {
      id: 'client-1',
      email: 'client@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };

    let rejectStaleC1Token!: (err: Error) => void;
    let resolveStaleC1Token!: (val: MockApiResponse) => void;
    let c1TokenAttempt = 0;
    let rejectMode = true;

    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c1') {
        return {
          data: {
            success: true,
            data: { id: 'c1', status: 'ACTIVE', pet: { id: 'p1', name: 'Milo', species: 'Canino' } },
          },
        };
      }
      if (url === '/api/consultations/c2') {
        return {
          data: {
            success: true,
            data: { id: 'c2', status: 'WAITING', pet: { id: 'p2', name: 'Luna', species: 'Felino' } },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/api/calls/c1/token') {
        c1TokenAttempt += 1;
        if (c1TokenAttempt === 1 || c1TokenAttempt === 3) {
          return new Promise<MockApiResponse>((resolve, reject) => {
            if (rejectMode) {
              rejectStaleC1Token = reject;
            } else {
              resolveStaleC1Token = resolve;
            }
          });
        }
        return { data: { success: true, data: { token: 'lk-c1-fresh', wsUrl: 'wss://lk.test' } } };
      }
      return { data: { success: true, data: {} } };
    });

    function RouteControls() {
      const navigate = useNavigate();
      return (
        <div>
          <button type="button" data-testid="go-c1" onClick={() => navigate('/call/c1')}>
            c1
          </button>
          <button type="button" data-testid="go-c2" onClick={() => navigate('/call/c2')}>
            c2
          </button>
        </div>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c1']}>
            <RouteControls />
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    // Wait for first c1 token request to be in-flight
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/calls/c1/token');
    });

    // Navigate c1 -> c2 (WAITING) -> c1 (ACTIVE)
    fireEvent.click(screen.getByTestId('go-c2'));
    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('go-c1'));
    await waitFor(() => {
      expect(screen.getByText('Ingresar a la Consulta')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Ingresar a la Consulta'));
    await waitFor(() => {
      expect(screen.getByTestId('lk-room').getAttribute('data-token')).toBe('lk-c1-fresh');
    });

    // Stale c1 token #1 rejects -> must NOT crash active c1 to Error de Conexión
    await act(async () => {
      rejectStaleC1Token(new Error('Stale c1 token timeout'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('Error de Conexión')).toBeNull();
    expect(screen.getByTestId('lk-room').getAttribute('data-token')).toBe('lk-c1-fresh');

    // Repeat ABA with stale c1 token resolving to 'lk-c1-stale'
    rejectMode = false;
    fireEvent.click(screen.getByTestId('go-c2'));
    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('go-c1'));
    await waitFor(() => {
      expect(c1TokenAttempt).toBe(3);
    });

    fireEvent.click(screen.getByTestId('go-c2'));
    await waitFor(() => {
      expect(screen.getByText('Sala de Espera Virtual')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('go-c1'));
    await waitFor(() => {
      expect(c1TokenAttempt).toBe(4);
      expect(screen.getByText('Ingresar a la Consulta')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Ingresar a la Consulta'));
    await waitFor(() => {
      expect(screen.getByTestId('lk-room').getAttribute('data-token')).toBe('lk-c1-fresh');
    });

    await act(async () => {
      resolveStaleC1Token({
        data: { success: true, data: { token: 'lk-c1-stale', wsUrl: 'wss://lk.test' } },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('lk-room').getAttribute('data-token')).toBe('lk-c1-fresh');
  });

  it('resets ConsultationRoom uploadingPhoto and isCompleting on c1 -> c2 and prevents c1 finally from clobbering c2', async () => {
    let resolveC1Media!: (val: MockApiResponse) => void;
    let resolveC2Media!: (val: MockApiResponse) => void;
    let resolveC1Complete!: (val: MockApiResponse) => void;
    let resolveC2Complete!: (val: MockApiResponse) => void;
    let mediaCall = 0;

    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c1') {
        return {
          data: {
            success: true,
            data: { id: 'c1', status: 'ACTIVE', pet: { id: 'p1', name: 'Milo', species: 'Canino' } },
          },
        };
      }
      if (url === '/api/consultations/c2') {
        return {
          data: {
            success: true,
            data: { id: 'c2', status: 'ACTIVE', pet: { id: 'p2', name: 'Luna', species: 'Felino' } },
          },
        };
      }
      return { data: { success: true, data: [] } };
    });

    apiPostMock.mockImplementation(async (url: string) => {
      if (url.includes('/token')) {
        return { data: { success: true, data: { token: 'lk-vet-tok', wsUrl: 'wss://lk.test' } } };
      }
      if (url === '/api/media') {
        mediaCall += 1;
        return new Promise<MockApiResponse>((resolve) => {
          if (mediaCall === 1) resolveC1Media = resolve;
          else resolveC2Media = resolve;
        });
      }
      return { data: { success: true, data: {} } };
    });

    apiPatchMock.mockImplementation(async (url: string) => {
      if (url === '/api/consultations/c1/complete') {
        return new Promise<MockApiResponse>((resolve) => {
          resolveC1Complete = resolve;
        });
      }
      if (url === '/api/consultations/c2/complete') {
        return new Promise<MockApiResponse>((resolve) => {
          resolveC2Complete = resolve;
        });
      }
      return { data: { success: true, data: {} } };
    });

    function RouteSwitcher() {
      const navigate = useNavigate();
      return (
        <button type="button" data-testid="switch-c2" onClick={() => navigate('/call/c2')}>
          Ir a c2
        </button>
      );
    }

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter initialEntries={['/call/c1']}>
            <RouteSwitcher />
            <Routes>
              <Route path="/call/:id" element={<ConsultationRoom />} />
            </Routes>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Consulta Médica #c1/i)).toBeTruthy();
    });

    // Start upload and completion on c1
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file1 = new File(['img1'], 'lesion1.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file1] } });

    await waitFor(() => {
      expect(screen.getByText(/Subiendo\.\.\./i)).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('in-call-complete-consultation-btn'));
    const textarea1 = screen.getByPlaceholderText(/Detalle la evolución del paciente/i);
    fireEvent.change(textarea1, { target: { value: 'Evolución c1 en curso' } });
    fireEvent.click(screen.getByText('Confirmar y Completar Consulta'));

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/consultations/c1/complete', {
        diagnosisNotes: 'Evolución c1 en curso',
      });
    });

    // Switch c1 -> c2 mid-upload and mid-complete
    fireEvent.click(screen.getByTestId('switch-c2'));

    await waitFor(() => {
      expect(screen.getByText(/Consulta Médica #c2/i)).toBeTruthy();
    });

    // c2 must NOT inherit uploadingPhoto or isCompleting
    expect(screen.queryByText(/Subiendo\.\.\./i)).toBeNull();
    const chatInputC2 = screen.getByPlaceholderText('Escriba un mensaje...') as HTMLInputElement;
    expect(chatInputC2.disabled).toBe(false);

    // Start upload and completion on c2
    const fileInputC2 = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file2 = new File(['img2'], 'lesion2.png', { type: 'image/png' });
    fireEvent.change(fileInputC2, { target: { files: [file2] } });

    await waitFor(() => {
      expect(screen.getByText(/Subiendo\.\.\./i)).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('in-call-complete-consultation-btn'));
    const textarea2 = screen.getByPlaceholderText(/Detalle la evolución del paciente/i);
    fireEvent.change(textarea2, { target: { value: 'Evolución c2 en curso' } });
    const submitBtnC2 = screen.getByText('Confirmar y Completar Consulta').closest('button') as HTMLButtonElement;
    expect(submitBtnC2.disabled).toBe(false);
    fireEvent.click(submitBtnC2);

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/consultations/c2/complete', {
        diagnosisNotes: 'Evolución c2 en curso',
      });
    });
    expect(submitBtnC2.disabled).toBe(true);

    // Resolve c1's in-flight promises -> c1's finally MUST NOT clobber c2's uploadingPhoto or isCompleting
    await act(async () => {
      resolveC1Media({ data: { success: true, data: { id: 'm1', fileName: 'lesion1.png' } } });
      resolveC1Complete({ data: { success: true, data: {} } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/Subiendo\.\.\./i)).toBeTruthy();
    expect(submitBtnC2.disabled).toBe(true);

    await act(async () => {
      resolveC2Media({ data: { success: true, data: { id: 'm2', fileName: 'lesion2.png' } } });
      resolveC2Complete({ data: { success: true, data: {} } });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
