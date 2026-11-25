import React, { useState, useEffect } from 'react';
import { LiveKitRoom, VideoConference } from '@livekit/components-react';
import '@livekit/components-styles';
import { PreJoinModal } from './PreJoinModal';
import { postMobileBridgeMessage } from '../../lib/mobileBridge';
import { LIVEKIT_ROOM_OPTIONS } from '../../lib/livekitConfig';

interface CallRoomProps {
  token: string;
  serverUrl?: string;
  onDisconnected?: () => void;
}

export const CallRoom: React.FC<CallRoomProps> = ({
  token,
  serverUrl = import.meta.env.VITE_LIVEKIT_URL || 'wss://huellicam-dev.livekit.cloud',
  onDisconnected,
}) => {
  const [hasJoined, setHasJoined] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [videoEnabled, setVideoEnabled] = useState<boolean>(true);

  // Emit page:ready handshake for mobile WebView wrapper
  useEffect(() => {
    postMobileBridgeMessage({ type: 'page:ready' });
  }, []);

  // Screen WakeLock while in call
  useEffect(() => {
    type WakeLockNavigator = Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    let wakeLockSentinel: { release: () => Promise<void> } | null = null;

    const requestWakeLock = async () => {
      try {
        const nav = typeof navigator !== 'undefined' ? (navigator as WakeLockNavigator) : undefined;
        if (nav?.wakeLock?.request) {
          wakeLockSentinel = await nav.wakeLock.request('screen');
        }
      } catch {
        // Silently swallow per specification
      }
    };

    void requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
      }
    };
  }, []);

  const handleJoin = (audio: boolean, video: boolean) => {
    setAudioEnabled(audio);
    setVideoEnabled(video);
    setHasJoined(true);
  };

  const handleDisconnected = () => {
    postMobileBridgeMessage({ type: 'call:ended' });
    onDisconnected?.();
  };

  if (!hasJoined) {
    return <PreJoinModal onJoin={handleJoin} onCancel={handleDisconnected} />;
  }

  return (
    <div className="w-full h-[100dvh] max-h-[100dvh] overflow-hidden flex flex-col bg-slate-900">
      <LiveKitRoom
        video={videoEnabled}
        audio={audioEnabled}
        token={token}
        serverUrl={serverUrl}
        connect={true}
        options={LIVEKIT_ROOM_OPTIONS}
        onDisconnected={handleDisconnected}
        data-lk-theme="default"
        style={{ height: '100%' }}
      >
        {/* Antipattern 3 Guardrail: Exclusively VideoConference. Do NOT add RoomAudioRenderer */}
        <VideoConference />
      </LiveKitRoom>
    </div>
  );
};

export default CallRoom;
