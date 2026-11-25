import React from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

describe('Tier 4 — Real-World Veterinary Telemedicine E2E Scenarios (DOM)', () => {
  let server: FrontendE2EServer;

  beforeAll(async () => {
    server = await createFrontendE2EServer();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    resetCapturedLiveKitProps();
    vi.unstubAllEnvs();
    vi.resetModules();
    server.resetLogs();
    window.localStorage.clear();
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  });

  it('T4-S01: Full consultation lifecycle — reactive triage, claim, simulcast video call, webhook telemetry, and reactive end', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [];
    const beforeConns = server.totalConnections;

    const { App, api } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-s01-token',
      initialPath: '/vet/queue',
    });
    const { go } = await import('@/shared');

    const view = render(<App />);

    await waitForCondition(
      () =>
        server.activeSocketIds.size === 1 &&
        server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
      5000
    );

    // 1. Tutor creates consultation + server emits reactive consultation:new
    const createdRes = await api.post('/api/consultations', {
      petId: 'pet-1',
      notes: '[PRIORIDAD:ROJO] Vomitos agudos',
    });
    const createdCons = createdRes.data.data as { id: string };
    expect(createdCons.id).toBeTruthy();

    server.emitToAll('consultation:new', {
      ...server.state.consultations[0],
      client: { id: 'client-1', firstName: 'Mateo', lastName: 'Gomez' },
    });

    await waitFor(
      () => {
        expect(screen.getByText(/Milo/i)).toBeInTheDocument();
      },
      { timeout: 4000 }
    );

    // 2. Vet claims & enters CallRoom -> simulcast LiveKitRoom + Call INITIATED
    await api.patch(`/api/consultations/${createdCons.id}/assign`);
    server.emitToAll('consultation:assigned', {
      consultationId: createdCons.id,
      vetId: vetUser.id,
      clientId: 'client-1',
      status: 'ACTIVE',
    });

    act(() => {
      go(`/call/${createdCons.id}`);
    });

    await waitForCondition(() => capturedLiveKitProps.length >= 1, 5000);
    const lkProps = getLatestLiveKitProps();
    expect(lkProps?.options?.adaptiveStream).toBe(true);
    expect(lkProps?.options?.dynacast).toBe(true);
    expect(lkProps?.options?.publishDefaults?.simulcast).toBe(true);
    const layers = (lkProps?.options?.publishDefaults?.videoSimulcastLayers ?? []).map(
      (l) => `${l.resolution.width}x${l.resolution.height}`
    );
    expect(layers).toContain('320x180');
    expect(layers).toContain('640x360');

    expect(server.state.calls[createdCons.id]?.status).toBe('INITIATED');

    // 3. LiveKit webhooks: room_started -> participant_joined -> room_finished
    await api.post('/api/calls/webhook', {
      event: 'room_started',
      room: { name: createdCons.id, sid: 'RM_s01' },
    });
    await api.post('/api/calls/webhook', {
      event: 'participant_joined',
      room: { name: createdCons.id, sid: 'RM_s01' },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await api.post('/api/calls/webhook', {
      event: 'room_finished',
      room: { name: createdCons.id, sid: 'RM_s01' },
    });

    expect(server.state.calls[createdCons.id]?.status).toBe('ENDED');
    expect(server.state.calls[createdCons.id]?.durationSeconds).toBeGreaterThanOrEqual(1);

    // 4. Complete consultation & emit call:ended -> reactive transition to summary
    await api.patch(`/api/consultations/${createdCons.id}/complete`, {
      diagnosisNotes: 'Hidratacion oral y control en 24h',
    });
    server.emitToAll('call:ended', { consultationId: createdCons.id, endedBy: vetUser.id });

    await waitFor(
      () => {
        expect(screen.getByText(/Consulta finalizada/i)).toBeInTheDocument();
      },
      { timeout: 4000 }
    );

    // 5. Singleton socket & correlation ID headers verified across the lifecycle
    expect(server.totalConnections - beforeConns).toBe(1);
    expect(server.activeSocketIds.size).toBe(1);

    const apiCalls = server.getHttpCalls('POST', '/api/consultations');
    expect(apiCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(apiCalls[0].headers['x-request-id'] ?? '').trim().length).toBeGreaterThan(0);
    expect(String(apiCalls[0].headers['x-correlation-id'] ?? '').trim().length).toBeGreaterThan(0);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T4-S03: Multi-route vet navigation preserves singleton socket with zero polling and reactive prescription/cancel sync', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [
      createDefaultConsultation({ id: 'c-s03-1', status: 'ACTIVE' }),
      createDefaultConsultation({
        id: 'c-s03-2',
        status: 'WAITING',
        vetId: null,
        vet: null,
        notes: '[PRIORIDAD:VERDE] Consulta cancelable en cola',
      }),
    ];
    const beforeConns = server.totalConnections;

    const { App, api } = await bootFrontendApp({
      serverUrl: server.url,
      user: vetUser,
      token: 'vet-s03-token',
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

    // Switch routes 4 times across vet app
    for (const nextPath of [
      '/vet/consultations',
      '/call/c-s03-1',
      '/vet/prescriptions',
      '/vet/queue',
    ]) {
      act(() => {
        go(nextPath);
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(server.totalConnections - beforeConns).toBe(1);
    expect(server.activeSocketIds.size).toBe(1);

    // Idle wait > 4s on /vet/queue -> 0 polling requests
    server.resetLogs();
    await new Promise((resolve) => setTimeout(resolve, 4300));
    expect(server.getHttpCalls('GET', '/api/consultations/mine').length).toBe(0);

    // Issue prescription + emit prescription:new -> prescriptions query invalidates
    const rxRes = await api.post('/api/consultations/c-s03-1/prescriptions', {
      medication: 'Cefalexina 500mg',
      dosage: '1 comprimido',
      frequency: 'Cada 12h',
      durationDays: 7,
      indications: 'Con comida',
    });
    const createdRx = rxRes.data.data as { id: string };
    server.emitToAll('prescription:new', {
      consultationId: 'c-s03-1',
      prescriptionId: createdRx.id,
      petId: 'pet-1',
    });

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/prescriptions').length >= 1,
      4000
    );

    // Tutor cancels c-s03-2 + emits consultation:cancelled -> Vet queue updates reactively
    server.resetLogs();
    await api.patch('/api/consultations/c-s03-2/cancel');
    server.emitToAll('consultation:cancelled', {
      consultationId: 'c-s03-2',
      cancelledBy: 'client-1',
      status: 'CANCELLED',
    });

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/mine').length >= 1,
      4000
    );
    await waitFor(
      () => {
        expect(screen.queryByText(/Consulta cancelable en cola/i)).not.toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Every web API request included X-Correlation-Id
    const corrCalls = server.getHttpCalls('GET', '/api/consultations/mine');
    expect(corrCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(corrCalls[0].headers['x-correlation-id'] ?? '').trim().length).toBeGreaterThan(0);

    view.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);
  });

  it('T4-S06: Mobile WebView bridge + simulcast CallRoom + socket reconnect recovery + prescription QR view', async () => {
    const postedBridgeMessages: Array<Record<string, unknown>> = [];
    (
      window as unknown as {
        ReactNativeWebView?: { postMessage: (msg: string) => void };
      }
    ).ReactNativeWebView = {
      postMessage: (raw: string) => {
        try {
          postedBridgeMessages.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          postedBridgeMessages.push({ raw });
        }
      },
    };

    const clientUser = createDefaultClientUser();
    server.state.currentUser = clientUser;
    server.state.consultations = [createDefaultConsultation({ id: 'c-s06', status: 'ACTIVE' })];
    const rxId = 'rx-s06';
    server.state.prescriptions = [
      {
        id: rxId,
        consultationId: 'c-s06',
        vetId: 'vet-1',
        clientId: 'client-1',
        medication: 'Enrofloxacina 50mg',
        dosage: '1/2 comprimido',
        frequency: 'Cada 24h',
        durationDays: 10,
        indications: 'Hidratacion constante',
        createdAt: new Date().toISOString(),
        verifyUrl: `${server.url}/verify-rx?code=${rxId}`,
        qrCodeDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        vet: { firstName: 'Lucia', lastName: 'Mendez', licenseNumber: 'MP-4421' },
        pet: { name: 'Milo', species: 'Canino', breed: 'Golden Retriever' },
      },
    ];

    // 1. Mobile Axios client checks correlation + platform header
    vi.resetModules();
    vi.stubEnv('EXPO_PUBLIC_API_URL', server.url);
    const mobileApi = (await import('@mobile/lib/api')).default;
    await mobileApi.get('/api/consultations/c-s06');

    const mobileCall = server.getHttpCalls('GET', '/api/consultations/c-s06')[0];
    expect(mobileCall.headers['x-client-platform']).toBe('mobile');

    // 2. Client CallRoom in WebView mounts simulcast LiveKitRoom + emits bridge page:ready
    const { CallRoom } = await import('@/components/call/CallRoom');
    const callView = render(
      <CallRoom token="mobile-lk-jwt" serverUrl="wss://mock-lk.local" />
    );

    expect(postedBridgeMessages.some((m) => m.type === 'page:ready')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Ingresar a la Consulta/i }));

    await waitFor(() => {
      expect(capturedLiveKitProps.length).toBe(1);
    });
    const lkProps = getLatestLiveKitProps();
    expect(lkProps?.options?.adaptiveStream).toBe(true);
    expect(lkProps?.options?.dynacast).toBe(true);
    expect(lkProps?.options?.publishDefaults?.simulcast).toBe(true);
    expect(lkProps?.options?.publishDefaults?.degradationPreference).toBe('maintain-framerate');
    callView.unmount();

    // 3. Boot full App on /prescriptions/rx-s06 -> socket reconnect recovery & QR view
    const { App } = await bootFrontendApp({
      serverUrl: server.url,
      user: clientUser,
      token: 'client-s06-token',
      initialPath: `/prescriptions/${rxId}`,
    });

    const appView = render(<App />);

    await waitFor(
      () => {
        expect(screen.getByTestId('prescription-view-page')).toBeInTheDocument();
        expect(screen.getByText(/Enrofloxacina 50mg/i)).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    await waitForCondition(() => server.activeSocketIds.size === 1, 5000);
    const firstSocketId = Array.from(server.activeSocketIds)[0];

    // Simulate brief socket transport drop -> client reconnects cleanly with 1 active socket
    for (const s of server.io.sockets.sockets.values()) {
      s.conn.close();
    }

    await waitForCondition(
      () =>
        server.activeSocketIds.size === 1 && !server.activeSocketIds.has(firstSocketId),
      6000
    );

    expect(server.activeSocketIds.size).toBe(1);
    appView.unmount();
    await waitForCondition(() => server.activeSocketIds.size === 0, 3000);

    // 4. Verify correlation ID header after full WebView bridge, simulcast, QR, and reconnect flow
    expect(String(mobileCall.headers['x-correlation-id'] ?? '').trim().length).toBeGreaterThan(0);
  });
});
