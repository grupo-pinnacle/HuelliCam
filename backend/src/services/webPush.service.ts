import crypto from 'crypto';
import prisma from '../lib/prisma';
import { config } from '../config/env';
import { logger, serializeError } from '../lib/logger';

function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildVapidJwt(audience: string, subject: string, publicKeyB64Url: string, privateKeyB64Url: string): string {
  const pubRaw = Buffer.from(publicKeyB64Url, 'base64url');
  if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) {
    throw new Error('Invalid VAPID_PUBLIC_KEY format');
  }
  const x = toBase64Url(pubRaw.subarray(1, 33));
  const y = toBase64Url(pubRaw.subarray(33, 65));

  const keyObj = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x,
      y,
      d: privateKeyB64Url,
    },
    format: 'jwk',
  });

  const header = toBase64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = toBase64Url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject,
    })
  );
  const unsigned = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), {
    key: keyObj,
    dsaEncoding: 'ieee-p1363',
  });
  return `${unsigned}.${toBase64Url(sig)}`;
}

export class WebPushService {
  public getPublicKey(): string | null {
    const key = config.VAPID_PUBLIC_KEY?.trim();
    return key || null;
  }

  public isConfigured(): boolean {
    return Boolean(config.VAPID_PUBLIC_KEY?.trim() && config.VAPID_PRIVATE_KEY?.trim());
  }

  public async sendToUser(userId: string): Promise<{ sent: number; skipped?: boolean }> {
    const publicKey = config.VAPID_PUBLIC_KEY?.trim();
    const privateKey = config.VAPID_PRIVATE_KEY?.trim();
    if (!publicKey || !privateKey) {
      return { sent: 0, skipped: true };
    }

    if (!prisma.webPushSubscription?.findMany) {
      return { sent: 0, skipped: true };
    }

    const subscriptions = await prisma.webPushSubscription.findMany({
      where: { userId },
    });

    if (subscriptions.length === 0) {
      return { sent: 0 };
    }

    let sent = 0;
    const subject = config.VAPID_SUBJECT || 'mailto:soporte@huellicam.com.ar';

    for (const sub of subscriptions) {
      try {
        const endpointUrl = new URL(sub.endpoint);
        const jwt = buildVapidJwt(endpointUrl.origin, subject, publicKey, privateKey);
        const response = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            TTL: '86400',
            Urgency: 'high',
            Authorization: `vapid t=${jwt}, k=${publicKey}`,
          },
        });

        if (response.status === 404 || response.status === 410) {
          await prisma.webPushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else if (response.ok) {
          sent += 1;
        }
      } catch (err) {
        logger.warn({ userId, err: serializeError(err) }, '[WebPush] Dispatch failed');
      }
    }

    return { sent };
  }
}

export const webPushService = new WebPushService();
