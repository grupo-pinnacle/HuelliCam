import React from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import {
  createFrontendE2EServer,
  createDefaultVetUser,
  createDefaultClientUser,
  createDefaultConsultation,
  bootFrontendApp,
  waitForCondition,
  type FrontendE2EServer,
} from '../../helpers/dom/frontendHarness';
import {
  capturedLiveKitProps,
  createLiveKitMockFactory,
  getLatestLiveKitProps,
  resetCapturedLiveKitProps,
} from '../../helpers/dom/livekitMock';

vi.mock('@livekit/components-react', () => createLiveKitMockFactory());

describe('Tier 3 — Cross-Feature Pairwise DOM Combinations', () => {
  let server: FrontendE2EServer;

  beforeAll(async () => {
    server = await createFrontendE2EServer();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    cleanup();
    await waitForCondition(() => server.activeSocketIds.size === 0, 2000).catch(() => {
      server.disconnectAllSockets(true);
    });
    resetCapturedLiveKitProps();
    vi.unstubAllEnvs();
    vi.resetModules();
    server.resetLogs();
    window.localStorage.clear();
  });

  it('T3-P02 (F3+F4): Singleton socket across /vet/dashboard & /call/c-1 with 0 polling and immediate reactive invalidation', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [
      createDefaultConsultation({ id: 'c-p02', status: 'ACTIVE' }),
    ];
    const beforeConns = server.totalConnections;

    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-p02-token',
      initialPath: '/vet/dashboard',
    });
    const { go } = await import('@/shared');

    const view = render(<App />);

    await waitForCondition(
      () =>
        server.activeSocketIds.size === 1 &&
        server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
      5000
    );

    act(() => {
      go('/call/c-p02');
    });

    await waitForCondition(
      () =>
        server.activeSocketIds.size === 1 &&
        server.socketEmittedEvents.some(
          (e) =>
            e.event === 'join:consultation' &&
            (e.payload as { consultationId?: string })?.consultationId === 'c-p02'
        ) &&
        server.getHttpCalls('GET', '/api/consultations/c-p02').length >= 1 &&
        capturedLiveKitProps.length >= 1,
      5000
    );
    await waitFor(
      () => {
        expect(screen.getByTestId('mock-livekit-room')).toBeInTheDocument();
        expect(screen.getAllByText(/Milo/i).length).toBeGreaterThan(0);
      },
      { timeout: 4000 }
    );
    // Allow Socket.io client namespace CONNECT & CallRoom shouldInitialSync queries to settle
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(server.totalConnections - beforeConns).toBe(1);
    expect(server.activeSocketIds.size).toBe(1);

    server.resetLogs();
    // Wait 4.5s (> 4000ms legacy refetchInterval) and verify 0 polling GETs
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(server.getHttpCalls('GET', '/api/consultations').length).toBe(0);

    // Emit reactive events over the single socket
    const newWaiting = createDefaultConsultation({
      id: 'c-p02-new',
      status: 'WAITING',
      vetId: null,
      vet: null,
    });
    server.state.consultations.push(newWaiting);
    server.emitToAll('consultation:new', newWaiting);

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
      4000
    );

    server.emitToAll('consultation:assigned', {
      consultationId: 'c-p02',
      vetId: 'vet-1',
      clientId: 'client-1',
      status: 'ACTIVE',
    });

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/c-p02').length >= 1,
      4000
    );

    expect(server.totalConnections - beforeConns).toBe(1);
    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T3-P03 (F4+F8): Singleton SocketContext carries non-empty correlationId alongside correlated HTTP requests', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [createDefaultConsultation({ id: 'c-p03', status: 'ACTIVE' })];
    const startConnIdx = server.socketConnections.length;

    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-p03-token',
      initialPath: '/call/c-p03',
    });

    const view = render(<App />);

    await waitForCondition(
      () =>
        server.socketConnections.length > startConnIdx &&
        server.socketEmittedEvents.some(
          (e) =>
            e.event === 'join:consultation' &&
            (e.payload as { consultationId?: string })?.consultationId === 'c-p03'
        ) &&
        server.getHttpCalls('GET', '/api/consultations/c-p03').length >= 1,
      5000
    );

    const conn = server.socketConnections[server.socketConnections.length - 1];
    expect(typeof conn.auth.correlationId).toBe('string');
    expect(String(conn.auth.correlationId).trim().length).toBeGreaterThan(0);

    const detailCall = server.getHttpCalls('GET', '/api/consultations/c-p03')[0];
    expect(typeof detailCall.headers['x-correlation-id']).toBe('string');
    expect(String(detailCall.headers['x-correlation-id']).trim().length).toBeGreaterThan(0);
    expect(typeof detailCall.headers['x-request-id']).toBe('string');
    expect(String(detailCall.headers['x-request-id']).trim().length).toBeGreaterThan(0);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T3-P05 (F5+F9): vet/CallRoom mounts simulcast LiveKitRoom while /api/calls/webhook transitions Call INITIATED -> ACTIVE -> ENDED', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [createDefaultConsultation({ id: 'c-p05', status: 'ACTIVE' })];

    const { App, api } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-p05-token',
      initialPath: '/call/c-p05',
    });

    const view = render(<App />);

    await waitForCondition(
      () =>
        server.activeSocketIds.size >= 1 &&
        server.socketEmittedEvents.some(
          (e) =>
            e.event === 'join:consultation' &&
            (e.payload as { consultationId?: string })?.consultationId === 'c-p05'
        ) &&
        server.getHttpCalls('GET', '/api/consultations/c-p05').length >= 1 &&
        capturedLiveKitProps.length >= 1,
      5000
    );

    const latestLk = getLatestLiveKitProps();
    expect(latestLk?.options?.adaptiveStream).toBe(true);
    expect(latestLk?.options?.dynacast).toBe(true);
    expect(latestLk?.options?.publishDefaults?.simulcast).toBe(true);
    const layers = (latestLk?.options?.publishDefaults?.videoSimulcastLayers ?? []).map(
      (l) => `${l.resolution.width}x${l.resolution.height}`
    );
    expect(layers).toContain('320x180');
    expect(layers).toContain('640x360');

    expect(server.state.calls['c-p05']?.status).toBe('INITIATED');

    await api.post('/api/calls/webhook', {
      event: 'room_started',
      room: { name: 'c-p05', sid: 'RM_p05' },
    });
    expect(server.state.calls['c-p05']?.status).toBe('ACTIVE');
    expect(server.state.calls['c-p05']?.startedAt).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 60));
    await api.post('/api/calls/webhook', {
      event: 'room_finished',
      room: { name: 'c-p05', sid: 'RM_p05' },
    });
    expect(server.state.calls['c-p05']?.status).toBe('ENDED');
    expect(server.state.calls['c-p05']?.endedAt).toBeTruthy();
    expect(server.state.calls['c-p05']?.durationSeconds).toBeGreaterThanOrEqual(1);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T3-P09 (F3+F5): Active simulcast vet/CallRoom has 0 polling over 4.5s and transitions to summary on call:ended socket event', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [createDefaultConsultation({ id: 'c-p09', status: 'ACTIVE' })];

    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-p09-token',
      initialPath: '/call/c-p09',
    });

    const view = render(<App />);

    await waitForCondition(
      () =>
        server.activeSocketIds.size >= 1 &&
        server.socketEmittedEvents.some(
          (e) =>
            e.event === 'join:consultation' &&
            (e.payload as { consultationId?: string })?.consultationId === 'c-p09'
        ) &&
        server.getHttpCalls('GET', '/api/consultations/c-p09').length >= 1 &&
        capturedLiveKitProps.length >= 1,
      5000
    );
    await waitFor(
      () => {
        expect(screen.getByTestId('mock-livekit-room')).toBeInTheDocument();
        expect(screen.getAllByText(/Milo/i).length).toBeGreaterThan(0);
      },
      { timeout: 4000 }
    );
    expect(getLatestLiveKitProps()?.options?.publishDefaults?.simulcast).toBe(true);
    // Allow Socket.io client namespace CONNECT & CallRoom shouldInitialSync queries to settle
    await new Promise((resolve) => setTimeout(resolve, 200));

    server.resetLogs();
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(server.getHttpCalls('GET', '/api/consultations/c-p09').length).toBe(0);

    server.state.consultations[0].status = 'COMPLETED';
    server.emitToAll('call:ended', { consultationId: 'c-p09', endedBy: 'vet-1' });

    await waitFor(() => {
      expect(screen.getByText(/Consulta finalizada/i)).toBeInTheDocument();
    });

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/c-p09').length >= 1,
      4000
    );

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T3-P12 (F4+F7): Client receives prescription:new and vet:presence over singleton socket and refreshes caches reactively', async () => {
    const clientUser = createDefaultClientUser();
    server.state.currentUser = clientUser;
    server.state.consultations = [createDefaultConsultation({ id: 'c-p12', status: 'ACTIVE' })];
    server.state.prescriptions = [];
    const beforeConns = server.totalConnections;

    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: clientUser,
      token: 'client-p12-token',
      initialPath: '/client/prescriptions',
    });

    const view = render(<App />);

    await waitForCondition(
      () =>
        server.activeSocketIds.size === 1 &&
        server.getHttpCalls('GET', '/api/prescriptions').length >= 1 &&
        server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
      5000
    );
    // Allow Socket.io client namespace CONNECT & listener sync before server emit
    await new Promise((resolve) => setTimeout(resolve, 200));

    server.resetLogs();
    server.state.prescriptions.push({
      id: 'rx-p12-1',
      consultationId: 'c-p12',
      vetId: 'vet-1',
      clientId: 'client-1',
      medication: 'Meloxicam 1.5mg/ml',
      dosage: '0.1 mg/kg',
      frequency: 'Cada 24 horas',
      durationDays: 5,
      indications: 'Administrar despues de comer',
      createdAt: new Date().toISOString(),
    });

    server.emitToAll('prescription:new', {
      consultationId: 'c-p12',
      prescriptionId: 'rx-p12-1',
      petId: 'pet-1',
    });

    await waitFor(
      () => {
        expect(screen.getByText(/Meloxicam 1.5mg\/ml/i)).toBeInTheDocument();
      },
      { timeout: 4000 }
    );
    expect(server.getHttpCalls('GET', '/api/prescriptions').length).toBeGreaterThanOrEqual(1);

    server.resetLogs();
    server.emitToAll('vet:presence', {
      vetId: 'vet-1',
      isOnline: false,
      lastSeen: new Date().toISOString(),
    });

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
      4000
    );

    expect(server.totalConnections - beforeConns).toBe(1);
    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });
});
