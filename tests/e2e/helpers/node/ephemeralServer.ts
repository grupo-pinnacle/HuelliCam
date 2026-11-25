import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Express } from 'express';
import jwt from 'jsonwebtoken';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import { Server as SocketIOServer } from 'socket.io';
import app from '../../../../backend/src/app';
import { config } from '../../../../backend/src/config/env';
import {
  initializeSocketServer,
  whenSocketRedisReady,
} from '../../../../backend/src/realtime/socket.server';

export interface EphemeralServerHandle {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  port: number;
  baseUrl: string;
  connectSocket: (options?: {
    token?: string;
    deviceId?: string;
    correlationId?: string;
    extraHeaders?: Record<string, string>;
    query?: Record<string, string>;
  }) => Promise<ClientSocket>;
  trackSocket: (socket: ClientSocket) => ClientSocket;
  close: () => Promise<void>;
}

export function mintAccessToken(user: {
  id: string;
  role: string;
  tokenVersion?: number;
}): string {
  return jwt.sign(
    {
      userId: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 1,
    },
    config.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '15m',
    }
  );
}

export async function startEphemeralServer(): Promise<EphemeralServerHandle> {
  const httpServer = createServer(app);
  const io = await initializeSocketServer(httpServer);
  if (typeof whenSocketRedisReady === 'function') {
    await whenSocketRedisReady();
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const trackedSockets = new Set<ClientSocket>();

  const trackSocket = (socket: ClientSocket): ClientSocket => {
    trackedSockets.add(socket);
    return socket;
  };

  const connectSocket = async (
    options: {
      token?: string;
      deviceId?: string;
      correlationId?: string;
      extraHeaders?: Record<string, string>;
      query?: Record<string, string>;
    } = {}
  ): Promise<ClientSocket> => {
    const client = createSocketClient(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: {
        ...(options.token ? { token: `Bearer ${options.token}` } : {}),
        ...(options.deviceId ? { deviceId: options.deviceId } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      },
      query: options.query,
      extraHeaders: options.extraHeaders,
    });
    trackSocket(client);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Socket connection timeout on ${baseUrl}`));
      }, 5000);

      client.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    return client;
  };

  const close = async (): Promise<void> => {
    for (const s of trackedSockets) {
      try {
        s.removeAllListeners();
        s.disconnect();
      } catch {
        // Ignore teardown errors
      }
    }
    trackedSockets.clear();

    await new Promise<void>((resolve) => {
      io.close(() => {
        if (httpServer.listening) {
          httpServer.close(() => resolve());
        } else {
          resolve();
        }
      });
    });
  };

  return {
    app,
    httpServer,
    io: io as unknown as SocketIOServer,
    port,
    baseUrl,
    connectSocket,
    trackSocket,
    close,
  };
}
