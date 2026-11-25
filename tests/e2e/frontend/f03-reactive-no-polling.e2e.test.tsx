import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, act, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  createFrontendE2EServer,
  createDefaultVetUser,
  createDefaultClientUser,
  createDefaultConsultation,
  bootFrontendApp,
  installAxiosSpyAdapter,
  waitForCondition,
  type FrontendE2EServer,
} from '../helpers/dom/frontendHarness';
import { createLiveKitMockFactory } from '../helpers/dom/livekitMock';

const repoRoot = path.resolve(__dirname, '../../..');

function createNoopSocketMock(options?: { connected?: boolean }) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const noopSocket = {
    connected: options?.connected ?? false,
    auth: {},
    io: { on: vi.fn(), off: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
    }),
    off: vi.fn((event: string, handler?: (...args: unknown[]) => void) => {
      if (!handler) {
        listeners.delete(event);
        return;
      }
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
    }),
  };
  return {
    io: vi.fn(() => noopSocket),
    Socket: vi.fn(),
    __triggerServerEvent: (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}

describe('Feature 3: Reactive Socket.io Invalidation (No 4s Polling)', () => {
  describe('Tier 1 & Tier 2 — Zero Polling Over Time (Fake Timers + Adapter Spy)', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.doUnmock('socket.io-client');
      vi.doUnmock('@livekit/components-react');
      vi.unstubAllEnvs();
      vi.resetModules();
      window.localStorage.clear();
    });

    it('T1-F03-01: VetProvider issues only 1 GET /api/consultations/mine over 14s idle with no polling', async () => {
      vi.resetModules();
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      vi.doMock('socket.io-client', () => createNoopSocketMock());

      const vetUser = createDefaultVetUser();
      window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
      window.localStorage.setItem('huellicam_token', 'vet-token-1');

      const apiModule = await import('@/services/api');
      apiModule.setAccessToken('vet-token-1');

      const spy = installAxiosSpyAdapter(apiModule.default, (config) => {
        if (config.url?.includes('/api/auth/me')) {
          return { data: { success: true, data: { user: vetUser } } };
        }
        if (config.url?.includes('/api/consultations/mine')) {
          return {
            data: {
              success: true,
              data: [createDefaultConsultation({ id: 'c-idle-1', status: 'WAITING', vetId: null, vet: null })],
            },
          };
        }
        return { data: { success: true, data: [] } };
      });

      const { AuthProvider } = await import('@/context/AuthContext');
      const { VetProvider } = await import('@/vet/vetkit');

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
      });

      const view = render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <VetProvider forceEmpty={false}>
              <div data-testid="vet-child">Vet Mounted</div>
            </VetProvider>
          </AuthProvider>
        </QueryClientProvider>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      const mineCallsAfterMount = spy.requests.filter(
        (r) => r.method === 'GET' && r.url.includes('/api/consultations/mine')
      ).length;
      expect(mineCallsAfterMount).toBe(1);

      for (let sec = 0; sec < 14; sec += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      const mineCallsAfter14s = spy.requests.filter(
        (r) => r.method === 'GET' && r.url.includes('/api/consultations/mine')
      ).length;
      expect(mineCallsAfter14s).toBe(1);

      view.unmount();
      spy.restore();
    });

    it('T1-F03-02: vet/CallRoom issues only 1 GET /api/consultations/:id over 12s idle (no 3s/4s polling)', async () => {
      vi.resetModules();
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      vi.doMock('socket.io-client', () => createNoopSocketMock());
      vi.doMock('@livekit/components-react', () => createLiveKitMockFactory());

      const vetUser = createDefaultVetUser();
      window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
      window.localStorage.setItem('huellicam_token', 'vet-token-2');

      const apiModule = await import('@/services/api');
      apiModule.setAccessToken('vet-token-2');

      const spy = installAxiosSpyAdapter(apiModule.default, (config) => {
        if (config.url?.includes('/api/auth/me')) {
          return { data: { success: true, data: { user: vetUser } } };
        }
        if (config.url?.includes('/api/consultations/c-call-1/messages')) {
          return { data: { success: true, data: [] } };
        }
        if (config.url?.includes('/api/consultations/c-call-1')) {
          return {
            data: {
              success: true,
              data: createDefaultConsultation({ id: 'c-call-1', status: 'ACTIVE' }),
            },
          };
        }
        if (config.url?.includes('/api/calls/c-call-1/token')) {
          return {
            data: {
              success: true,
              data: { token: 'lk-tok-1', wsUrl: 'wss://mock-lk.local' },
            },
          };
        }
        return { data: { success: true, data: [] } };
      });

      const { AuthProvider } = await import('@/context/AuthContext');
      const { default: VetCallRoom } = await import('@/vet/CallRoom');

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
      });

      const view = render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <VetCallRoom id="c-call-1" />
          </AuthProvider>
        </QueryClientProvider>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      const detailGetsInitial = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-call-1'
      ).length;
      expect(detailGetsInitial).toBe(1);

      for (let sec = 0; sec < 12; sec += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      const detailGetsAfter12s = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-call-1'
      ).length;
      expect(detailGetsAfter12s).toBe(1);

      view.unmount();
      spy.restore();
    });

    it('T1-F03-03: ConsultationRoom in WAITING phase issues 0 5000ms setInterval polls over 12s', async () => {
      vi.resetModules();
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      vi.doMock('socket.io-client', () => createNoopSocketMock());
      vi.doMock('@livekit/components-react', () => createLiveKitMockFactory());

      const clientUser = createDefaultClientUser();
      window.localStorage.setItem('huellicam_user', JSON.stringify(clientUser));
      window.localStorage.setItem('huellicam_token', 'client-token-1');

      const apiModule = await import('@/services/api');
      apiModule.setAccessToken('client-token-1');

      const spy = installAxiosSpyAdapter(apiModule.default, (config) => {
        if (config.url?.includes('/api/auth/me')) {
          return { data: { success: true, data: { user: clientUser } } };
        }
        if (config.url?.includes('/api/consultations/c-wait-1/messages')) {
          return { data: { success: true, data: [] } };
        }
        if (config.url?.includes('/api/consultations/c-wait-1')) {
          return {
            data: {
              success: true,
              data: createDefaultConsultation({
                id: 'c-wait-1',
                status: 'WAITING',
                vetId: null,
                vet: null,
              }),
            },
          };
        }
        return { data: { success: true, data: [] } };
      });

      const { AuthProvider } = await import('@/context/AuthContext');
      const { ConsultationRoom } = await import('@/pages/ConsultationRoom');

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      const view = render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <MemoryRouter initialEntries={['/call/c-wait-1']}>
              <Routes>
                <Route path="/call/:id" element={<ConsultationRoom />} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      const initialGets = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-wait-1'
      ).length;
      expect(initialGets).toBe(1);

      for (let sec = 0; sec < 12; sec += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      const getsAfter12s = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-wait-1'
      ).length;
      expect(getsAfter12s).toBe(1);

      view.unmount();
      spy.restore();
    });

    it('T2-F03-01: ConsultationRoom in ACTIVE phase issues 0 polling GETs before or after completion over 15s', async () => {
      vi.resetModules();
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const socketMock = createNoopSocketMock({ connected: true });
      vi.doMock('socket.io-client', () => socketMock);
      vi.doMock('@livekit/components-react', () => createLiveKitMockFactory());

      const clientUser = createDefaultClientUser();
      window.localStorage.setItem('huellicam_user', JSON.stringify(clientUser));
      window.localStorage.setItem('huellicam_token', 'client-token-2');

      const apiModule = await import('@/services/api');
      apiModule.setAccessToken('client-token-2');

      const spy = installAxiosSpyAdapter(apiModule.default, (config) => {
        if (config.url?.includes('/api/auth/me')) {
          return { data: { success: true, data: { user: clientUser } } };
        }
        if (config.url?.includes('/api/consultations/c-active-1/messages')) {
          return { data: { success: true, data: [] } };
        }
        if (config.url?.includes('/api/consultations/c-active-1')) {
          return {
            data: {
              success: true,
              data: createDefaultConsultation({ id: 'c-active-1', status: 'ACTIVE' }),
            },
          };
        }
        if (config.url?.includes('/api/calls/c-active-1/token')) {
          return {
            data: {
              success: true,
              data: { token: 'lk-active-tok', wsUrl: 'wss://mock-lk.local' },
            },
          };
        }
        return { data: { success: true, data: [] } };
      });

      const { AuthProvider } = await import('@/context/AuthContext');
      const { SocketProvider } = await import('@/context/SocketContext');
      const { ConsultationRoom } = await import('@/pages/ConsultationRoom');

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      const view = render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SocketProvider>
              <MemoryRouter initialEntries={['/call/c-active-1']}>
                <Routes>
                  <Route path="/call/:id" element={<ConsultationRoom />} />
                </Routes>
              </MemoryRouter>
            </SocketProvider>
          </AuthProvider>
        </QueryClientProvider>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      const initialGets = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-active-1'
      ).length;
      expect(initialGets).toBe(1);

      for (let sec = 0; sec < 15; sec += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      const getsAfter15s = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-active-1'
      ).length;
      expect(getsAfter15s).toBe(1);

      // Transition consultation to COMPLETED via reactive call:ended event and confirm 0 polling over 15s more
      await act(async () => {
        socketMock.__triggerServerEvent('call:ended', {
          consultationId: 'c-active-1',
          endedBy: 'vet-1',
        });
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(screen.getByText(/Consulta Finalizada/i)).toBeInTheDocument();

      for (let sec = 0; sec < 15; sec += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      const getsAfterCompleted15s = spy.requests.filter(
        (r) => r.method === 'GET' && r.url === '/api/consultations/c-active-1'
      ).length;
      expect(getsAfterCompleted15s).toBe(1);

      view.unmount();
      spy.restore();
    });
  });

  describe('Tier 1 & Tier 2 — Reactive Socket Invalidation & Static Contract', () => {
    let server: FrontendE2EServer;

    beforeAll(async () => {
      server = await createFrontendE2EServer();
    });

    afterAll(async () => {
      await server.close();
    });

    afterEach(async () => {
      vi.doUnmock('@livekit/components-react');
      vi.unstubAllEnvs();
      vi.resetModules();
      await waitForCondition(() => server.activeSocketIds.size === 0, 2000).catch(() => {
        server.disconnectAllSockets(true);
      });
      server.resetLogs();
      window.localStorage.clear();
    });

    it('T1-F03-04: VetProvider invalidates [consultations, vet] and refetches GET /api/consultations/mine on consultation:assigned', async () => {
      const vetUser = createDefaultVetUser();
      server.state.currentUser = vetUser;
      server.state.consultations = [
        createDefaultConsultation({
          id: 'c-assign-1',
          status: 'WAITING',
          vetId: null,
          vet: null,
        }),
      ];

      const { App } = await bootFrontendApp({
        serverUrl: server.url,
        user: vetUser,
        token: 'vet-jwt-1',
        initialPath: '/vet/queue',
      });

      const view = render(<App />);

      await waitForCondition(
        () =>
          server.activeSocketIds.size >= 1 &&
          server.getHttpCalls('GET', '/api/consultations/mine').length >= 1
      );
      await waitFor(
        () => {
          expect(screen.getByText(/Milo/i)).toBeInTheDocument();
        },
        { timeout: 4000 }
      );
      // Allow Socket.io client namespace CONNECT & listener sync before server emit
      await new Promise((resolve) => setTimeout(resolve, 200));

      server.resetLogs();
      server.state.consultations[0].status = 'ACTIVE';
      server.state.consultations[0].vetId = 'vet-1';

      server.emitToAll('consultation:assigned', {
        consultationId: 'c-assign-1',
        vetId: 'vet-1',
        clientId: 'client-1',
        status: 'ACTIVE',
      });

      await waitForCondition(
        () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
        4000
      );

      expect(server.getHttpCalls('GET', '/api/consultations/mine').length).toBeGreaterThanOrEqual(1);
      view.unmount();
      await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
    });

    it('T1-F03-05: vet/CallRoom invalidates queries on prescription:new and transitions to summary on call:ended', async () => {
      vi.doMock('@livekit/components-react', () => createLiveKitMockFactory());
      const vetUser = createDefaultVetUser();
      server.state.currentUser = vetUser;
      server.state.consultations = [
        createDefaultConsultation({ id: 'c-rx-1', status: 'ACTIVE' }),
      ];

      const { App } = await bootFrontendApp({
        serverUrl: server.url,
        user: vetUser,
        token: 'vet-jwt-rx',
        initialPath: '/call/c-rx-1',
      });

      const view = render(<App />);

      await waitForCondition(
        () =>
          server.activeSocketIds.size >= 1 &&
          server.socketEmittedEvents.some(
            (e) =>
              e.event === 'join:consultation' &&
              (e.payload as { consultationId?: string })?.consultationId === 'c-rx-1'
          ) &&
          server.getHttpCalls('GET', '/api/consultations/c-rx-1').length >= 1 &&
          server.getHttpCalls('GET', '/api/prescriptions').length >= 1
      );
      await waitFor(
        () => {
          expect(screen.getByTestId('mock-livekit-room')).toBeInTheDocument();
          expect(screen.getAllByText(/Milo/i).length).toBeGreaterThan(0);
        },
        { timeout: 4000 }
      );
      // Allow Socket.io client namespace CONNECT & initial CallRoom sync queries to settle
      await new Promise((resolve) => setTimeout(resolve, 200));

      server.resetLogs();

      server.emitToAll('prescription:new', {
        consultationId: 'c-rx-1',
        prescriptionId: 'rx-99',
        petId: 'pet-1',
      });

      await waitForCondition(
        () =>
          server.getHttpCalls('GET', '/api/prescriptions').length >= 1 &&
          server.getHttpCalls('GET', '/api/consultations/c-rx-1').length >= 1,
        4000
      );

      server.state.consultations[0].status = 'COMPLETED';
      server.emitToAll('call:ended', { consultationId: 'c-rx-1', endedBy: 'vet-1' });

      await waitFor(() => {
        expect(screen.getByText(/Consulta finalizada/i)).toBeInTheDocument();
      });

      view.unmount();
      await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
    });

    it('T2-F03-02: VetProvider handles a burst of 5 consultation:new events in 50ms cleanly without errors', async () => {
      const vetUser = createDefaultVetUser();
      server.state.currentUser = vetUser;
      server.state.consultations = [];

      const { App } = await bootFrontendApp({
        serverUrl: server.url,
        user: vetUser,
        token: 'vet-jwt-burst',
        initialPath: '/vet/queue',
      });

      const view = render(<App />);

      await waitForCondition(
        () =>
          server.activeSocketIds.size >= 1 &&
          server.getHttpCalls('GET', '/api/consultations/mine').length >= 1
      );
      await waitFor(
        () => {
          expect(screen.getByRole('heading', { name: /Cola de atención/i })).toBeInTheDocument();
          expect(screen.getByText(/No hay pacientes en espera/i)).toBeInTheDocument();
        },
        { timeout: 4000 }
      );
      // Allow initial query settle & Socket.io client namespace CONNECT before burst emit
      await new Promise((resolve) => setTimeout(resolve, 200));

      server.resetLogs();

      for (let i = 1; i <= 5; i += 1) {
        const nextCons = createDefaultConsultation({
          id: `c-burst-${i}`,
          status: 'WAITING',
          vetId: null,
          vet: null,
        });
        server.state.consultations.push(nextCons);
        server.emitToAll('consultation:new', nextCons);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await waitForCondition(
        () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
        4000
      );

      const refetchCount = server.getHttpCalls('GET', '/api/consultations/mine').length;
      expect(refetchCount).toBeGreaterThanOrEqual(1);
      expect(refetchCount).toBeLessThanOrEqual(5);
      expect(screen.queryByText(/Ocurrió un error/i)).not.toBeInTheDocument();

      view.unmount();
      await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
    });

    it('T2-F03-03: Socket reconnect triggers at most 1 resync fetch without resuming 4000ms polling', async () => {
      const vetUser = createDefaultVetUser();
      server.state.currentUser = vetUser;
      server.state.consultations = [
        createDefaultConsultation({ id: 'c-reconn-1', status: 'WAITING', vetId: null, vet: null }),
      ];

      const { App } = await bootFrontendApp({
        serverUrl: server.url,
        user: vetUser,
        token: 'vet-jwt-reconn',
        initialPath: '/vet/queue',
      });

      const view = render(<App />);

      await waitForCondition(
        () =>
          server.activeSocketIds.size === 1 &&
          server.getHttpCalls('GET', '/api/consultations/mine').length >= 1
      );
      await waitFor(
        () => {
          expect(screen.getByText(/Milo/i)).toBeInTheDocument();
        },
        { timeout: 4000 }
      );
      // Allow Socket.io client namespace CONNECT & transport upgrade to settle before forcing close
      await new Promise((resolve) => setTimeout(resolve, 250));

      const initialSocketId = Array.from(server.activeSocketIds)[0];
      server.resetLogs();

      // Force underlying Engine.IO transport close so socket.io-client reconnects naturally
      for (const s of server.io.sockets.sockets.values()) {
        s.conn.close();
      }

      await waitForCondition(
        () =>
          server.activeSocketIds.size === 1 &&
          !server.activeSocketIds.has(initialSocketId),
        8000
      );

      await waitForCondition(
        () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
        4000
      );
      // Allow resync response & post-reconnect upgrade to settle before resetting logs
      await new Promise((resolve) => setTimeout(resolve, 250));

      const resyncGets = server.getHttpCalls('GET', '/api/consultations/mine').length;
      expect(resyncGets).toBe(1);

      server.resetLogs();
      // Wait 4.5s (> 4000ms legacy refetchInterval) and verify 0 polling requests occur
      await new Promise((resolve) => setTimeout(resolve, 4500));
      expect(server.getHttpCalls('GET', '/api/consultations/mine').length).toBe(0);

      view.unmount();
      await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
    });

    it('T2-F03-04: Static contract — zero 3s/4s/5s consultation polling intervals remain in web/src', () => {
      const targets = [
        'web/src/vet/vetkit.tsx',
        'web/src/vet/CallRoom.tsx',
        'web/src/pages/ConsultationRoom.tsx',
      ];

      const violations: string[] = [];
      for (const rel of targets) {
        const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        if (/refetchInterval\s*:\s*(\(?.*(3000|4000|5000)|4000|3000)/.test(content)) {
          violations.push(`${rel}: active refetchInterval polling`);
        }
        if (/POLLING_INTERVAL_MS\s*=\s*\d+/.test(content) || /pollingRef\.current\s*=\s*setInterval/.test(content)) {
          violations.push(`${rel}: setInterval polling loop`);
        }
      }

      expect(violations).toEqual([]);
    });

    it('T2-F03-05: Malformed Socket event payloads do not crash UI and valid follow-up events still sync', async () => {
      const vetUser = createDefaultVetUser();
      server.state.currentUser = vetUser;
      server.state.consultations = [
        createDefaultConsultation({ id: 'c-valid-1', status: 'WAITING', vetId: null, vet: null }),
      ];

      const { App } = await bootFrontendApp({
        serverUrl: server.url,
        user: vetUser,
        token: 'vet-jwt-malformed',
        initialPath: '/vet/queue',
      });

      const view = render(<App />);

      await waitForCondition(
        () =>
          server.activeSocketIds.size >= 1 &&
          server.getHttpCalls('GET', '/api/consultations/mine').length >= 1
      );
      await waitFor(
        () => {
          expect(screen.getByText(/Milo/i)).toBeInTheDocument();
        },
        { timeout: 4000 }
      );
      // Allow Socket.io client namespace CONNECT & listener sync before server emit
      await new Promise((resolve) => setTimeout(resolve, 200));

      server.resetLogs();

      // Malformed payloads
      server.emitToAll('consultation:new', {});
      server.emitToAll('consultation:assigned', { consultationId: 'non-existent-id' });
      server.emitToAll('prescription:new', null);

      await new Promise((resolve) => setTimeout(resolve, 150));

      // UI stays mounted and healthy
      expect(screen.queryByText(/Algo salió mal/i)).not.toBeInTheDocument();

      // Valid subsequent event still triggers query invalidation/refetch
      server.resetLogs();
      server.emitToAll('consultation:assigned', {
        consultationId: 'c-valid-1',
        vetId: 'vet-1',
        clientId: 'client-1',
        status: 'ACTIVE',
      });

      await waitForCondition(
        () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
        4000
      );
      expect(server.getHttpCalls('GET', '/api/consultations/mine').length).toBeGreaterThanOrEqual(1);

      view.unmount();
      await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
    });
  });
});
