import http from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { Server as SocketIOServer, type Socket as ServerSocket } from 'socket.io';
import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { vi } from 'vitest';

export interface E2EUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'CLIENT' | 'VET' | 'ADMIN';
  vetStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  licenseNumber?: string | null;
  isOnline?: boolean;
}

export interface E2EConsultation {
  id: string;
  clientId: string;
  vetId: string | null;
  petId: string;
  status: string;
  notes?: string;
  diagnosisNotes?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  pet?: {
    id: string;
    name: string;
    species: string;
    breed?: string | null;
    weightKg?: number | null;
    sex?: string | null;
  };
  client?: {
    id?: string;
    firstName: string;
    lastName?: string;
  };
  vet?: {
    id?: string;
    firstName: string;
    lastName?: string;
  } | null;
}

export interface E2EPrescription {
  id: string;
  consultationId: string;
  vetId: string;
  clientId?: string;
  medication: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  indications: string;
  createdAt: string;
  verifyUrl?: string;
  qrCodeDataUrl?: string;
  consultation?: E2EConsultation;
  vet?: {
    firstName: string;
    lastName: string;
    licenseNumber?: string;
  };
  pet?: {
    name: string;
    species: string;
    breed?: string;
  };
}

export interface E2ECallRecord {
  id: string;
  consultationId: string;
  roomName: string;
  status: 'INITIATED' | 'ACTIVE' | 'ENDED' | 'FAILED';
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  livekitRoomSid?: string | null;
  participantsJoined: number;
  errorMessage?: string | null;
}

export interface HttpLogEntry {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  timestamp: number;
}

export interface SocketConnectionRecord {
  id: string;
  auth: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  joinedRooms: string[];
  connectedAt: number;
  disconnectedAt?: number;
}

export interface SocketEmittedEventRecord {
  socketId: string;
  event: string;
  payload: unknown;
}

export interface FrontendHarnessState {
  currentUser: E2EUser | null;
  consultations: E2EConsultation[];
  messages: Record<string, Array<Record<string, unknown>>>;
  prescriptions: E2EPrescription[];
  notifications: Array<Record<string, unknown>>;
  pets: Array<Record<string, unknown>>;
  calls: Record<string, E2ECallRecord>;
  livekitWsUrl: string;
}

export interface FrontendE2EServer {
  url: string;
  port: number;
  app: Express;
  io: SocketIOServer;
  state: FrontendHarnessState;
  httpLog: HttpLogEntry[];
  totalConnections: number;
  activeSocketIds: Set<string>;
  socketConnections: SocketConnectionRecord[];
  socketEmittedEvents: SocketEmittedEventRecord[];
  emitToAll: (event: string, payload?: unknown) => void;
  emitToRoom: (room: string, event: string, payload?: unknown) => void;
  disconnectAllSockets: (closeTransport?: boolean) => void;
  getHttpCalls: (method?: string, pathSubstring?: string) => HttpLogEntry[];
  resetLogs: () => void;
  close: () => Promise<void>;
}

export function createDefaultVetUser(overrides: Partial<E2EUser> = {}): E2EUser {
  return {
    id: 'vet-1',
    email: 'vet@huellicam.test',
    firstName: 'Lucia',
    lastName: 'Mendez',
    role: 'VET',
    vetStatus: 'APPROVED',
    licenseNumber: 'MP-4421',
    isOnline: true,
    ...overrides,
  };
}

export function createDefaultClientUser(overrides: Partial<E2EUser> = {}): E2EUser {
  return {
    id: 'client-1',
    email: 'tutor@huellicam.test',
    firstName: 'Mateo',
    lastName: 'Gomez',
    role: 'CLIENT',
    ...overrides,
  };
}

