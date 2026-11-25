import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Room, VideoPresets, type RoomOptions } from 'livekit-client';
import {
  createFrontendE2EServer,
  createDefaultVetUser,
  createDefaultConsultation,
  waitForCondition,
  type FrontendE2EServer,
} from '../helpers/dom/frontendHarness';
import {
  capturedLiveKitProps,
  createLiveKitMockFactory,
  getLatestLiveKitProps,
  resetCapturedLiveKitProps,
} from '../helpers/dom/livekitMock';

vi.mock('@livekit/components-react', () => createLiveKitMockFactory());

const repoRoot = path.resolve(__dirname, '../../..');
const livekitConfigFile = path.join(repoRoot, 'web/src/lib/livekitConfig.ts');

async function loadLiveKitOptions(): Promise<RoomOptions> {
  expect(
    fs.existsSync(livekitConfigFile),
    'Expected M2 module web/src/lib/livekitConfig.ts to exist'
  ).toBe(true);
  const mod = (await import('@/lib/livekitConfig')) as { LIVEKIT_ROOM_OPTIONS?: RoomOptions };
  expect(mod.LIVEKIT_ROOM_OPTIONS).toBeDefined();
  return mod.LIVEKIT_ROOM_OPTIONS as RoomOptions;
}

describe('Feature 5: Adaptive Simulcast & Bitrate Profiles (LiveKit / WebRTC)', () => {
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
  });

  it('T1-F05-01: LIVEKIT_ROOM_OPTIONS enables adaptiveStream and dynacast', async () => {
    const options = await loadLiveKitOptions();
    expect(options.adaptiveStream).toBe(true);
    expect(options.dynacast).toBe(true);
  });

  it('T1-F05-02: LIVEKIT_ROOM_OPTIONS configures 720p capture, simulcast=true, and 180p/360p simulcast layers', async () => {
    const options = await loadLiveKitOptions();
    expect(options.videoCaptureDefaults?.resolution).toEqual(VideoPresets.h720.resolution);
    expect(options.publishDefaults?.simulcast).toBe(true);
    expect(options.publishDefaults?.videoEncoding).toEqual(VideoPresets.h720.encoding);

    const layers = options.publishDefaults?.videoSimulcastLayers ?? [];
    expect(layers.length).toBeGreaterThanOrEqual(2);

    const resolutions = layers.map((l) => `${l.resolution.width}x${l.resolution.height}`);
    expect(resolutions).toContain('320x180');
    expect(resolutions).toContain('640x360');
  });

  it('T1-F05-03: LIVEKIT_ROOM_OPTIONS sets vp8 codec, backupCodec, maintain-framerate, and positive bitrate', async () => {
    const options = await loadLiveKitOptions();
    expect(options.publishDefaults?.videoCodec).toBe('vp8');
    expect(options.publishDefaults?.backupCodec).toBe(true);
    expect(options.publishDefaults?.degradationPreference).toBe('maintain-framerate');
    expect(options.publishDefaults?.videoEncoding?.maxBitrate).toBeGreaterThan(0);
  });

  it('T1-F05-04: vet/CallRoom passes adaptive simulcast RoomOptions to <LiveKitRoom>', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [
      createDefaultConsultation({ id: 'c-lk-vet-1', status: 'ACTIVE' }),
    ];

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-lk-token');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-lk-token');

    const { AuthProvider } = await import('@/context/AuthContext');
    const { default: VetCallRoom } = await import('@/vet/CallRoom');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <VetCallRoom id="c-lk-vet-1" />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitForCondition(() => capturedLiveKitProps.length >= 1, 5000);

    const latest = getLatestLiveKitProps();
    expect(latest?.serverUrl).toBe('wss://mock-livekit.local');
    expect(latest?.connect).toBe(true);
    expect(latest?.token).toBe('livekit-token-c-lk-vet-1');
    expect(latest?.options).toBeDefined();
    expect(latest?.options?.adaptiveStream).toBe(true);
    expect(latest?.options?.dynacast).toBe(true);
    expect(latest?.options?.publishDefaults?.simulcast).toBe(true);
    expect(latest?.options?.publishDefaults?.videoCodec).toBe('vp8');
    expect(latest?.options?.publishDefaults?.backupCodec).toBe(true);
    expect(latest?.options?.publishDefaults?.degradationPreference).toBe('maintain-framerate');
    expect(latest?.options?.publishDefaults?.videoEncoding).toEqual(VideoPresets.h720.encoding);
    expect(latest?.options?.videoCaptureDefaults?.resolution).toEqual(
      VideoPresets.h720.resolution
    );

    const layerRes = (latest?.options?.publishDefaults?.videoSimulcastLayers ?? []).map(
      (l) => `${l.resolution.width}x${l.resolution.height}`
    );
    expect(layerRes).toContain('320x180');
    expect(layerRes).toContain('640x360');

    view.unmount();
  });

  it('T1-F05-05: components/call/CallRoom passes adaptive simulcast RoomOptions after PreJoin confirmation', async () => {
    vi.resetModules();
    const { CallRoom } = await import('@/components/call/CallRoom');

    const view = render(
      <CallRoom token="client-lk-jwt" serverUrl="wss://mock-lk.local" />
    );

    expect(capturedLiveKitProps.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Ingresar a la Consulta/i }));

    await waitFor(() => {
      expect(capturedLiveKitProps.length).toBe(1);
    });

    const latest = getLatestLiveKitProps();
    expect(latest?.serverUrl).toBe('wss://mock-lk.local');
    expect(latest?.connect).toBe(true);
    expect(latest?.token).toBe('client-lk-jwt');
    expect(latest?.options).toBeDefined();
    expect(latest?.options?.adaptiveStream).toBe(true);
    expect(latest?.options?.dynacast).toBe(true);
    expect(latest?.options?.publishDefaults?.simulcast).toBe(true);
    expect(latest?.options?.publishDefaults?.videoCodec).toBe('vp8');
    expect(latest?.options?.publishDefaults?.backupCodec).toBe(true);
    expect(latest?.options?.publishDefaults?.degradationPreference).toBe('maintain-framerate');
    expect(latest?.options?.publishDefaults?.videoEncoding).toEqual(VideoPresets.h720.encoding);
    expect(latest?.options?.videoCaptureDefaults?.resolution).toEqual(
      VideoPresets.h720.resolution
    );

    const layerRes = (latest?.options?.publishDefaults?.videoSimulcastLayers ?? []).map(
      (l) => `${l.resolution.width}x${l.resolution.height}`
    );
    expect(layerRes).toContain('320x180');
    expect(layerRes).toContain('640x360');

    view.unmount();
  });

  it('T2-F05-01: vet/CallRoom does not mount <LiveKitRoom> while consultation is WAITING (no livekitToken)', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [
      createDefaultConsultation({ id: 'c-lk-wait', status: 'WAITING', vetId: null, vet: null }),
    ];

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-lk-wait-tok');

    // Prevent auto-assign from switching WAITING -> ACTIVE in this boundary test
    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-lk-wait-tok');
    const origPatch = apiModule.default.patch.bind(apiModule.default);
    vi.spyOn(apiModule.default, 'patch').mockImplementation((url, ...rest) => {
      if (typeof url === 'string' && url.includes('/assign')) {
        return Promise.reject(new Error('Deferred in waiting test'));
      }
      return origPatch(url, ...rest);
    });

    const { AuthProvider } = await import('@/context/AuthContext');
    const { default: VetCallRoom } = await import('@/vet/CallRoom');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <VetCallRoom id="c-lk-wait" />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitForCondition(
      () => server.getHttpCalls('GET', '/api/consultations/c-lk-wait').length >= 1,
      4000
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(capturedLiveKitProps.length).toBe(0);
    view.unmount();
  });

  it('T2-F05-02: components/call/CallRoom supports audio-only join (video=false) while keeping simulcast RoomOptions', async () => {
    vi.resetModules();
    const { CallRoom } = await import('@/components/call/CallRoom');

    const view = render(
      <CallRoom token="audio-only-jwt" serverUrl="wss://mock-lk.local" />
    );

    const cameraCheckbox = screen.getByLabelText(/Camara Web/i) as HTMLInputElement;
    expect(cameraCheckbox.checked).toBe(true);
    fireEvent.click(cameraCheckbox);
    expect(cameraCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Ingresar a la Consulta/i }));

    await waitFor(() => {
      expect(capturedLiveKitProps.length).toBe(1);
    });

    const latest = getLatestLiveKitProps();
    expect(latest?.video).toBe(false);
    expect(latest?.audio).toBe(true);
    expect(latest?.options?.adaptiveStream).toBe(true);
    expect(latest?.options?.dynacast).toBe(true);
    expect(latest?.options?.publishDefaults?.simulcast).toBe(true);

    view.unmount();
  });

  it('T2-F05-03: Simulcast layers are strictly smaller than 720p and bitrates increase monotonically h180 < h360 < h720', async () => {
    const options = await loadLiveKitOptions();
    const layers = options.publishDefaults?.videoSimulcastLayers ?? [];
    const primaryEncoding = options.publishDefaults?.videoEncoding;

    expect(layers.length).toBeGreaterThanOrEqual(2);
    expect(primaryEncoding?.maxBitrate).toBeGreaterThan(0);

    for (const layer of layers) {
      expect(layer.resolution.width).toBeLessThan(1280);
      expect(layer.resolution.height).toBeLessThan(720);
    }

    const h180 = layers.find((l) => l.resolution.height === 180);
    const h360 = layers.find((l) => l.resolution.height === 360);
    expect(h180?.encoding?.maxBitrate).toBeDefined();
    expect(h360?.encoding?.maxBitrate).toBeDefined();
    expect(h180!.encoding!.maxBitrate!).toBeLessThan(h360!.encoding!.maxBitrate!);
    expect(h360!.encoding!.maxBitrate!).toBeLessThan(primaryEncoding!.maxBitrate!);
  });

  it('T2-F05-04: vet/CallRoom enters Reconectando state on transient onDisconnected without immediate summary termination', async () => {
    const vetUser = createDefaultVetUser();
    server.state.currentUser = vetUser;
    server.state.consultations = [
      createDefaultConsultation({ id: 'c-lk-reconn', status: 'ACTIVE' }),
    ];

    vi.resetModules();
    vi.stubEnv('VITE_API_URL', server.url);
    vi.stubEnv('VITE_WS_URL', server.url);
    window.localStorage.setItem('huellicam_user', JSON.stringify(vetUser));
    window.localStorage.setItem('huellicam_token', 'vet-lk-reconn-tok');

    const apiModule = await import('@/services/api');
    apiModule.setAccessToken('vet-lk-reconn-tok');

    const { AuthProvider } = await import('@/context/AuthContext');
    const { default: VetCallRoom } = await import('@/vet/CallRoom');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <VetCallRoom id="c-lk-reconn" />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitForCondition(() => capturedLiveKitProps.length >= 1, 5000);
    const initialProps = getLatestLiveKitProps();
    expect(initialProps?.options?.adaptiveStream).toBe(true);

    act(() => {
      initialProps?.onDisconnected?.('SIGNAL_CLOSE');
    });

    await waitFor(() => {
      expect(screen.getByText(/Reconectando/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Consulta finalizada/i)).not.toBeInTheDocument();
    expect(getLatestLiveKitProps()?.options?.publishDefaults?.simulcast).toBe(true);

    view.unmount();
  });

  it('T2-F05-05: livekit-client new Room(LIVEKIT_ROOM_OPTIONS) instantiates cleanly with valid RoomOptions', async () => {
    const options = await loadLiveKitOptions();
    const room = new Room(options);
    expect(room.options.adaptiveStream).toBe(true);
    expect(room.options.dynacast).toBe(true);
    expect(room.options.publishDefaults?.simulcast).toBe(true);
    await room.disconnect().catch(() => {});
  });
});
