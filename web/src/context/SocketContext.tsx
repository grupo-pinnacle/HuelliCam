import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import { getAccessToken, getDeviceId } from '../services/api';
import { getWsUrl } from '../lib/ws';

export interface ConsultationAssignedPayload {
  consultationId?: string;
  vetId?: string | null;
  clientId?: string;
  status?: string;
}

export interface ConsultationCancelledPayload {
  consultationId?: string;
  cancelledBy?: string;
  status?: string;
}

export interface CallEndedPayload {
  consultationId?: string;
  endedBy?: string;
}

export interface NotificationNewPayload {
  id?: string;
  type?: string;
  data?: { consultationId?: string } | null;
  metadata?: { consultationId?: string } | null;
}

export interface PrescriptionNewPayload {
  consultationId?: string;
  prescriptionId?: string;
  petId?: string;
}

export interface VetPresencePayload {
  vetId?: string;
  isOnline?: boolean;
  lastSeen?: string;
}

export interface SessionTerminatedPayload {
  reason?: string;
  message?: string;
  consultationId?: string;
}

export interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  joinConsultation: (consultationId: string) => void;
  leaveConsultation: (consultationId: string) => void;
  emitEvent: <T = unknown>(
    event: string,
    payload?: unknown,
    ack?: (res: T) => void
  ) => boolean;
}

const NOOP_SOCKET_CONTEXT: SocketContextValue = {
  socket: null,
  isConnected: false,
  joinConsultation: () => {},
  leaveConsultation: () => {},
  emitEvent: () => false,
};

const SocketContext = createContext<SocketContextValue | undefined>(undefined);