export function createDefaultConsultation(
  overrides: Partial<E2EConsultation> = {}
): E2EConsultation {
  return {
    id: 'c-1',
    clientId: 'client-1',
    vetId: 'vet-1',
    petId: 'pet-1',
    status: 'ACTIVE',
    notes: '[PRIORIDAD:AMARILLO] Decaimiento y falta de apetito',
    createdAt: '2026-11-18T18:00:00.000Z',
    startedAt: '2026-11-18T18:01:00.000Z',
    pet: {
      id: 'pet-1',
      name: 'Milo',
      species: 'Canino',
      breed: 'Golden Retriever',
      weightKg: 24,
      sex: 'Macho',
    },
    client: {
      id: 'client-1',
      firstName: 'Mateo',
      lastName: 'Gomez',
    },
    vet: {
      id: 'vet-1',
      firstName: 'Lucia',
      lastName: 'Mendez',
    },
    ...overrides,
  };
}

export async function createFrontendE2EServer(
  initialState: Partial<FrontendHarnessState> = {}
): Promise<FrontendE2EServer> {
  const app = express();
  const httpServer = http.createServer(app);
  const allowedHeaders = [
    'Content-Type',
    'Authorization',
    'X-Client-Platform',
    'X-Device-Id',
    'x-device-id',
    'X-Request-Id',
    'X-Correlation-Id',
  ];

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
      allowedHeaders,
    },
  });

  const state: FrontendHarnessState = {
    currentUser: initialState.currentUser ?? createDefaultVetUser(),
    consultations: initialState.consultations ?? [createDefaultConsultation()],
    messages: initialState.messages ?? {},
    prescriptions: initialState.prescriptions ?? [],
    notifications: initialState.notifications ?? [],
    pets: initialState.pets ?? [
      {
        id: 'pet-1',
        name: 'Milo',
        species: 'Canino',
        breed: 'Golden Retriever',
        weightKg: 24,
        sex: 'Macho',
        createdAt: '2026-11-18T18:00:00.000Z',
      },
    ],
    calls: initialState.calls ?? {},
    livekitWsUrl: initialState.livekitWsUrl ?? 'wss://mock-livekit.local',
  };

  const httpLog: HttpLogEntry[] = [];
  const activeSocketIds = new Set<string>();
  const socketConnections: SocketConnectionRecord[] = [];
  const socketEmittedEvents: SocketEmittedEventRecord[] = [];
  const liveSockets = new Map<string, ServerSocket>();

  let totalConnections = 0;

  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Correlation-Id');

    const incomingReqId = req.headers['x-request-id'];
    const incomingCorrId = req.headers['x-correlation-id'];
    if (typeof incomingReqId === 'string' && incomingReqId.trim()) {
      res.setHeader('X-Request-Id', incomingReqId);
    }
    if (typeof incomingCorrId === 'string' && incomingCorrId.trim()) {
      res.setHeader('X-Correlation-Id', incomingCorrId);
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());

  app.use((req: Request, _res: Response, next) => {
    httpLog.push({
      method: req.method,
      path: req.path,
      url: req.originalUrl,
      headers: { ...req.headers },
      body: req.body,
      timestamp: Date.now(),
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ success: true, status: 'ok' });
  });

  app.get('/api/auth/me', (_req, res) => {
    if (!state.currentUser) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
      return;
    }
    res.json({ success: true, data: { user: state.currentUser } });
  });

  app.post('/api/auth/login', (_req, res) => {
    const user = state.currentUser ?? createDefaultClientUser();
    res.json({
      success: true,
      data: { user, accessToken: 'e2e-login-token' },
    });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.json({ success: true, data: { loggedOut: true } });
  });

  app.post('/api/auth/refresh', (_req, res) => {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'No refresh token' },
    });
  });

  app.get('/api/consultations/mine', (_req, res) => {
    res.json({ success: true, data: state.consultations });
  });

  app.post('/api/consultations', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const created = createDefaultConsultation({
      id: `c-${state.consultations.length + 1}`,
      petId: typeof body.petId === 'string' ? body.petId : 'pet-1',
      status: 'WAITING',
      vetId: null,
      vet: null,
      notes: typeof body.notes === 'string' ? body.notes : 'Consulta creada en E2E',
    });
    state.consultations.unshift(created);
    res.status(201).json({ success: true, data: created });
  });

  app.get('/api/consultations/:id', (req, res) => {
    const found = state.consultations.find((c) => c.id === req.params.id);
    if (!found) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Consultation not found' },
      });
      return;
    }
    res.json({ success: true, data: found });
  });

  app.patch('/api/consultations/:id/assign', (req, res) => {
    const found = state.consultations.find((c) => c.id === req.params.id);
    if (!found) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Consultation not found' },
      });
      return;
    }
    found.status = 'ACTIVE';
    found.vetId = state.currentUser?.id ?? 'vet-1';
    found.vet = {
      id: found.vetId,
      firstName: state.currentUser?.firstName ?? 'Lucia',
      lastName: state.currentUser?.lastName ?? 'Mendez',
    };
    found.startedAt = new Date().toISOString();
    res.json({ success: true, data: found });
  });

  app.patch('/api/consultations/:id/complete', (req, res) => {
    const found = state.consultations.find((c) => c.id === req.params.id);
    if (!found) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Consultation not found' },
      });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    found.status = 'COMPLETED';
    found.endedAt = new Date().toISOString();
    if (typeof body.diagnosisNotes === 'string') {
      found.diagnosisNotes = body.diagnosisNotes;
    }
    res.json({ success: true, data: found });
  });

  app.patch('/api/consultations/:id/cancel', (req, res) => {
    const found = state.consultations.find((c) => c.id === req.params.id);
    if (!found) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Consultation not found' },
      });
      return;
    }
    found.status = 'CANCELLED';
    res.json({ success: true, data: found });
  });

  app.get('/api/consultations/:id/messages', (req, res) => {
    res.json({ success: true, data: state.messages[req.params.id] ?? [] });
  });

  app.post('/api/consultations/:id/messages', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const list = state.messages[req.params.id] ?? [];
    const created = {
      id: `msg-${list.length + 1}`,
      consultationId: req.params.id,
      content: body.content ?? '',
      clientMsgId: body.clientMsgId ?? `client-${Date.now()}`,
      senderId: state.currentUser?.id ?? 'vet-1',
      createdAt: new Date().toISOString(),
    };
    list.push(created);
    state.messages[req.params.id] = list;
    res.status(201).json({ success: true, data: created });
  });

  app.post('/api/consultations/:id/prescriptions', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = `rx-${state.prescriptions.length + 1}`;
    const consultation = state.consultations.find((c) => c.id === req.params.id);
    const created: E2EPrescription = {
      id,
      consultationId: req.params.id,
      vetId: state.currentUser?.id ?? 'vet-1',
      clientId: consultation?.clientId ?? 'client-1',
      medication: String(body.medication ?? 'Amoxicilina 250mg'),
      dosage: String(body.dosage ?? '1 comprimido'),
      frequency: String(body.frequency ?? 'Cada 12 horas'),
      durationDays: Number(body.durationDays ?? 7),
      indications: String(body.indications ?? 'Administrar con alimento'),
      createdAt: new Date().toISOString(),
      verifyUrl: `${harness.url}/verify-rx?code=${id}`,
      qrCodeDataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      consultation,
    };
    state.prescriptions.unshift(created);
    res.status(201).json({ success: true, data: created });
  });

  app.post('/api/calls/:id/token', (req, res) => {
    const consultationId = String(req.params.id);
    const existing = state.calls[consultationId];
    if (!existing) {
      state.calls[consultationId] = {
        id: `call-${consultationId}`,
        consultationId,
        roomName: consultationId,
        status: 'INITIATED',
        startedAt: null,
        endedAt: null,
        durationSeconds: null,
        livekitRoomSid: null,
        participantsJoined: 0,
      };
    }
    res.json({
      success: true,
      data: {
        token: `livekit-token-${consultationId}`,
        wsUrl: state.livekitWsUrl,
        roomName: consultationId,
      },
    });
  });

  app.post('/api/calls/webhook', (req, res) => {
    const body = (req.body ?? {}) as {
      event?: string;
      room?: { name?: string; sid?: string };
      error?: string;
      timestamp?: number;
    };
    const roomName = body.room?.name;
    if (roomName && state.calls[roomName]) {
      const record = state.calls[roomName];
      if (body.event === 'room_started') {
        record.status = 'ACTIVE';
        record.startedAt = new Date().toISOString();
        record.livekitRoomSid = body.room?.sid ?? 'RM_e2e_123';
      } else if (body.event === 'participant_joined') {
        record.participantsJoined += 1;
      } else if (body.event === 'room_finished') {
        record.status = 'ENDED';
        record.endedAt = new Date().toISOString();
        const startMs = record.startedAt ? Date.parse(record.startedAt) : Date.now() - 120_000;
        const endMs = Date.parse(record.endedAt);
        record.durationSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));
      } else if (body.event === 'participant_connection_aborted') {
        record.errorMessage = body.error ?? 'Connection aborted';
      }
    }
    res.status(200).json({ success: true });
  });

  app.get('/api/notifications', (_req, res) => {
    res.json({ success: true, data: state.notifications });
  });

  app.patch('/api/notifications/:id/read', (req, res) => {
    const target = state.notifications.find((n) => n.id === req.params.id);
    if (target) {
      target.isRead = true;
    }
    res.json({ success: true, data: target ?? { id: req.params.id, isRead: true } });
  });

  app.get('/api/prescriptions', (_req, res) => {
    res.json({ success: true, data: state.prescriptions });
  });

  app.get('/api/prescriptions/:id', (req, res) => {
    const found = state.prescriptions.find((rx) => rx.id === req.params.id);
    if (!found) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Prescription not found' },
      });
      return;
    }
    res.json({ success: true, data: found });
  });

  app.get('/api/pets', (_req, res) => {
    res.json({ success: true, data: state.pets });
  });

  app.patch('/api/users/profile', (req, res) => {
    if (state.currentUser && typeof (req.body as { isOnline?: boolean })?.isOnline === 'boolean') {
      state.currentUser.isOnline = (req.body as { isOnline: boolean }).isOnline;
    }
    res.json({ success: true, data: state.currentUser });
  });

  io.on('connection', (socket) => {
    totalConnections += 1;
    harness.totalConnections = totalConnections;
    activeSocketIds.add(socket.id);
    liveSockets.set(socket.id, socket);

    const record: SocketConnectionRecord = {
      id: socket.id,
      auth: { ...(socket.handshake.auth as Record<string, unknown>) },
      headers: { ...socket.handshake.headers },
      joinedRooms: [],
      connectedAt: Date.now(),
    };
    socketConnections.push(record);

    socket.on('join:consultation', (payload: { consultationId?: string }) => {
      socketEmittedEvents.push({ socketId: socket.id, event: 'join:consultation', payload });
      if (payload?.consultationId) {
        const room = `consultation:${payload.consultationId}`;
        void socket.join(room);
        if (!record.joinedRooms.includes(room)) {
          record.joinedRooms.push(room);
        }
      }
    });

    socket.on('leave:consultation', (payload: { consultationId?: string }) => {
      socketEmittedEvents.push({ socketId: socket.id, event: 'leave:consultation', payload });
      if (payload?.consultationId) {
        const room = `consultation:${payload.consultationId}`;
        void socket.leave(room);
        record.joinedRooms = record.joinedRooms.filter((r) => r !== room);
      }
    });

    socket.on('call:ended', (payload: unknown) => {
      socketEmittedEvents.push({ socketId: socket.id, event: 'call:ended', payload });
    });

    socket.on('call:rejected', (payload: unknown) => {
      socketEmittedEvents.push({ socketId: socket.id, event: 'call:rejected', payload });
    });

    socket.on('message:send', (payload: unknown, ack?: (res: unknown) => void) => {
      socketEmittedEvents.push({ socketId: socket.id, event: 'message:send', payload });
      if (typeof ack === 'function') {
        ack({
          success: true,
          data: {
            id: `msg-ws-${Date.now()}`,
            ...(typeof payload === 'object' && payload !== null ? payload : {}),
            senderId: state.currentUser?.id ?? 'vet-1',
            createdAt: new Date().toISOString(),
          },
        });
      }
    });

    socket.on('disconnect', () => {
      activeSocketIds.delete(socket.id);
      liveSockets.delete(socket.id);
      record.disconnectedAt = Date.now();
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const harness: FrontendE2EServer = {
    url,
    port,
    app,
    io,
    state,
    httpLog,
    totalConnections,
    activeSocketIds,
    socketConnections,
    socketEmittedEvents,
    emitToAll: (event, payload) => {
      io.emit(event, payload);
    },
    emitToRoom: (room, event, payload) => {
      io.to(room).emit(event, payload);
    },
    disconnectAllSockets: (closeTransport = true) => {
      io.disconnectSockets(closeTransport);
    },
    getHttpCalls: (method?: string, pathSubstring?: string) => {
      return httpLog.filter((entry) => {
        if (method && entry.method.toUpperCase() !== method.toUpperCase()) {
          return false;
        }
        if (pathSubstring && !entry.path.includes(pathSubstring)) {
          return false;
        }
        return true;
      });
    },
    resetLogs: () => {
      httpLog.length = 0;
      socketEmittedEvents.length = 0;
    },
    close: async () => {
      io.disconnectSockets(true);
      liveSockets.forEach((s) => s.disconnect(true));
      liveSockets.clear();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };

  return harness;
}

export interface BootFrontendOptions {
  serverUrl: string;
  user?: E2EUser | null;
  token?: string | null;
  deviceId?: string;
  initialPath?: string;
}

export async function bootFrontendApp(options: BootFrontendOptions) {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', options.serverUrl);
  vi.stubEnv('VITE_WS_URL', options.serverUrl);

  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(
    'huellicam_cookie_consent',
    JSON.stringify({
      essential: true,
      analytics: false,
      acceptedAt: '2026-11-18T00:00:00.000Z',
    })
  );

  if (options.deviceId) {
    window.localStorage.setItem('huellicam_device_id', options.deviceId);
  }
  if (options.token) {
    window.localStorage.setItem('huellicam_token', options.token);
  }
  if (options.user) {
    window.localStorage.setItem('huellicam_user', JSON.stringify(options.user));
  }

  window.history.pushState({}, '', options.initialPath ?? '/');

  const apiModule = await import('@/services/api');
  apiModule.setAccessToken(options.token ?? null);

  const authModule = await import('@/context/AuthContext');
  const appModule = await import('@/App');

  return {
    App: appModule.App,
    api: apiModule.default,
    setAccessToken: apiModule.setAccessToken,
    getAccessToken: apiModule.getAccessToken,
    AuthProvider: authModule.AuthProvider,
    useAuth: authModule.useAuth,
  };
}

export interface SpyAdapterEntry {
  method: string;
  url: string;
  headers: Record<string, unknown>;
}

export function installAxiosSpyAdapter(
  apiInstance: AxiosInstance,
  handler: (config: InternalAxiosRequestConfig) => { status?: number; data: unknown }
): { requests: SpyAdapterEntry[]; restore: () => void } {
  const originalAdapter = apiInstance.defaults.adapter;
  const requests: SpyAdapterEntry[] = [];

  apiInstance.defaults.adapter = async (
    config: InternalAxiosRequestConfig
  ): Promise<AxiosResponse> => {
    const method = (config.method || 'GET').toUpperCase();
    const url = config.url || '';
    requests.push({
      method,
      url,
      headers: { ...(config.headers as Record<string, unknown>) },
    });

    const result = handler(config);
    return {
      data: result.data,
      status: result.status ?? 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };

  return {
    requests,
    restore: () => {
      apiInstance.defaults.adapter = originalAdapter;
    },
  };
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
