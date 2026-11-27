import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger, serializeError } from '../lib/logger';
import { captureTelemetryException } from '../lib/telemetry';
import { getRequestId } from './requestId';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: any;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST', details: any = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void => {
  const timestamp = new Date().toISOString();
  const requestId = getRequestId(req);
  const requestIdField = requestId ? { requestId } : {};

  if ((err as any).type === 'entity.too.large' || (err as any).status === 413 || (err as any).statusCode === 413) {
    res.status(413).json({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'El cuerpo de la solicitud excede el límite permitido de 100kb',
        ...requestIdField,
        timestamp,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        ...requestIdField,
        timestamp,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Datos de entrada invalidos',
        details: err.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
        ...requestIdField,
        timestamp,
      },
    });
    return;
  }

  // Fallos de inicialización o conectividad física de base de datos (Supabase tenant pausado / red caída)
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err.name === 'PrismaClientInitializationError' ||
    (err instanceof Prisma.PrismaClientKnownRequestError &&
      ['P1000', 'P1001', 'P1002', 'P1003', 'P1017'].includes(err.code))
  ) {
    logger.error(
      {
        code: 'DATABASE_UNAVAILABLE',
        ...(requestId ? { requestId } : {}),
        err: serializeError(err),
      },
      'DATABASE_UNAVAILABLE: Fallo de conexión con PostgreSQL/Supabase'
    );

    res.status(503).json({
      success: false,
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message:
          'No fue posible conectar con el servidor de base de datos. Si el entorno utiliza Supabase, verifique que el proyecto se encuentre activo en https://supabase.com/dashboard.',
        details: process.env.NODE_ENV === 'development' ? err.message : null,
        ...requestIdField,
        timestamp,
      },
    });
    return;
  }

  // Violación de unicidad en base de datos (concurrencia / email ya existente)
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'El recurso ya existe o viola una restricción de unicidad',
        details: process.env.NODE_ENV === 'development' ? err.meta : null,
        ...requestIdField,
        timestamp,
      },
    });
    return;
  }

  logger.error(
    {
      code: 'INTERNAL_SERVER_ERROR',
      ...(requestId ? { requestId } : {}),
      err: serializeError(err),
    },
    'Unhandled Server Error'
  );
  void captureTelemetryException(err, {
    code: 'INTERNAL_SERVER_ERROR',
    path: req.originalUrl,
    method: req.method,
    requestId,
  });

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Ocurrio un error interno en el servidor',
      details: process.env.NODE_ENV === 'development' ? err.message : null,
      ...requestIdField,
      timestamp,
    },
  });
};
