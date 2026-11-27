import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

type ListenerFn = (...args: unknown[]) => void;

interface MockSocket {
  connected: boolean;
  auth: Record<string, unknown>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  io: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  __trigger: (event: string, ...args: unknown[]) => void;
  __triggerManager: (event: string, ...args: unknown[]) => void;
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Set<ListenerFn>>();
  const managerListeners = new Map<string, Set<ListenerFn>>();

  const sock: MockSocket = {
    connected: false,
    auth: {},
    on: vi.fn((event: string, fn: ListenerFn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return sock;
    }),
    off: vi.fn((event: string, fn?: ListenerFn) => {
      if (!fn) {
        listeners.delete(event);
      } else {
        listeners.get(event)?.delete(fn);
      }
      return sock;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(() => {
      sock.connected = false;
    }),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
    }),
    io: {
      on: vi.fn((event: string, fn: ListenerFn) => {
        if (!managerListeners.has(event)) managerListeners.set(event, new Set());
        managerListeners.get(event)!.add(fn);
      }),
      off: vi.fn((event: string, fn?: ListenerFn) => {
        if (!fn) {
          managerListeners.delete(event);
        } else {
          managerListeners.get(event)?.delete(fn);
        }
      }),
    },
    __trigger: (event: string, ...args: unknown[]) => {
      if (event === 'connect') sock.connected = true;
      if (event === 'disconnect') sock.connected = false;
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
    __triggerManager: (event: string, ...args: unknown[]) => {
      managerListeners.get(event)?.forEach((fn) => fn(...args));
    },
  };

  return sock;
}

const { mockState, ioMock, ringtoneMocks } = vi.hoisted(() => ({
  mockState: {
    socket: null as MockSocket | null,
    token: 'test-jwt-1' as string | null,
    deviceId: 'dev-test-1',
    user: {
      id: 'user-1',
      email: 'vet@huellicam.com',
      firstName: 'Ana',
      lastName: 'Gomez',
      role: 'VET' as const,
    } as {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      role: 'VET' | 'CLIENT' | 'ADMIN';
    } | null,
    loading: false,
    refreshSession: vi.fn().mockResolvedValue(undefined),
  },
  ioMock: vi.fn(),
  ringtoneMocks: {
    startRingtone: vi.fn(),
    stopRingtone: vi.fn(),
  },
}));

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => {
    ioMock(...args);
    mockState.socket = createMockSocket();
    return mockState.socket;
  },
}));

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { success: true, data: [] } }),
    post: vi.fn().mockResolvedValue({ data: { success: true, data: {} } }),
    patch: vi.fn().mockResolvedValue({ data: { success: true, data: {} } }),
  },
  getAccessToken: () => mockState.token,
  getDeviceId: () => mockState.deviceId,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockState.user,
    loading: mockState.loading,
    refreshSession: mockState.refreshSession,
    sessionTerminated: null,
    dismissSessionTerminated: vi.fn(),
    clearSession: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../lib/ringtone', () => ({
  startRingtone: ringtoneMocks.startRingtone,
  stopRingtone: ringtoneMocks.stopRingtone,
}));

import { SocketProvider, useSocket } from '../context/SocketContext';
import { GlobalCallListener } from '../components/call/GlobalCallListener';
import { VetProvider } from '../vet/vetkit';

const RoomSubscriber: React.FC<{ consultationId: string }> = ({ consultationId }) => {
  const { joinConsultation, leaveConsultation, isConnected } = useSocket();
  useEffect(() => {
    joinConsultation(consultationId);
    return () => leaveConsultation(consultationId);
  }, [consultationId, joinConsultation, leaveConsultation]);
  return <span data-testid={`sub-${consultationId}`}>{isConnected ? 'connected' : 'offline'}</span>;
};

