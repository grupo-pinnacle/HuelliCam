import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { config } from '../config/env';
import {
  closeRedisClient,
  createRedisClient,
  initializeSharedRedisClient,
  normalizeRedisUrl,
  resetSharedRedisClient,
} from '../lib/redis';
import { presenceService } from './presence.service';
import { socketAuthMiddleware } from './socket.auth.middleware';
import { applySocketRateLimiting } from './socket.ratelimit.middleware';
import { registerChatGateway } from './gateways/chat.gateway';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from './socket.types';

import { isAllowedOrigin } from '../config/cors';
import {
  consultationConcurrencyService,
  PostCommitEvictionParams,
} from '../modules/consultations/consultationConcurrency.service';
import { disconnectQueue } from './disconnectQueue';
import { logger, runWithLogContext, serializeError } from '../lib/logger';

type AppSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type EventListenerFn = (...args: unknown[]) => void;

interface AttachedSocketState {
  io: AppSocketServer;
  markClosing: () => void;
  redisClients: Redis[];
  preRequestListeners: EventListenerFn[];
  addedUpgradeListeners: EventListenerFn[];
  addedCloseListeners: EventListenerFn[];
  addedListeningListeners: EventListenerFn[];
}

const closeListeners = new WeakMap<HttpServer, () => void>();
const attachedServers = new WeakMap<HttpServer, AttachedSocketState>();

export let io: AppSocketServer;

let socketRedisReadyPromise: Promise<void> = Promise.resolve();
let socketInitGeneration = 0;

const guardUnawaitedRedisMethod = <T extends object, K extends keyof T>(
  target: T,
  method: K
): void => {
  const fn = target[method];
  if (typeof fn === 'function') {
    (target as Record<K, unknown>)[method] = ((...args: unknown[]) => {
      const result = (fn as (...a: unknown[]) => unknown).apply(target, args);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(() => {});
      }
      return result;
    }) as T[K];
  }
};

export const whenSocketRedisReady = (): Promise<void> => socketRedisReadyPromise;

export const evictRevokedSessionAndResume = async (
  params: PostCommitEvictionParams
): Promise<void> => {
  await consultationConcurrencyService.handlePostCommitEvictionAndResume(params);
};

