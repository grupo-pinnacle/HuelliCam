import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export interface SignedWebhookPayload {
  rawBody: string;
  authHeader: string;
  sha256: string;
}

export function signLiveKitWebhook(
  payload: Record<string, unknown> | string,
  options: {
    apiKey?: string;
    apiSecret?: string;
    pretty?: boolean;
  } = {}
): SignedWebhookPayload {
  const apiKey = options.apiKey ?? process.env.LIVEKIT_API_KEY ?? 'devkey';
  const apiSecret = options.apiSecret ?? process.env.LIVEKIT_API_SECRET ?? 'secret';
  const pretty = options.pretty ?? true;

  const rawBody =
    typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, null, pretty ? 2 : 0);

  const sha256 = crypto
    .createHash('sha256')
    .update(rawBody, 'utf8')
    .digest('base64');

  const authHeader = jwt.sign(
    {
      iss: apiKey,
      sha256,
    },
    apiSecret,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
    }
  );

  return { rawBody, authHeader, sha256 };
}