const SocketProbe: React.FC = () => {
  const { socket, isConnected, joinConsultation, leaveConsultation, emitEvent } = useSocket();
  return (
    <div>
      <span data-testid="probe-has-socket">{socket ? 'yes' : 'no'}</span>
      <span data-testid="probe-connected">{isConnected ? 'yes' : 'no'}</span>
      <button
        type="button"
        data-testid="probe-emit"
        onClick={() => {
          joinConsultation('c-noop');
          leaveConsultation('c-noop');
          emitEvent('test:ping', { ok: true });
        }}
      >
        Emit
      </button>
    </div>
  );
};

describe('SocketContext singleton lifecycle, ref-counting & session termination', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockState.socket = null;
    mockState.token = 'test-jwt-1';
    mockState.deviceId = 'dev-test-1';
    mockState.user = {
      id: 'user-1',
      email: 'vet@huellicam.com',
      firstName: 'Ana',
      lastName: 'Gomez',
      role: 'VET',
    };
    mockState.loading = false;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  it('creates exactly one io() socket per authenticated tab across multiple consumers and user ref refreshes', () => {
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter>
            <GlobalCallListener />
            <VetProvider forceEmpty={true}>
              <SocketProbe />
            </VetProvider>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        withCredentials: true,
        transports: ['polling', 'websocket'],
        reconnection: true,
        auth: {
          token: 'Bearer test-jwt-1',
          deviceId: 'dev-test-1',
          correlationId: expect.any(String),
        },
      })
    );
    expect(screen.getByTestId('probe-has-socket').textContent).toBe('yes');

    // Simulate visibilitychange refreshSession returning a fresh user object with the same id
    mockState.token = 'test-jwt-2';
    mockState.user = { ...mockState.user! };

    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter>
            <GlobalCallListener />
            <VetProvider forceEmpty={true}>
              <SocketProbe />
            </VetProvider>
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(mockState.socket?.auth).toEqual(
      expect.objectContaining({
        token: 'Bearer test-jwt-2',
        deviceId: 'dev-test-1',
      })
    );
  });

  it('does not connect when unauthenticated and disconnects cleanly on logout', () => {
    mockState.user = null;

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <SocketProbe />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe-has-socket').textContent).toBe('no');

    // Login
    mockState.user = {
      id: 'user-99',
      email: 'tutor@huellicam.com',
      firstName: 'Tobias',
      lastName: 'Vera',
      role: 'CLIENT',
    };

    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <SocketProbe />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    const createdSocket = mockState.socket!;
    act(() => {
      createdSocket.__trigger('connect');
    });
    expect(screen.getByTestId('probe-connected').textContent).toBe('yes');

    // Logout
    mockState.user = null;
    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <SocketProbe />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(createdSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('probe-has-socket').textContent).toBe('no');
    expect(screen.getByTestId('probe-connected').textContent).toBe('no');
  });

  it('ref-counts joinConsultation / leaveConsultation and re-joins + resyncs on reconnect', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <RoomSubscriber consultationId="consult-1" />
          <RoomSubscriber consultationId="consult-1" />
        </SocketProvider>
      </QueryClientProvider>
    );

    const sock = mockState.socket!;
    act(() => {
      sock.__trigger('connect');
    });

    const joinCalls = sock.emit.mock.calls.filter(([evt]) => evt === 'join:consultation');
    expect(joinCalls).toHaveLength(1);
    expect(joinCalls[0][1]).toEqual({ consultationId: 'consult-1' });
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Unmount first subscriber -> ref-count 2 -> 1 (must NOT leave room)
    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <RoomSubscriber consultationId="consult-1" />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(sock.emit.mock.calls.filter(([evt]) => evt === 'leave:consultation')).toHaveLength(0);

    // Simulate disconnect + reconnect while 1 subscriber still active -> re-joins and invalidates
    act(() => {
      sock.__trigger('disconnect');
      sock.__trigger('connect');
    });

    const joinCallsAfterReconnect = sock.emit.mock.calls.filter(([evt]) => evt === 'join:consultation');
    expect(joinCallsAfterReconnect).toHaveLength(2);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultations'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['consultation', 'consult-1'] });

    // Unmount last subscriber -> ref-count 1 -> 0 (MUST emit leave:consultation once)
    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <div />
        </SocketProvider>
      </QueryClientProvider>
    );

    const leaveCalls = sock.emit.mock.calls.filter(([evt]) => evt === 'leave:consultation');
    expect(leaveCalls).toHaveLength(1);
    expect(leaveCalls[0][1]).toEqual({ consultationId: 'consult-1' });
  });

  it('handles session:invalidated and auth:session_terminated centrally and clears GlobalCallListener ringtone', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <MemoryRouter>
            <GlobalCallListener />
          </MemoryRouter>
        </SocketProvider>
      </QueryClientProvider>
    );

    const sock = mockState.socket!;

    act(() => {
      sock.__trigger('call:incoming', {
        consultationId: 'c-inc-1',
        callerName: 'Tobias',
        roomName: 'room-1',
      });
    });

    expect(screen.getByTestId('global-incoming-call-modal')).toBeTruthy();
    expect(ringtoneMocks.startRingtone).toHaveBeenCalledTimes(1);

    act(() => {
      sock.__trigger('session:invalidated', {
        reason: 'SESSION_MIGRATED_NEW_DEVICE',
        message: 'Sesión transferida',
      });
    });

    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(ringtoneMocks.stopRingtone).toHaveBeenCalled();
    expect(screen.queryByTestId('global-incoming-call-modal')).toBeNull();

    const terminatedEvents = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .filter((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === 'huellicam:session_terminated');

    expect(terminatedEvents).toHaveLength(1);
    expect(terminatedEvents[0].detail).toEqual({
      reason: 'SESSION_MIGRATED_NEW_DEVICE',
      message: 'Sesión transferida',
    });

    act(() => {
      sock.__trigger('auth:session_terminated', {
        reason: 'CONCURRENT_LOGIN',
        message: 'Otro dispositivo inició sesión',
      });
    });

    const terminatedEventsAfter = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .filter((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === 'huellicam:session_terminated');

    expect(terminatedEventsAfter).toHaveLength(2);
    expect(terminatedEventsAfter[1].detail).toEqual({
      reason: 'CONCURRENT_LOGIN',
      message: 'Otro dispositivo inició sesión',
    });
  });

  it('provides a safe no-op fallback when useSocket() is called outside SocketProvider', () => {
    render(<SocketProbe />);

    expect(screen.getByTestId('probe-has-socket').textContent).toBe('no');
    expect(screen.getByTestId('probe-connected').textContent).toBe('no');
    expect(() => screen.getByTestId('probe-emit').click()).not.toThrow();
  });

  it('preserves pre-connect child joinConsultation while loading is true and token is null, then joins on connect', () => {
    mockState.loading = true;
    mockState.token = null;

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <RoomSubscriber consultationId="c-preload" />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).not.toHaveBeenCalled();

    // Auth finishes hydrating
    mockState.loading = false;
    mockState.token = 'jwt-hydrated';

    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <RoomSubscriber consultationId="c-preload" />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    const sock = mockState.socket!;
    act(() => {
      sock.__trigger('connect');
    });

    const joinCalls = sock.emit.mock.calls.filter(([evt]) => evt === 'join:consultation');
    expect(joinCalls).toHaveLength(1);
    expect(joinCalls[0][1]).toEqual({ consultationId: 'c-preload' });
  });

  it('refreshes session on expired token connect_error and syncs socket.auth on storage event', async () => {
    mockState.refreshSession.mockImplementation(async () => {
      mockState.token = 'jwt-refreshed';
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <SocketProbe />
        </SocketProvider>
      </QueryClientProvider>
    );

    const sock = mockState.socket!;
    await act(async () => {
      sock.__trigger('connect_error', new Error('Authentication error: jwt expired'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockState.refreshSession).toHaveBeenCalledWith(true);
    expect(sock.auth).toEqual(
      expect.objectContaining({
        token: 'Bearer jwt-refreshed',
      })
    );

    mockState.token = 'jwt-cross-tab';
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'huellicam_token',
          newValue: 'jwt-cross-tab',
        })
      );
    });

    expect(sock.auth).toEqual(
      expect.objectContaining({
        token: 'Bearer jwt-cross-tab',
      })
    );
  });

  it('clears pre-connect room ref-counts on u1 -> u2 account switch while canConnect remains false', () => {
    const PreConnectJoiner: React.FC<{ consultationId: string }> = ({ consultationId }) => {
      const { joinConsultation } = useSocket();
      useEffect(() => {
        joinConsultation(consultationId);
      }, [consultationId, joinConsultation]);
      return null;
    };

    mockState.loading = true;
    mockState.token = null;
    mockState.user = {
      id: 'u1',
      email: 'u1@huellicam.com',
      firstName: 'Uno',
      lastName: 'User',
      role: 'CLIENT',
    };

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <PreConnectJoiner consultationId="c-u1-only" />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).not.toHaveBeenCalled();

    // Switch account u1 -> u2 while canConnect is still false (loading: true, token: null)
    mockState.user = {
      id: 'u2',
      email: 'u2@huellicam.com',
      firstName: 'Dos',
      lastName: 'User',
      role: 'CLIENT',
    };

    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <div />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).not.toHaveBeenCalled();

    // Now u2 finishes hydrating auth and connects
    mockState.loading = false;
    mockState.token = 'jwt-u2';

    rerender(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <div />
        </SocketProvider>
      </QueryClientProvider>
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    const sock2 = mockState.socket!;
    act(() => {
      sock2.__trigger('connect');
    });

    const joinCalls = sock2.emit.mock.calls.filter(([evt]) => evt === 'join:consultation');
    expect(joinCalls).toHaveLength(0);
  });

  it('tracks reconnectingConsultations via consultation:tutor_reconnecting / tutor_reconnected and clears on call:ended or cancellation', () => {
    const ReconnectProbe: React.FC = () => {
      const { reconnectingConsultations } = useSocket();
      return <div data-testid="reconnecting-map">{JSON.stringify(reconnectingConsultations)}</div>;
    };

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <ReconnectProbe />
        </SocketProvider>
      </QueryClientProvider>
    );

    const sock = mockState.socket!;
    expect(screen.getByTestId('reconnecting-map').textContent).toBe('{}');

    act(() => {
      sock.__trigger('consultation:tutor_reconnecting', {
        consultationId: 'c-rec-1',
        userId: 'client-1',
        startedAt: '2026-11-26T12:00:00Z',
      });
    });

    expect(screen.getByTestId('reconnecting-map').textContent).toBe(
      '{"c-rec-1":"2026-11-26T12:00:00Z"}'
    );

    act(() => {
      sock.__trigger('consultation:tutor_reconnected', {
        consultationId: 'c-rec-1',
        userId: 'client-1',
      });
    });

    expect(screen.getByTestId('reconnecting-map').textContent).toBe('{}');

    // Also cleared by consultation:cancelled and call:ended
    act(() => {
      sock.__trigger('consultation:tutor_reconnecting', {
        consultationId: 'c-rec-2',
        startedAt: '2026-11-26T12:01:00Z',
      });
      sock.__trigger('consultation:tutor_reconnecting', {
        consultationId: 'c-rec-3',
        startedAt: '2026-11-26T12:02:00Z',
      });
    });

    act(() => {
      sock.__trigger('consultation:cancelled', { consultationId: 'c-rec-2' });
      sock.__trigger('call:ended', { consultationId: 'c-rec-3' });
    });

    expect(screen.getByTestId('reconnecting-map').textContent).toBe('{}');
  });

  it('defaults session:invalidated fallback reason to SESSION_MIGRATED_NEW_DEVICE', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <QueryClientProvider client={queryClient}>
        <SocketProvider>
          <div />
        </SocketProvider>
      </QueryClientProvider>
    );

    const sock = mockState.socket!;
    act(() => {
      sock.__trigger('session:invalidated', {});
    });

    const terminatedEvents = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .filter((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === 'huellicam:session_terminated');

    expect(terminatedEvents.at(-1)?.detail.reason).toBe('SESSION_MIGRATED_NEW_DEVICE');
    dispatchSpy.mockRestore();
  });
});
