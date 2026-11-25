import app from './app';
import { initializeSocketServer, whenSocketRedisReady } from './realtime/socket.server';
import { disconnectQueue } from './realtime/disconnectQueue';
import { closeAllRedisClients } from './lib/redis';
import prisma from './lib/prisma';
import { config } from './config/env';
import { notificationsScheduler } from './jobs/notifications.scheduler';
import { logger, serializeError } from './lib/logger';

const PORT = config.PORT || process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, `Huellicam Backend Server running on port ${PORT}`);
  if (process.env.NODE_ENV !== 'test') {
    notificationsScheduler.start();
  }
});

const io = initializeSocketServer(server);

const redisReadyPromise =
  typeof whenSocketRedisReady === 'function' ? whenSocketRedisReady() : Promise.resolve();

redisReadyPromise.catch((err) => {
  const isProduction = (process.env.NODE_ENV || config.NODE_ENV) === 'production';
  if (isProduction) {
    logger.fatal({ err: serializeError(err) }, 'Fallo inicializando Redis en producción. Apagando servidor');
    void gracefulShutdown('REDIS_CONNECTION_FAILED', 1);
  }
});

let isShuttingDown = false;

export const gracefulShutdown = async (signal: string, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, `Recibida señal ${signal}. Iniciando Graceful Shutdown`);

  // Force exit timeout after 10 seconds if connections don't drain
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown excedió tiempo límite (10s). Forzando salida.');
    process.exit(1);
  }, 10000);

  try {
    // 1. Flush pre-shutdown debounced disconnects BEFORE closing io / httpServer
    //    (httpServer.once('close') invokes disconnectQueue.clear(), which would wipe pending entries)
    await disconnectQueue.flushAll();

    // 2. Close Socket.io first so connected WebSockets don't block httpServer.close().
    //    currentIo.close() sets isClosing = true synchronously (suppressing teardown enqueues)
    //    and closes httpServer internally.
    if (io) {
      await new Promise<void>((resolve) => {
        try {
          Promise.resolve(
            io.close((err) => {
              if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
                logger.error({ err: serializeError(err) }, 'Error cerrando Socket.io / HTTP server');
              }
              resolve();
            })
          ).catch((err) => {
            logger.error({ err: serializeError(err) }, 'Error cerrando Socket.io');
            resolve();
          });
        } catch (err) {
          logger.error({ err: serializeError(err) }, 'Error cerrando Socket.io');
          resolve();
        }
      });
      logger.info('Socket.io gateway desconectado.');
    }

    // 3. Stop accepting new HTTP connections if server is still listening (e.g. io absent)
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) logger.error({ err: serializeError(err) }, 'Error cerrando HTTP server');
          else logger.info('Servidor HTTP cerrado.');
          resolve();
        });
      });
    } else {
      logger.info('Servidor HTTP cerrado.');
    }

    // 4. Discard any teardown-induced disconnect timers from io.close()
    disconnectQueue.clear();

    // 5. Close all Redis clients cleanly after io.close() / adapter.close()
    await closeAllRedisClients();
    logger.info('Conexiones Redis cerradas.');

    // 6. Disconnect Prisma ORM
    await prisma.$disconnect();
    logger.info('Conexión con PostgreSQL / Prisma cerrada.');

    clearTimeout(forceExitTimeout);
    logger.info('Graceful Shutdown completado con éxito.');
    if (process.env.NODE_ENV !== 'test') {
      process.exit(exitCode);
    }
  } catch (error) {
    logger.error({ err: serializeError(error) }, 'Error durante Graceful Shutdown');
    clearTimeout(forceExitTimeout);
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default server;
