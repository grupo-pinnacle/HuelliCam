import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import {
  logger,
  resolveOrCreateCorrelationId,
  runWithLogContext,
  sanitizeCorrelationId,
} from '../lib/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
      requestId?: string;
      correlationId?: string;
      log?: Logger;
    }
  }
}

export function getRequestId(req?: Pick<Request, 'requestId' | 'id' | 'correlationId'>): string | undefined {
  if (!req) return undefined;
  return req.requestId ?? req.id ?? req.correlationId;
}

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const rawRequestId = sanitizeCorrelationId(req.headers['x-request-id']);
  const rawCorrelationId = sanitizeCorrelationId(req.headers['x-correlation-id']);

  const requestId = resolveOrCreateCorrelationId(rawRequestId ?? rawCorrelationId);
  const correlationId = rawCorrelationId ?? requestId;

  req.id = requestId;
  req.requestId = requestId;
  req.correlationId = correlationId;
  req.log = logger.child({ requestId, correlationId });

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const logPayload = {
      requestId,
      correlationId,
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
    };
    if (res.statusCode >= 500) {
      req.log?.error(logPayload, 'HTTP request failed');
    } else if (res.statusCode >= 400) {
      req.log?.warn(logPayload, 'HTTP request completed with client error');
    } else {
      req.log?.info(logPayload, 'HTTP request completed');
    }
  });

  runWithLogContext({ requestId, correlationId }, () => next());
};
