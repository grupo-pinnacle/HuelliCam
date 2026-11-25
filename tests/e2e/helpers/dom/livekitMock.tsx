import React from 'react';
import type { RoomOptions } from 'livekit-client';

export interface LiveKitCapturedProps {
  video?: boolean;
  audio?: boolean;
  token?: string;
  serverUrl?: string;
  connect?: boolean;
  options?: RoomOptions;
  onConnected?: () => void;
  onDisconnected?: (reason?: unknown) => void;
  children?: React.ReactNode;
  [key: string]: unknown;
}

export const capturedLiveKitProps: LiveKitCapturedProps[] = [];

export function resetCapturedLiveKitProps(): void {
  capturedLiveKitProps.length = 0;
}

export function getLatestLiveKitProps(): LiveKitCapturedProps | undefined {
  return capturedLiveKitProps[capturedLiveKitProps.length - 1];
}

export function createLiveKitMockFactory() {
  const LiveKitRoom: React.FC<LiveKitCapturedProps> = (props) => {
    capturedLiveKitProps.push({ ...props });
    return (
      <div
        data-testid="mock-livekit-room"
        data-token={props.token ?? ''}
        data-server-url={props.serverUrl ?? ''}
        data-has-options={props.options ? 'true' : 'false'}
      >
        {props.children}
      </div>
    );
  };

  const VideoConference: React.FC = () => (
    <div data-testid="mock-video-conference">Mock VideoConference</div>
  );

  const RoomAudioRenderer: React.FC = () => null;

  const useLocalParticipant = () => ({
    localParticipant: {
      setMicrophoneEnabled: async () => undefined,
      setCameraEnabled: async () => undefined,
    },
  });

  const useRoomContext = () => ({});

  return {
    LiveKitRoom,
    VideoConference,
    RoomAudioRenderer,
    useLocalParticipant,
    useRoomContext,
  };
}
