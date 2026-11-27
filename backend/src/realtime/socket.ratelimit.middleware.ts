import { Socket } from 'socket.io';
import { getRedisClient } from '../lib/redis';

interface RateBucket {
  count: number;
  resetAt: number;
}

const socketBuckets = new Map<string, RateBucket>();
const ipBuckets = new Map<string, RateBucket>();

const SENSITIVE_SIGNALING_EVENTS = new Set([
  'call:answered',
  'call:rejected',
  'call:ended',
  'join:consultation',
  'message:send',
]);

const WINDOW_MS = 10_000; // 10 seconds window
const MAX_PER_SOCKET = 20; // max 20 signaling events per 10s per socket
const MAX_PER_IP = 60; // max 60 signaling events per 10s per IP

// Periodic cleanup of stale IP rate buckets without blocking test/process exit
const pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of ipBuckets.entries()) {
    if (now > bucket.resetAt) {
      ipBuckets.delete(ip);
    }
  }
}, 60_000);
pruneInterval.unref();

export const applySocketRateLimiting = (socket: Socket): void => {
  const rawIp =
    socket.handshake.headers?.['x-forwarded-for'] ||
    socket.handshake.address ||
    'unknown';
  const ip = Array.isArray(rawIp) ? rawIp[0] : String(rawIp).split(',')[0].trim();

  socket.use(([event, ...args], next) => {
    if (!SENSITIVE_SIGNALING_EVENTS.has(event)) {
      return next();
    }

    const now = Date.now();

    // Check socket bucket
    let sBucket = socketBuckets.get(socket.id);
    if (!sBucket || now > sBucket.resetAt) {
      sBucket = { count: 1, resetAt: now + WINDOW_MS };
      socketBuckets.set(socket.id, sBucket);
    } else {
      sBucket.count++;
      if (sBucket.count > MAX_PER_SOCKET) {
        const lastArg = args[args.length - 1];
        if (typeof lastArg === 'function') {
          lastArg({
            success: false,
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Límite de eventos de señalización excedido por socket',
            },
          });
        }
        return next(new Error('RATE_LIMIT_EXCEEDED: Socket signaling rate limit exceeded'));
      }
    }

    // Check IP bucket (Redis-backed when ready, local map fallback)
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      const redisKey = `huellicam:srl:ip:${ip}`;
      void (async () => {
        try {
          const count = await client.incr(redisKey);
          const pttl = count === 1 ? -1 : await client.pttl(redisKey);
          if (pttl < 0) {
            await client.pexpire(redisKey, WINDOW_MS);
          }
          if (count > MAX_PER_IP) {
            const lastArg = args[args.length - 1];
            if (typeof lastArg === 'function') {
              lastArg({
                success: false,
                error: {
                  code: 'RATE_LIMIT_EXCEEDED',
                  message: 'Límite de eventos de señalización excedido por IP',
                },
              });
            }
            return next(new Error('RATE_LIMIT_EXCEEDED: IP signaling rate limit exceeded'));
          }
          return next();
        } catch {
          // Fallback to local bucket on Redis error
          let ipBucket = ipBuckets.get(ip);
          if (!ipBucket || now > ipBucket.resetAt) {
            ipBucket = { count: 1, resetAt: now + WINDOW_MS };
            ipBuckets.set(ip, ipBucket);
          } else {
            ipBucket.count++;
            if (ipBucket.count > MAX_PER_IP) {
              const lastArg = args[args.length - 1];
              if (typeof lastArg === 'function') {
                lastArg({
                  success: false,
                  error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message: 'Límite de eventos de señalización excedido por IP',
                  },
                });
              }
              return next(new Error('RATE_LIMIT_EXCEEDED: IP signaling rate limit exceeded'));
            }
          }
          return next();
        }
      })();
      return;
    }

    let ipBucket = ipBuckets.get(ip);
    if (!ipBucket || now > ipBucket.resetAt) {
      ipBucket = { count: 1, resetAt: now + WINDOW_MS };
      ipBuckets.set(ip, ipBucket);
    } else {
      ipBucket.count++;
      if (ipBucket.count > MAX_PER_IP) {
        const lastArg = args[args.length - 1];
        if (typeof lastArg === 'function') {
          lastArg({
            success: false,
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Límite de eventos de señalización excedido por IP',
            },
          });
        }
        return next(new Error('RATE_LIMIT_EXCEEDED: IP signaling rate limit exceeded'));
      }
    }

    next();
  });

  socket.on('disconnect', () => {
    socketBuckets.delete(socket.id);
  });
};
