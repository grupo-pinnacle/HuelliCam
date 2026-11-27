import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import prisma from '../lib/prisma';
import { SocketData, SocketUser } from './socket.types';
import { config } from '../config/env';
import { resolveOrCreateCorrelationId } from '../lib/logger';
import { extractDeviceId } from '../contracts/consultation.contract';

const JWT_SECRET = config.JWT_SECRET;

interface TokenPayload {
  userId: string;
  role: any;
  tokenVersion: number;
}

export const socketAuthMiddleware = async (
  socket: Socket<any, any, any, SocketData>,
  next: (err?: Error) => void
): Promise<void> => {
  try {
    let token: string | undefined = socket.handshake.auth?.token;

    if (!token && socket.handshake.headers?.cookie) {
      const parsedCookies = cookie.parse(socket.handshake.headers.cookie);
      token = parsedCookies.accessToken;
    }

    if (token && token.startsWith('Bearer ')) {
      token = token.substring(7);
    }

    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
    } catch (err) {
      return next(new Error('Invalid or expired authentication token'));
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || user.deletedAt) {
      return next(new Error('User not found or inactive'));
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      return next(new Error('Session revoked. Please re-authenticate'));
    }

    // Attach user data to socket
    const socketUser: SocketUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tokenVersion: user.tokenVersion,
      vetStatus: user.vetStatus,
    };

    socket.data.user = socketUser;

    const rawDeviceId =
      socket.handshake.auth?.deviceId ??
      socket.handshake.query?.deviceId ??
      socket.handshake.headers?.['x-device-id'];
    const validDeviceId = extractDeviceId(rawDeviceId);
    if (validDeviceId) {
      socket.data.deviceId = validDeviceId;
    }

    const rawCorrelationId =
      socket.handshake.auth?.correlationId ??
      socket.handshake.headers?.['x-correlation-id'] ??
      socket.handshake.headers?.['x-request-id'];
    socket.data.correlationId = resolveOrCreateCorrelationId(rawCorrelationId);

    next();
  } catch (error) {
    next(new Error('Socket authentication failed'));
  }
};
