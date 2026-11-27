import crypto from 'crypto';
import { config } from '../config/env';
import { logger, serializeError } from './logger';

interface ParsedSentryDsn {
  endpoint: string;
  publicKey: string;
}

function parseSentryDsn(raw?: string): ParsedSentryDsn | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    const publicKey = parsed.username;
    const projectId = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    if (!publicKey || !projectId) return null;
    return {
      endpoint: `${parsed.protocol}//${parsed.host}/api/${projectId}/envelope/`,
      publicKey,
    };
  } catch {
    return null;
  }
}

export function isTelemetryConfigured(): boolean {
  return Boolean(parseSentryDsn(config.SENTRY_DSN));
}

export async function captureTelemetryException(
  err: unknown,
  context: Record<string, unknown> = {}
): Promise<void> {
  const serialized = serializeError(err);
  logger.error({ telemetry: true, ...context, err: serialized }, '[Telemetry] Captured exception');

  const dsn = parseSentryDsn(config.SENTRY_DSN);
  if (!dsn) return;

  try {
    const eventId = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const header = JSON.stringify({ event_id: eventId, sent_at: timestamp });
    const itemHeader = JSON.stringify({ type: 'event' });
    const eventPayload = JSON.stringify({
      event_id: eventId,
      timestamp,
      platform: 'node',
      environment: config.NODE_ENV,
      level: 'error',
      exception: {
        values: [
          {
            type: err instanceof Error ? err.name : 'Error',
            value: err instanceof Error ? err.message : String(err),
          },
        ],
      },
      extra: context,
    });

    const envelope = `${header}\n${itemHeader}\n${eventPayload}`;
    await fetch(dsn.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=huellicam/2.0`,
      },
      body: envelope,
    });
  } catch {
    // Never throw from telemetry reporting
  }
}
