import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
});
