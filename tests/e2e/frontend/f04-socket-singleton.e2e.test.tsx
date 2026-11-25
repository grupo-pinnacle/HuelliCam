import fs from 'node:fs';
import path from 'node:path';
import React, { useEffect } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  createFrontendE2EServer,
  createDefaultVetUser,
  createDefaultClientUser,
  createDefaultConsultation,
  bootFrontendApp,
  waitForCondition,
  type FrontendE2EServer,
} from '../helpers/dom/frontendHarness';
import { createLiveKitMockFactory } from '../helpers/dom/livekitMock';

vi.mock('@livekit/components-react', () => createLiveKitMockFactory());

const repoRoot = path.resolve(__dirname, '../../..');
const socketContextFile = path.join(repoRoot, 'web/src/context/SocketContext.tsx');

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('Feature 4: Singleton SocketContext (React Context + ref)', () => {
  let server: FrontendE2EServer;

  beforeAll(async () => {
    server = await createFrontendE2EServer();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    server.resetLogs();
    window.localStorage.clear();
  });

  it('T1-F04-01: SocketProvider + GlobalCallListener + VetProvider opens exactly 1 Socket.io connection', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    const beforeConns = server.totalConnections;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-singleton-1');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-singleton-1');

    const { AuthProvider } = await import('@/context/AuthContext');
    const { SocketProvider } = await import('@/context/SocketContext');
    const { GlobalCallListener } = await import('@/components/call/GlobalCallListener');
    const { VetProvider } = await import('@/vet/vetkit');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <SocketProvider>
            <MemoryRouter>
              <GlobalCallListener />
              <VetProvider forceEmpty={false}>
                <div>Singleton Test</div>
              </VetProvider>
            </MemoryRouter>
          </SocketProvider>
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitForCondition(() => server.activeSocketIds.size === 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(server.totalConnections - beforeConns).toBe(1);
    expect(server.activeSocketIds.size).toBe(1);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T1-F04-02: App keeps exactly 1 socket across route navigation /vet/dashboard -> /call/c-1 -> /vet/dashboard', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [createDefaultConsultation({ id: 'c-1', status: 'ACTIVE' })];
    const beforeConns = server.totalConnections;

    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-nav-token',
      initialPath: '/vet/dashboard',
    });
    const { go } = await import('@/shared');

    const view = render(<App />);

    await waitForCondition(() => server.activeSocketIds.size === 1, 5000);
    const originalSocketId = Array.from(server.activeSocketIds)[0];

    act(() => {
      go('/call/c-1');
    });

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/c-1').length >= 1,
      5000
    );

    expect(server.totalConnections - beforeConns).toBe(1);
    expect(server.activeSocketIds.size).toBe(1);
    expect(server.activeSocketIds.has(originalSocketId)).toBe(true);

    act(() => {
      go('/vet/dashboard');
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(server.totalConnections - beforeConns).toBe(1);
    expect(server.activeSocketIds.size).toBe(1);
    expect(server.activeSocketIds.has(originalSocketId)).toBe(true);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T1-F04-03: useSocket() ref-counts joinConsultation and emits leave:consultation only when last consumer unmounts', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-refcount-token');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-refcount-token');

    const { AuthProvider } = await import('@/context/AuthContext');
    const { SocketProvider, useSocket } = await import('@/context/SocketContext');

    const RoomConsumer: React.FC<{ id: string; label: string }> = ({ id, label }) => {
      const { joinConsultation, leaveConsultation, isConnected } = useSocket();
      useEffect(() => {
        if (!isConnected) return;
        joinConsultation(id);
        return () => leaveConsultation(id);
      }, [id, isConnected, joinConsultation, leaveConsultation]);
      return <div data-testid={label}>{label}</div>;
    };

    const Harness: React.FC<{ showFirst: boolean; showSecond: boolean }> = ({
      showFirst,
      showSecond,
    }) => (
      <AuthProvider>
        <SocketProvider>
          {showFirst && <RoomConsumer id="c-ref-1" label="consumer-1" />}
          {showSecond && <RoomConsumer id="c-ref-1" label="consumer-2" />}
        </SocketProvider>
      </AuthProvider>
    );

    const view = render(<Harness showFirst={true} showSecond={true} />);

    await waitForCondition(
      () =>
        server.socketEmittedEvents.filter((e) => e.event === 'join:consultation').length === 1,
      5000
    );

    expect(
      server.socketEmittedEvents.filter((e) => e.event === 'join:consultation').length
    ).toBe(1);
    expect(
      server.socketEmittedEvents.filter((e) => e.event === 'leave:consultation').length
    ).toBe(0);

    // Unmount first child while second stays mounted
    view.rerender(<Harness showFirst={false} showSecond={true} />);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(
      server.socketEmittedEvents.filter((e) => e.event === 'leave:consultation').length
    ).toBe(0);

    // Unmount second child -> ref-count reaches 0 -> emits leave:consultation once
    view.rerender(<Harness showFirst={false} showSecond={false} />);
    await waitForCondition(
      () =>
        server.socketEmittedEvents.filter((e) => e.event === 'leave:consultation').length === 1,
      3000
    );

    expect(
      server.socketEmittedEvents.filter((e) => e.event === 'leave:consultation').length
    ).toBe(1);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T1-F04-04: Logout disconnects singleton socket cleanly and sets isConnected=false', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-logout-token');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-logout-token');

    const { AuthProvider, useAuth } = await import('@/context/AuthContext');
    const { SocketProvider, useSocket } = await import('@/context/SocketContext');

    const LogoutTester: React.FC = () => {
      const { logout } = useAuth();
      const { isConnected } = useSocket();
      return (
        <div>
          <span data-testid="conn-state">{isConnected ? 'connected' : 'disconnected'}</span>
          <button type="button" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      );
    };

    const view = render(
      <AuthProvider>
        <SocketProvider>
          <LogoutTester />
        </SocketProvider>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('conn-state')).toHaveTextContent('connected');
    });
    await waitForCondition(() => server.activeSocketIds.size === 1, 3000);
    expect(server.activeSocketIds.size).toBe(1);

    await act(async () => {
      screen.getByRole('button', { name: 'Logout' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('conn-state')).toHaveTextContent('disconnected');
    });
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
    expect(server.getHttpCalls('POST', '/api/auth/logout').length).toBeGreaterThanOrEqual(1);

    view.unmount();
  });

  it('T1-F04-05: useSocket() outside SocketProvider returns safe no-op fallback without throwing', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    vi.resetModules();
    const { useSocket } = await import('@/context/SocketContext');

    const StandaloneConsumer: React.FC = () => {
      const { socket, isConnected, joinConsultation, leaveConsultation, emitEvent } = useSocket();
      useEffect(() => {
        joinConsultation('c-standalone');
        const emitted = emitEvent('ping', { ok: true });
        expect(emitted).toBe(false);
        return () => leaveConsultation('c-standalone');
      }, [joinConsultation, leaveConsultation, emitEvent]);

      return (
        <div data-testid="standalone-status">
          {socket === null && !isConnected ? 'safe-fallback' : 'unexpected'}
        </div>
      );
    };

    const view = render(<StandaloneConsumer />);
    expect(screen.getByTestId('standalone-status')).toHaveTextContent('safe-fallback');
    view.unmount();
  });

  it('T2-F04-01: Unauthenticated user on /login opens 0 Socket.io connections', async () => {
    server.state.currentUser = null;
    const beforeConns = server.totalConnections;

    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: null,
      token: null,
      initialPath: '/login',
    });

    const view = render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.totalConnections - beforeConns).toBe(0);
    expect(server.activeSocketIds.size).toBe(0);

    view.unmount();
  });

  it('T2-F04-02: Switching authenticated user identity disconnects previous socket before creating 1 new socket', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    const userA = createDefaultVetUser({ id: 'vet-a' });
    const userB = createDefaultClientUser({ id: 'client-b' });
    server.state.currentUser = userA;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(userA));
    window.localStorage.setItem('huellicam_token', 'token-user-a');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('token-user-a');

    const { AuthProvider, useAuth } = await import('@/context/AuthContext');
    const { SocketProvider } = await import('@/context/SocketContext');

    const IdentitySwitcher: React.FC = () => {
      const { user, login } = useAuth();
      return (
        <div>
          <span data-testid="active-user">{user?.id ?? 'none'}</span>
          <button
            type="button"
            onClick={() => void login({ email: userB.email, password: 'Password123!' })}
          >
            SwitchUser
          </button>
        </div>
      );
    };

    const view = render(
      <AuthProvider>
        <SocketProvider>
          <IdentitySwitcher />
        </SocketProvider>
      </AuthProvider>
    );

    await waitForCondition(() => server.activeSocketIds.size === 1, 5000);
    const firstSocketId = Array.from(server.activeSocketIds)[0];

    server.state.currentUser = userB;
    await act(async () => {
      screen.getByRole('button', { name: 'SwitchUser' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-user')).toHaveTextContent('client-b');
    });

    await waitForCondition(
      () => server.activeSocketIds.size === 1 && !server.activeSocketIds.has(firstSocketId),
      5000
    );

    expect(server.activeSocketIds.size).toBe(1);
    expect(server.activeSocketIds.has(firstSocketId)).toBe(false);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T2-F04-03: Server session:invalidated disconnects singleton, dispatches huellicam:session_terminated, and does not reconnect', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    const clientUser = createDefaultClientUser();
    server.state.currentUser = clientUser;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(clientUser));
    window.localStorage.setItem('huellicam_token', 'client-revoked-token');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('client-revoked-token');

    const { AuthProvider } = await import('@/context/AuthContext');
    const { SocketProvider } = await import('@/context/SocketContext');

    const terminatedEvents: Array<{ reason?: string; message?: string }> = [];
    const listener = (e: Event) => {
      terminatedEvents.push((e as CustomEvent<{ reason?: string; message?: string }>).detail);
    };
    window.addEventListener('huellicam:session_terminated', listener);

    const view = render(
      <AuthProvider>
        <SocketProvider>
          <div>Session Watch</div>
        </SocketProvider>
      </AuthProvider>
    );

    await waitForCondition(() => server.activeSocketIds.size === 1, 5000);

    server.emitToAll('session:invalidated', {
      reason: 'SESSION_MIGRATED_NEW_DEVICE',
      message: 'Session migrated',
    });

    await waitForCondition(
      () => server.activeSocketIds.size === 0 && terminatedEvents.length >= 1,
      4000
    );

    // Ensure no auto-reconnect happens with the revoked token
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(server.activeSocketIds.size).toBe(0);
    expect(terminatedEvents[0]?.reason).toBe('SESSION_MIGRATED_NEW_DEVICE');

    window.removeEventListener('huellicam:session_terminated', listener);
    view.unmount();
  });

  it('T2-F04-04: React.StrictMode double-mount leaves at most 1 active connected socket', async () => {
    expect(fs.existsSync(socketContextFile), 'Expected M2 module web/src/context/SocketContext.tsx to exist').toBe(true);

    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-strict-token');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-strict-token');

    const { AuthProvider } = await import('@/context/AuthContext');
    const { SocketProvider } = await import('@/context/SocketContext');

    const view = render(
      <React.StrictMode>
        <AuthProvider>
          <SocketProvider>
            <div>StrictMode Singleton</div>
          </SocketProvider>
        </AuthProvider>
      </React.StrictMode>
    );

    await waitForCondition(() => server.activeSocketIds.size === 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(server.activeSocketIds.size).toBe(1);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T2-F04-05: Static audit — only web/src/context/SocketContext.tsx imports socket.io-client or invokes io(', () => {
    const webSrcDir = path.join(repoRoot, 'web/src');
    const files = collectTsFiles(webSrcDir);
    const ioCallSites: string[] = [];

    const stripComments = (source: string): string =>
      source.replace(
        /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
        (match) => (match.startsWith('//') || match.startsWith('/*') ? ' ' : match)
      );

    for (const file of files) {
      const content = stripComments(fs.readFileSync(file, 'utf8'));
      if (/from\s+['"]socket\.io-client['"]/.test(content) || /\bio\s*(?:<[^>]+>)?\s*\(/.test(content)) {
        ioCallSites.push(path.relative(repoRoot, file).replace(/\\/g, '/'));
      }
    }

    expect(ioCallSites).toEqual(['web/src/context/SocketContext.tsx']);
  });
});
