import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const savedEnv = { ...process.env };
process.env.DISCONNECT_DEBOUNCE_MS = '120';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    consultation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    message: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
}));

import prisma from '../lib/prisma';
import { initializeSocketServer, io as serverIo } from '../realtime/socket.server';
import { disconnectQueue } from '../realtime/disconnectQueue';
import { consultationConcurrencyService } from '../modules/consultations/consultationConcurrency.service';

const mockPrismaUser = prisma.user as jest.Mocked<typeof prisma.user>;
const JWT_SECRET =
  process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Socket.io Debounced Disconnect Queue Integration', () => {
  let httpServer: HttpServer;
  let port: number;
  let markDisconnectSpy: jest.SpyInstance;
  let primaryIo: ReturnType<typeof initializeSocketServer>;
  const openSockets: ClientSocket[] = [];

  const mockClientUser = {
    id: 'tutor-dq-1',
    email: 'tutor-dq@huellicam.com',
    password: 'password',
    firstName: 'Tutor',
    lastName: 'Queue',
    phone: null,
    role: 'CLIENT' as const,
    vetStatus: null,
    licenseNumber: null,
    bio: null,
    photoUrl: null,
    tokenVersion: 1,
    ratingAvg: 0,
    ratingCount: 0,
    isOnline: true,
    lastSeen: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockVetUser = {
    ...mockClientUser,
    id: 'vet-dq-1',
    email: 'vet-dq@huellicam.com',
    role: 'VET' as const,
    vetStatus: 'APPROVED' as const,
  };

  const clientToken = jwt.sign(
    { userId: mockClientUser.id, role: mockClientUser.role, tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  const vetToken = jwt.sign(
    { userId: mockVetUser.id, role: mockVetUser.role, tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  const connectClient = (token: string, deviceId?: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const socket = Client(`http://localhost:${port}`, {
        auth: deviceId ? { token: `Bearer ${token}`, deviceId } : { token: `Bearer ${token}` },
        transports: ['websocket'],
      });
      openSockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  beforeAll((done) => {
    httpServer = createServer();
    primaryIo = initializeSocketServer(httpServer);
    httpServer.listen(() => {
      port = (httpServer.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(async () => {
    try {
      disconnectQueue.clear();
      for (const s of openSockets) {
        if (s.connected) s.disconnect();
      }
      primaryIo?.close();
      if (serverIo && serverIo !== primaryIo) {
        serverIo.close();
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      process.env = savedEnv;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    disconnectQueue.clear();
    mockPrismaUser.update.mockResolvedValue(mockClientUser as any);
    markDisconnectSpy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1, ok: true });
  });

  const disconnectAndWait = (socket: ClientSocket): Promise<void> =>
    new Promise((resolve) => {
      if (!socket.connected) {
        resolve();
        return;
      }
      socket.once('disconnect', () => resolve());
      socket.disconnect();
    });

  afterEach(async () => {
    const socketsToClose = openSockets.splice(0, openSockets.length);
    await Promise.all(socketsToClose.map((s) => disconnectAndWait(s)));
    await delay(20);
    disconnectQueue.clear();
    markDisconnectSpy.mockRestore();
  });

  it('enqueues CLIENT disconnect with deviceId without calling markSocketDisconnect synchronously', async () => {
    mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
    const socket = await connectClient(clientToken, 'dev-sync-check');

    socket.disconnect();
    await delay(25);

    expect(markDisconnectSpy).not.toHaveBeenCalled();
    expect(disconnectQueue.pendingCount).toBe(1);
  });

  it('cancels pending disconnect when CLIENT reconnects within debounce window', async () => {
    mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
    const socket1 = await connectClient(clientToken, 'dev-reconnect');

    socket1.disconnect();
    await delay(25);
    expect(disconnectQueue.pendingCount).toBe(1);

    const socket2 = await connectClient(clientToken, 'dev-reconnect');
    expect(disconnectQueue.pendingCount).toBe(0);

    await delay(200);
    expect(markDisconnectSpy).not.toHaveBeenCalled();
    await disconnectAndWait(socket2);
  });

  it('invokes markSocketDisconnect after debounce window when CLIENT stays disconnected', async () => {
    mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
    const socket = await connectClient(clientToken, 'dev-expire');

    socket.disconnect();
    await delay(220);

    expect(markDisconnectSpy).toHaveBeenCalledTimes(1);
    expect(markDisconnectSpy).toHaveBeenCalledWith(mockClientUser.id, 'dev-expire');
    expect(disconnectQueue.pendingCount).toBe(0);
  });

  it('does not enqueue VET disconnects or CLIENT disconnects without deviceId', async () => {
    mockPrismaUser.findUnique.mockResolvedValueOnce(mockVetUser as any);
    const vetSocket = await connectClient(vetToken, 'vet-dev-1');
    vetSocket.disconnect();

    mockPrismaUser.findUnique.mockResolvedValueOnce(mockClientUser as any);
    const noDevClient = await connectClient(clientToken);
    noDevClient.disconnect();

    await delay(200);
    expect(disconnectQueue.pendingCount).toBe(0);
    expect(markDisconnectSpy).not.toHaveBeenCalled();
  });

  it('clears pending timers when httpServer closes', async () => {
    const tempServer = createServer();
    initializeSocketServer(tempServer);
    await new Promise<void>((resolve) => tempServer.listen(() => resolve()));
    const tempPort = (tempServer.address() as AddressInfo).port;

    try {
      mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
      const tempClient = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${tempPort}`, {
          auth: { token: `Bearer ${clientToken}`, deviceId: 'dev-close-clear' },
          transports: ['websocket'],
        });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      tempClient.disconnect();
      await delay(25);
      expect(disconnectQueue.pendingCount).toBe(1);

      await new Promise<void>((resolve) => tempServer.close(() => resolve()));
      expect(disconnectQueue.pendingCount).toBe(0);

      await delay(200);
      expect(markDisconnectSpy).not.toHaveBeenCalled();
    } finally {
      if (tempServer.listening) {
        await new Promise<void>((resolve) => tempServer.close(() => resolve()));
      }
    }
  });

  it('does not trigger markSocketDisconnect when stale socket disconnects while another socket for same (tutorId, deviceId) stays connected', async () => {
    mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
    const s1 = await connectClient(clientToken, 'dev-overlap');
    const s2 = await connectClient(clientToken, 'dev-overlap');

    await disconnectAndWait(s1);
    await delay(220);

    expect(s2.connected).toBe(true);
    expect(disconnectQueue.pendingCount).toBe(0);
    expect(markDisconnectSpy).not.toHaveBeenCalled();

    await disconnectAndWait(s2);
    await delay(220);

    expect(markDisconnectSpy).toHaveBeenCalledTimes(1);
    expect(markDisconnectSpy).toHaveBeenCalledWith(mockClientUser.id, 'dev-overlap');
  });

  it('allows repeated initializeSocketServer(httpServer) calls without duplicate handleUpgrade errors', async () => {
    const tempServer = createServer();
    await new Promise<void>((resolve) => tempServer.listen(() => resolve()));
    const tempPort = (tempServer.address() as AddressInfo).port;

    let secondIo: ReturnType<typeof initializeSocketServer> | undefined;
    let tempClient: ClientSocket | undefined;

    try {
      initializeSocketServer(tempServer);
      secondIo = initializeSocketServer(tempServer);

      mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
      tempClient = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${tempPort}`, {
          auth: { token: `Bearer ${clientToken}`, deviceId: 'dev-reinit' },
          transports: ['websocket'],
          reconnection: false,
        });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      expect(tempClient.connected).toBe(true);
      await disconnectAndWait(tempClient);
    } finally {
      if (tempClient?.connected) {
        tempClient.disconnect();
      }
      secondIo?.close();
      if (tempServer.listening) {
        await new Promise<void>((resolve) => tempServer.close(() => resolve()));
      }
    }
  });

  it('aborts stale disconnect enqueue when a replacement socket connects while fetchSockets() is in flight', async () => {
    mockPrismaUser.findUnique.mockResolvedValue(mockClientUser as any);
    const r1 = await connectClient(clientToken, 'dev-toctou');

    const adapter = primaryIo.of('/').adapter;
    const originalFetchSockets = adapter.fetchSockets.bind(adapter);
    const fetchSpy = jest.spyOn(adapter, 'fetchSockets').mockImplementation(async (opts) => {
      const snapshot = await originalFetchSockets(opts);
      if (opts.rooms.has('device:dev-toctou')) {
        // Simulate async adapter roundtrip after capturing an empty snapshot
        await delay(60);
      }
      return snapshot;
    });

    try {
      r1.disconnect();
      // Let disconnect handler start fetchSockets() and capture stale snapshot before r2 connects
      await delay(15);

      const r2 = await connectClient(clientToken, 'dev-toctou');
      expect(r2.connected).toBe(true);
      expect(disconnectQueue.pendingCount).toBe(0);

      // Wait past both fetchSockets() delay (60ms) and DISCONNECT_DEBOUNCE_MS (120ms)
      await delay(220);

      expect(r2.connected).toBe(true);
      expect(disconnectQueue.pendingCount).toBe(0);
      expect(markDisconnectSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      await disconnectAndWait(r2);
      await delay(220);

      expect(markDisconnectSpy).toHaveBeenCalledTimes(1);
      expect(markDisconnectSpy).toHaveBeenCalledWith(mockClientUser.id, 'dev-toctou');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