export const initializeSocketServer = (httpServer: HttpServer) => {
  const nodeEnv = process.env.NODE_ENV || config.NODE_ENV;
  const isProduction = nodeEnv === 'production';
  const rawRedisUrl =
    process.env.REDIS_URL !== undefined ? process.env.REDIS_URL : config.REDIS_URL;
  const redisUrl = normalizeRedisUrl(rawRedisUrl);

  if (isProduction && !redisUrl) {
    const err = new Error(
      'REDIS_URL is required in production; InMemoryAdapter fallback is disabled'
    );
    socketRedisReadyPromise = Promise.reject(err);
    socketRedisReadyPromise.catch(() => {});
    throw err;
  }

  const mySocketGen = ++socketInitGeneration;

  const priorState = attachedServers.get(httpServer);
  if (priorState) {
    priorState.markClosing();
    try {
      priorState.io.disconnectSockets(true);
    } catch {
      // Ignore socket disconnect errors during re-initialization
    }
    try {
      void Promise.resolve(priorState.io.of('/').adapter.close()).catch(() => {});
    } catch {
      // Ignore adapter close errors during re-initialization
    }
    try {
      priorState.io.engine?.close();
    } catch {
      // Ignore engine close errors during re-initialization
    }
    for (const client of priorState.redisClients) {
      void closeRedisClient(client).catch(() => {});
    }

    for (const fn of priorState.addedUpgradeListeners) {
      httpServer.off('upgrade', fn);
    }
    for (const fn of priorState.addedCloseListeners) {
      httpServer.off('close', fn);
    }
    for (const fn of priorState.addedListeningListeners) {
      httpServer.off('listening', fn);
    }
    httpServer.removeAllListeners('request');
    for (const fn of priorState.preRequestListeners) {
      httpServer.on('request', fn);
    }
    attachedServers.delete(httpServer);
  }

  let isClosing = false;
  let redisAdapterReady = !isProduction || !redisUrl;
  const trackedRedisClients: Redis[] = [];
  let nextConnectionEpoch = 0;
  const deviceConnectionEpoch = new Map<string, number>();
  const activeLocalDeviceSockets = new Map<string, Set<string>>();
  const previousCloseListener = closeListeners.get(httpServer);
  if (previousCloseListener) {
    httpServer.off('close', previousCloseListener);
  }
  const onHttpServerClose = () => {
    isClosing = true;
    disconnectQueue.clear();
  };
  closeListeners.set(httpServer, onHttpServerClose);
  httpServer.once('close', onHttpServerClose);

  const preRequestListeners = httpServer.listeners('request').slice() as EventListenerFn[];
  const preUpgradeListeners = new Set(httpServer.listeners('upgrade') as EventListenerFn[]);
  const preCloseListeners = new Set(httpServer.listeners('close') as EventListenerFn[]);
  const preListeningListeners = new Set(httpServer.listeners('listening') as EventListenerFn[]);

  const currentIo = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS policy violation'));
        }
      },
      credentials: true,
    },
  });

  const originalIoClose = currentIo.close.bind(currentIo);
  currentIo.close = ((cb?: (err?: Error) => void) => {
    isClosing = true;
    return originalIoClose(cb);
  }) as typeof currentIo.close;

  attachedServers.set(httpServer, {
    io: currentIo,
    markClosing: () => {
      isClosing = true;
    },
    redisClients: trackedRedisClients,
    preRequestListeners,
    addedUpgradeListeners: (httpServer.listeners('upgrade') as EventListenerFn[]).filter(
      (fn) => !preUpgradeListeners.has(fn)
    ),
    addedCloseListeners: (httpServer.listeners('close') as EventListenerFn[]).filter(
      (fn) => !preCloseListeners.has(fn)
    ),
    addedListeningListeners: (httpServer.listeners('listening') as EventListenerFn[]).filter(
      (fn) => !preListeningListeners.has(fn)
    ),
  });

  io = currentIo;

  // Redis Adapter & Distributed Presence setup (ADR-009)
  if (redisUrl) {
    const pubClient = createRedisClient(redisUrl);
    const subClient = createRedisClient(redisUrl, { maxRetriesPerRequest: null });
    guardUnawaitedRedisMethod(pubClient, 'publish');
    guardUnawaitedRedisMethod(pubClient, 'pubsub');
    guardUnawaitedRedisMethod(subClient, 'psubscribe');
    guardUnawaitedRedisMethod(subClient, 'subscribe');
    guardUnawaitedRedisMethod(subClient, 'punsubscribe');
    guardUnawaitedRedisMethod(subClient, 'unsubscribe');
    trackedRedisClients.push(pubClient, subClient);

    // Suppress console spam while probing the initial connection
    const handleProbeError = () => {};
    pubClient.on('error', handleProbeError);
    subClient.on('error', handleProbeError);

    socketRedisReadyPromise = Promise.all([
      pubClient.connect(),
      subClient.connect(),
      initializeSharedRedisClient(redisUrl),
    ])
      .then(([, , sharedClient]) => {
        pubClient.off('error', handleProbeError);
        subClient.off('error', handleProbeError);

        if (sharedClient) {
          trackedRedisClients.push(sharedClient);
        }

        if (isClosing || mySocketGen !== socketInitGeneration) {
          return Promise.all([
            closeRedisClient(pubClient),
            closeRedisClient(subClient),
            sharedClient ? closeRedisClient(sharedClient) : Promise.resolve(),
            mySocketGen === socketInitGeneration ? resetSharedRedisClient() : Promise.resolve(),
          ]).then(() => undefined);
        }

        pubClient.on('error', (err) => logger.warn({ err: serializeError(err) }, 'Redis Pub Client Error'));
        subClient.on('error', (err) => logger.warn({ err: serializeError(err) }, 'Redis Sub Client Error'));

        currentIo.adapter(createAdapter(pubClient, subClient));
        redisAdapterReady = true;
        logger.info('Socket.io Redis Adapter connected successfully');
      })
      .catch(async (err: Error) => {
        pubClient.off('error', handleProbeError);
        subClient.off('error', handleProbeError);

        await Promise.all([
          closeRedisClient(pubClient),
          closeRedisClient(subClient),
          mySocketGen === socketInitGeneration ? resetSharedRedisClient() : Promise.resolve(),
        ]);

        if (isClosing || mySocketGen !== socketInitGeneration) {
          return;
        }

        if (isProduction) {
          logger.error({ err: serializeError(err) }, 'Could not connect to Redis Adapter in production');
          isClosing = true;
          try {
            currentIo.close();
          } catch {
            // Ignore close errors during production startup failure
          }
          throw err;
        }

        redisAdapterReady = true;
        logger.info(
          { redisUrl },
          'Redis no disponible (modo local). Operando con Socket.io InMemoryAdapter por defecto.'
        );
      });
    socketRedisReadyPromise.catch(() => {});
  } else {
    socketRedisReadyPromise = resetSharedRedisClient();
  }

  // Gate production connections so InMemoryAdapter can never serve traffic in production
  currentIo.use((_socket, next) => {
    if (isProduction && !redisAdapterReady) {
      return next(new Error('Realtime service unavailable: Redis adapter not ready'));
    }
    next();
  });

  // Middleware
  currentIo.use(socketAuthMiddleware);

  // Connection Handler
  currentIo.on('connection', (socket) => {
    applySocketRateLimiting(socket);
    const user = socket.data.user;
    const deviceId = socket.data.deviceId;
    const correlationId = socket.data.correlationId;

    logger.info(
      {
        correlationId,
        requestId: correlationId,
        socketId: socket.id,
        userId: user?.id,
        role: user?.role,
      },
      'Socket connected'
    );

    socket.use((_packet, next) => {
      runWithLogContext(
        {
          correlationId,
          requestId: correlationId,
          socketId: socket.id,
          userId: user?.id,
        },
        () => next()
      );
    });
    const isCurrentlyApprovedVet = () =>
      Boolean(user && user.role === 'VET' && user.vetStatus === 'APPROVED');
    const EXPLICIT_HEARTBEAT_COOLDOWN_MS = 2_000;
    let lastPresenceRefreshAt = 0;
    let lastExplicitHeartbeatAt = 0;
    let lastExplicitHeartbeatExpiresAt: number | undefined;
    let isSocketDisconnected = false;
    let connectPresencePromise: Promise<unknown> = Promise.resolve();

    const refreshPresence = async (force: boolean) => {
      if (!user || isSocketDisconnected || isClosing) {
        return null;
      }
      const now = Date.now();
      if (!force && now - lastPresenceRefreshAt < 10_000) {
        return null;
      }
      lastPresenceRefreshAt = now;
      return presenceService.refreshSocketPresence({
        userId: user.id,
        socketId: socket.id,
        role: user.role,
        vetStatus: user.vetStatus,
        now,
      });
    };

    const onConnHeartbeat = () => {
      void refreshPresence(false).catch(() => {});
    };

    const onAnySocketEvent = (eventName: string) => {
      if (eventName === 'presence:heartbeat') {
        return;
      }
      void refreshPresence(false).catch(() => {});
    };

    if (user) {
      // Join personal user room for direct signaling (e.g. call:incoming)
      socket.join(`user:${user.id}`);

      // Join device room for device-targeted handoff signaling
      if (deviceId) {
        socket.join(`device:${deviceId}`);
        if (user.role === 'CLIENT') {
          const deviceKey = `${user.id}:${deviceId}`;
          const epoch = ++nextConnectionEpoch;
          deviceConnectionEpoch.set(deviceKey, epoch);

          let activeSockets = activeLocalDeviceSockets.get(deviceKey);
          if (!activeSockets) {
            activeSockets = new Set<string>();
            activeLocalDeviceSockets.set(deviceKey, activeSockets);
          }
          activeSockets.add(socket.id);

          disconnectQueue.cancel(user.id, deviceId);
        }
      }

      const isAdmin = user.role === 'ADMIN';

      // Join role room for approved vets and admins to receive sanitized triage alerts
      if (isCurrentlyApprovedVet() || isAdmin) {
        socket.join('role:vets');
      }

      registerChatGateway(currentIo, socket);

      connectPresencePromise = presenceService
        .registerSocketConnect({
          userId: user.id,
          socketId: socket.id,
          role: user.role,
          vetStatus: user.vetStatus,
        })
        .then((res) => {
          if (
            isCurrentlyApprovedVet() &&
            res.transitionedOnline &&
            !isSocketDisconnected &&
            !isClosing
          ) {
            currentIo.to('role:vets').emit('vet:presence', {
              vetId: user.id,
              isOnline: true,
              lastSeen: res.lastSeen,
            });
          }
          return res;
        })
        .catch(() => null);

      socket.conn?.on?.('heartbeat', onConnHeartbeat);
      socket.onAny(onAnySocketEvent);
      socket.on('presence:heartbeat', async (callback) => {
        if (isSocketDisconnected || isClosing) {
          callback?.({ ok: false });
          return;
        }
        const now = Date.now();
        if (
          lastExplicitHeartbeatAt > 0 &&
          now - lastExplicitHeartbeatAt < EXPLICIT_HEARTBEAT_COOLDOWN_MS
        ) {
          callback?.({ ok: true, expiresAt: lastExplicitHeartbeatExpiresAt });
          return;
        }
        lastExplicitHeartbeatAt = now;
        try {
          const result = await refreshPresence(true);
          if (!result) {
            callback?.({ ok: false });
            return;
          }
          lastExplicitHeartbeatExpiresAt = result.expiresAt;
          callback?.({ ok: true, expiresAt: result.expiresAt });
        } catch {
          callback?.({ ok: false });
        }
      });
    }

    socket.on('disconnect', async (reason) => {
      isSocketDisconnected = true;
      if (user) {
        socket.conn?.off?.('heartbeat', onConnHeartbeat);
        socket.offAny?.(onAnySocketEvent);

        // Debounced guard on socket disconnect:
        // Coalesces transient drops and cancels if tutor reconnects within DISCONNECT_DEBOUNCE_MS.
        // Only enqueue if no other active socket for (user.id, deviceId) remains connected
        // and no newer connection for (user.id, deviceId) occurred while fetchSockets() was in flight.
        if (deviceId && user.role === 'CLIENT') {
          const deviceKey = `${user.id}:${deviceId}`;
          const epochBefore = deviceConnectionEpoch.get(deviceKey);

          let hasOtherLocalSocket = false;
          const activeSockets = activeLocalDeviceSockets.get(deviceKey);
          if (activeSockets) {
            activeSockets.delete(socket.id);
            if (activeSockets.size === 0) {
              activeLocalDeviceSockets.delete(deviceKey);
            } else {
              hasOtherLocalSocket = true;
            }
          }

          if (!isClosing && reason !== 'server shutting down' && !hasOtherLocalSocket) {
            let hasOtherActiveSocketOnDevice = false;
            try {
              const deviceSockets = await currentIo.in(`device:${deviceId}`).fetchSockets();
              hasOtherActiveSocketOnDevice = deviceSockets.some(
                (s) => s.id !== socket.id && s.data?.user?.id === user.id
              );
            } catch {
              hasOtherActiveSocketOnDevice = false;
            }

            const currentEpoch = deviceConnectionEpoch.get(deviceKey);
            const hasActiveLocalAfter = (activeLocalDeviceSockets.get(deviceKey)?.size ?? 0) > 0;

            if (
              !hasOtherActiveSocketOnDevice &&
              !hasActiveLocalAfter &&
              !isClosing &&
              currentEpoch !== undefined &&
              currentEpoch === epochBefore
            ) {
              disconnectQueue.enqueue(user.id, deviceId);
            }

            if (currentEpoch === epochBefore && !hasActiveLocalAfter) {
              deviceConnectionEpoch.delete(deviceKey);
            }
          } else if (!hasOtherLocalSocket && deviceConnectionEpoch.get(deviceKey) === epochBefore) {
            deviceConnectionEpoch.delete(deviceKey);
          }
        }

        try {
          await connectPresencePromise;
        } catch {
          // Ensure registerSocketConnect settles before unregisterSocketDisconnect runs
        }

        try {
          const presenceResult = await presenceService.unregisterSocketDisconnect({
            userId: user.id,
            socketId: socket.id,
            role: user.role,
            vetStatus: user.vetStatus,
          });
          if (isCurrentlyApprovedVet() && presenceResult.wentOffline && presenceResult.wasOnlineVet) {
            currentIo.to('role:vets').emit('vet:presence', {
              vetId: user.id,
              isOnline: false,
              lastSeen: presenceResult.lastSeen,
            });
          }
        } catch {
          // Gracefully ignore error during server teardown
        }
      }
    });
  });

  return currentIo;
};
