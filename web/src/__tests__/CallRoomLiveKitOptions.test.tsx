import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoPresets, type RoomOptions } from 'livekit-client';

const { capturedLiveKitProps, mockSocketFns } = vi.hoisted(() => ({
  capturedLiveKitProps: [] as Array<Record<string, unknown>>,
  mockSocketFns: {
    joinConsultation: vi.fn(),
    leaveConsultation: vi.fn(),
    emitEvent: vi.fn(() => false),
  },
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    capturedLiveKitProps.push(props);
    return <div data-testid="mock-livekit-room">{props.children}</div>;
  },
  VideoConference: () => <div data-testid="mock-video-conference" />,
  useLocalParticipant: () => ({ localParticipant: null }),
}));

vi.mock('@livekit/components-styles', () => ({}));

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async (url: string) => {
      if (url === '/api/consultations/c-lk-1') {
        return {
          data: {
            success: true,
            data: {
              id: 'c-lk-1',
              petId: 'p1',
              status: 'ACTIVE',
              pet: { id: 'p1', name: 'Milo', species: 'Canino' },
              client: { firstName: 'Tobias', lastName: 'Vera' },
              vet: { firstName: 'Ana', lastName: 'Gomez' },
              notes: 'Control',
            },
          },
        };
      }
      return { data: { success: true, data: [] } };
    }),
    post: vi.fn(async (url: string) => {
      if (url === '/api/calls/c-lk-1/token') {
        return {
          data: {
            success: true,
            data: { token: 'lk-tok-1', wsUrl: 'wss://lk.test' },
          },
        };
      }
      return { data: { success: true, data: {} } };
    }),
    patch: vi.fn().mockResolvedValue({ data: { success: true, data: {} } }),
    defaults: { baseURL: '' },
  },
  getAccessToken: () => 'tok',
  getDeviceId: () => 'dev',
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: 'CLIENT', firstName: 'Tobias', lastName: 'Vera' },
  }),
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({
    socket: null,
    isConnected: false,
    joinConsultation: mockSocketFns.joinConsultation,
    leaveConsultation: mockSocketFns.leaveConsultation,
    emitEvent: mockSocketFns.emitEvent,
  }),
}));

vi.mock('../components/ui/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../vet/Consultations', () => ({
  EvolutionEditor: () => null,
  FichaClinica: () => null,
}));

import { LIVEKIT_ROOM_OPTIONS } from '../lib/livekitConfig';
import VetCallRoom from '../vet/CallRoom';
import { CallRoom as ComponentsCallRoom } from '../components/call/CallRoom';

describe('LiveKit adaptive simulcast & RoomOptions wiring', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    capturedLiveKitProps.length = 0;
    Element.prototype.scrollIntoView = vi.fn();
    window.history.pushState({}, '', '/call/c-lk-1?from=client');
  });

  it('defines LIVEKIT_ROOM_OPTIONS with adaptiveStream, dynacast, 720p capture and 180p/360p/720p simulcast', () => {
    expect(LIVEKIT_ROOM_OPTIONS.adaptiveStream).toBe(true);
    expect(LIVEKIT_ROOM_OPTIONS.dynacast).toBe(true);
    expect(LIVEKIT_ROOM_OPTIONS.videoCaptureDefaults?.resolution).toEqual(VideoPresets.h720.resolution);
    expect(LIVEKIT_ROOM_OPTIONS.publishDefaults).toEqual({
      simulcast: true,
      videoCodec: 'vp8',
      backupCodec: true,
      videoEncoding: VideoPresets.h720.encoding,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      degradationPreference: 'maintain-framerate',
    });
  });

  it('passes LIVEKIT_ROOM_OPTIONS to <LiveKitRoom> in web/src/vet/CallRoom.tsx', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={qc}>
        <VetCallRoom id="c-lk-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('mock-livekit-room')).toBeTruthy();
    });

    expect(capturedLiveKitProps.length).toBeGreaterThanOrEqual(1);
    const lastProps = capturedLiveKitProps[capturedLiveKitProps.length - 1];
    expect(lastProps.options as RoomOptions).toEqual(LIVEKIT_ROOM_OPTIONS);
  });

  it('passes LIVEKIT_ROOM_OPTIONS to <LiveKitRoom> in web/src/components/call/CallRoom.tsx', () => {
    render(<ComponentsCallRoom token="lk-tok-2" serverUrl="wss://lk.test" />);

    fireEvent.click(screen.getByText('Ingresar a la Consulta'));

    expect(screen.getByTestId('mock-livekit-room')).toBeTruthy();
    expect(capturedLiveKitProps.length).toBeGreaterThanOrEqual(1);
    const lastProps = capturedLiveKitProps[capturedLiveKitProps.length - 1];
    expect(lastProps.options as RoomOptions).toEqual(LIVEKIT_ROOM_OPTIONS);
  });
});