function createCorrelationId(): string {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fallback below
  }
  return `corr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveToken(): string | null {
  try {
    const token = typeof getAccessToken === 'function' ? getAccessToken() : null;
    if (token) return token;
  } catch {
    // Ignore mock errors
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem('huellicam_token');
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function resolveDeviceId(): string {
  try {
    if (typeof getDeviceId === 'function') {
      return getDeviceId();
    }
  } catch {
    // Fallback for partial test mocks
  }
  return 'web';
}

export const SocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user, loading, refreshSession } = useAuth();
  const queryClient = useContext(QueryClientContext);

  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const refreshSessionRef = useRef(refreshSession);
  refreshSessionRef.current = refreshSession;

  const socketRef = useRef<Socket | null>(null);
  const activeUserIdRef = useRef<string | null>(null);
  const lastUserIdRef = useRef<string | null>(null);
  const roomRefCountsRef = useRef<Map<string, number>>(new Map());
  const hasConnectedOnceRef = useRef<boolean>(false);
  const refreshingOnErrorRef = useRef<boolean>(false);
  const correlationIdRef = useRef<string>(createCorrelationId());

  const [socketInstance, setSocketInstance] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  const buildAuthPayload = useCallback(() => {
    const rawToken = resolveToken();
    return {
      token: rawToken ? `Bearer ${rawToken}` : undefined,
      deviceId: resolveDeviceId(),
      correlationId: correlationIdRef.current,
    };
  }, []);

  const userId = user?.id ?? null;
  const hasToken = Boolean(resolveToken());
  const canConnect = Boolean(userId) && (!loading || hasToken);

  // Sync socket.auth whenever user object updates without recreating the socket
  useEffect(() => {
    if (socketRef.current && user?.id && activeUserIdRef.current === user.id) {
      socketRef.current.auth = buildAuthPayload();
    }
  }, [user, buildAuthPayload]);

  // Sync socket.auth across tabs on storage updates
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'huellicam_token' && socketRef.current) {
        socketRef.current.auth = buildAuthPayload();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [buildAuthPayload]);

  // Singleton socket lifecycle keyed by userId + auth readiness
  useEffect(() => {
    const userChanged =
      lastUserIdRef.current !== null && lastUserIdRef.current !== userId;
    lastUserIdRef.current = userId;

    if (!userId || !canConnect) {
      const shouldClearRooms =
        !userId ||
        userChanged ||
        (activeUserIdRef.current !== null && activeUserIdRef.current !== userId);
      if (socketRef.current) {
        socketRef.current.removeAllListeners?.();
        socketRef.current.disconnect?.();
        socketRef.current = null;
      }
      activeUserIdRef.current = null;
      hasConnectedOnceRef.current = false;
      if (shouldClearRooms) {
        roomRefCountsRef.current.clear();
      }
      setIsConnected(false);
      setSocketInstance(null);
      return;
    }

    if (userChanged) {
      roomRefCountsRef.current.clear();
    }

    if (socketRef.current && activeUserIdRef.current === userId) {
      socketRef.current.auth = buildAuthPayload();
      return;
    }

    const socket = io(getWsUrl(), {
      withCredentials: true,
      transports: ['polling', 'websocket'],
      reconnection: true,
      auth: buildAuthPayload(),
    });

    socketRef.current = socket;
    activeUserIdRef.current = userId;
    hasConnectedOnceRef.current = Boolean(socket.connected);
    setSocketInstance(socket);
    setIsConnected(Boolean(socket.connected));

    const handleConnect = () => {
      const isReconnect = hasConnectedOnceRef.current;
      hasConnectedOnceRef.current = true;
      refreshingOnErrorRef.current = false;
      setIsConnected(true);

      roomRefCountsRef.current.forEach((count, consultationId) => {
        if (count > 0) {
          socket.emit?.('join:consultation', { consultationId });
        }
      });

      const qc = queryClientRef.current;
      if (isReconnect && qc) {
        void qc.invalidateQueries({ queryKey: ['consultations'] });
        roomRefCountsRef.current.forEach((count, consultationId) => {
          if (count > 0) {
            void qc.invalidateQueries({ queryKey: ['consultation', consultationId] });
          }
        });
      }
    };

    const handleDisconnect = () => {
      setIsConnected(false);
    };

    const handleConnectError = (err?: Error) => {
      setIsConnected(false);
      socket.auth = buildAuthPayload();
      const message = err?.message || '';
      if (/expired|invalid|token|revoked/i.test(message) && !refreshingOnErrorRef.current) {
        refreshingOnErrorRef.current = true;
        Promise.resolve(refreshSessionRef.current?.(true))
          .catch(() => {})
          .finally(() => {
            refreshingOnErrorRef.current = false;
            if (socketRef.current === socket) {
              socket.auth = buildAuthPayload();
            }
          });
      }
    };

    const handleReconnectAttempt = () => {
      socket.auth = buildAuthPayload();
    };

    const dispatchSessionTerminated = (reason: string, message: string) => {
      socket.disconnect?.();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('huellicam:session_terminated', {
            detail: { reason, message },
          })
        );
      }
    };

    const handleSessionTerminated = (data?: SessionTerminatedPayload) => {
      dispatchSessionTerminated(
        data?.reason || 'CONCURRENT_LOGIN',
        data?.message ||
          'Se ha iniciado sesión desde otro dispositivo. Tu sesión ha sido finalizada.'
      );
    };

    const handleSessionInvalidated = (data?: SessionTerminatedPayload) => {
      dispatchSessionTerminated(
        data?.reason || 'MULTIPLE_DEVICES_DETECTED',
        data?.message || 'Tu sesión fue transferida a otro dispositivo.'
      );
    };

    const handleConsultationNew = () => {
      const qc = queryClientRef.current;
      if (!qc) return;
      void qc.invalidateQueries({ queryKey: ['consultations', 'vet'] });
      void qc.invalidateQueries({ queryKey: ['consultations'], exact: true });
    };

    const handleConsultationAssigned = (data?: ConsultationAssignedPayload) => {
      const qc = queryClientRef.current;
      if (!qc) return;
      if (data?.consultationId) {
        void qc.invalidateQueries({ queryKey: ['consultation', data.consultationId] });
      }
      void qc.invalidateQueries({ queryKey: ['consultations', 'vet'] });
      void qc.invalidateQueries({ queryKey: ['consultations', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['consultations'], exact: true });
    };

    const handleConsultationCancelled = (data?: ConsultationCancelledPayload) => {
      const qc = queryClientRef.current;
      if (!qc) return;
      if (data?.consultationId) {
        void qc.invalidateQueries({ queryKey: ['consultation', data.consultationId] });
      }
      void qc.invalidateQueries({ queryKey: ['consultations', 'vet'] });
      void qc.invalidateQueries({ queryKey: ['consultations', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['consultations'], exact: true });
    };

    const handleCallEnded = (data?: CallEndedPayload) => {
      const qc = queryClientRef.current;
      if (!qc) return;
      if (data?.consultationId) {
        void qc.invalidateQueries({ queryKey: ['consultation', data.consultationId] });
      }
      void qc.invalidateQueries({ queryKey: ['consultations'] });
    };

    const handleNotificationNew = (data?: NotificationNewPayload) => {
      const qc = queryClientRef.current;
      if (!qc) return;
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      const cid = data?.metadata?.consultationId ?? data?.data?.consultationId;
      if (cid || data?.type === 'CONSULTATION_ASSIGNED') {
        if (cid) {
          void qc.invalidateQueries({ queryKey: ['consultation', cid] });
        }
        void qc.invalidateQueries({ queryKey: ['consultations', 'mine'] });
        void qc.invalidateQueries({ queryKey: ['consultations'], exact: true });
      }
    };

    const handlePrescriptionNew = (data?: PrescriptionNewPayload) => {
      const qc = queryClientRef.current;
      if (!qc) return;
      void qc.invalidateQueries({ queryKey: ['prescriptions'] });
      if (data?.consultationId) {
        void qc.invalidateQueries({ queryKey: ['consultation', data.consultationId] });
      }
    };

    const handleVetPresence = () => {
      const qc = queryClientRef.current;
      if (!qc) return;
      void qc.invalidateQueries({ queryKey: ['consultations'] });
    };

    socket.on?.('connect', handleConnect);
    socket.on?.('disconnect', handleDisconnect);
    socket.on?.('connect_error', handleConnectError);
    socket.io?.on?.('reconnect_attempt', handleReconnectAttempt);
    socket.on?.('auth:session_terminated', handleSessionTerminated);
    socket.on?.('session:invalidated', handleSessionInvalidated);
    socket.on?.('consultation:new', handleConsultationNew);
    socket.on?.('consultation:assigned', handleConsultationAssigned);
    socket.on?.('consultation:cancelled', handleConsultationCancelled);
    socket.on?.('call:ended', handleCallEnded);
    socket.on?.('notification:new', handleNotificationNew);
    socket.on?.('prescription:new', handlePrescriptionNew);
    socket.on?.('vet:presence', handleVetPresence);

    return () => {
      socket.io?.off?.('reconnect_attempt', handleReconnectAttempt);
      socket.off?.('connect', handleConnect);
      socket.off?.('disconnect', handleDisconnect);
      socket.off?.('connect_error', handleConnectError);
      socket.off?.('auth:session_terminated', handleSessionTerminated);
      socket.off?.('session:invalidated', handleSessionInvalidated);
      socket.off?.('consultation:new', handleConsultationNew);
      socket.off?.('consultation:assigned', handleConsultationAssigned);
      socket.off?.('consultation:cancelled', handleConsultationCancelled);
      socket.off?.('call:ended', handleCallEnded);
      socket.off?.('notification:new', handleNotificationNew);
      socket.off?.('prescription:new', handlePrescriptionNew);
      socket.off?.('vet:presence', handleVetPresence);
      socket.removeAllListeners?.();
      socket.disconnect?.();

      if (socketRef.current === socket) {
        socketRef.current = null;
        activeUserIdRef.current = null;
        hasConnectedOnceRef.current = false;
        roomRefCountsRef.current.clear();
        setIsConnected(false);
        setSocketInstance(null);
      }
    };
  }, [userId, canConnect, buildAuthPayload]);

  const joinConsultation = useCallback((consultationId: string) => {
    const trimmed = consultationId?.trim();
    if (!trimmed) return;
    const prev = roomRefCountsRef.current.get(trimmed) ?? 0;
    roomRefCountsRef.current.set(trimmed, prev + 1);
    if (prev === 0 && socketRef.current?.connected) {
      socketRef.current.emit?.('join:consultation', { consultationId: trimmed });
    }
  }, []);

  const leaveConsultation = useCallback((consultationId: string) => {
    const trimmed = consultationId?.trim();
    if (!trimmed) return;
    const prev = roomRefCountsRef.current.get(trimmed) ?? 0;
    if (prev <= 0) return;
    if (prev === 1) {
      roomRefCountsRef.current.delete(trimmed);
      if (socketRef.current?.connected) {
        socketRef.current.emit?.('leave:consultation', { consultationId: trimmed });
      }
    } else {
      roomRefCountsRef.current.set(trimmed, prev - 1);
    }
  }, []);

  const emitEvent = useCallback(
    <T = unknown>(event: string, payload?: unknown, ack?: (res: T) => void): boolean => {
      const currentSocket = socketRef.current;
      if (!currentSocket || typeof currentSocket.emit !== 'function') {
        return false;
      }
      if (typeof ack === 'function') {
        currentSocket.emit(event, payload, ack);
      } else if (payload !== undefined) {
        currentSocket.emit(event, payload);
      } else {
        currentSocket.emit(event);
      }
      return true;
    },
    []
  );

  const value = useMemo<SocketContextValue>(
    () => ({
      socket: socketInstance,
      isConnected,
      joinConsultation,
      leaveConsultation,
      emitEvent,
    }),
    [socketInstance, isConnected, joinConsultation, leaveConsultation, emitEvent]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = (): SocketContextValue => {
  return useContext(SocketContext) ?? NOOP_SOCKET_CONTEXT;
};
