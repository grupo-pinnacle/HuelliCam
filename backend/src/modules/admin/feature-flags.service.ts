import { AppError } from '../../middlewares/errorHandler';
import prisma from '../../lib/prisma';
import { getRedisClient } from '../../lib/redis';
import { FeatureFlagKey, UpdateFeatureFlagDTO, FEATURE_FLAG_KEYS } from './admin.schemas';

export const REDIS_FEATURE_FLAGS_KEY = 'huellicam:feature_flags';
const FEATURE_FLAGS_SYNC_TTL_MS = 2_000;

export interface FeatureFlagItem {
  key: FeatureFlagKey;
  enabled: boolean;
  description: string;
  updatedAt: string;
  updatedBy?: string | null;
}

const DEFAULT_FLAG_DESCRIPTIONS: Record<FeatureFlagKey, string> = {
  PAYMENTS_ENABLED: 'Pasarela de pagos y cobro de consultas',
  TRIAGE_ACTIVE: 'Flujo de triage y pre-diagnóstico clínico asistido',
  VIDEOCALLS_ENABLED: 'Salas de videollamadas y telemedicina en vivo',
  NEW_REGISTRATIONS_ENABLED: 'Registro de nuevos usuarios y profesionales veterinarios',
};

export class FeatureFlagsService {
  private flags = new Map<FeatureFlagKey, FeatureFlagItem>();
  private lastSyncedAt = 0;

  constructor() {
    this.resetForTests();
  }

  public resetForTests(): void {
    this.flags.clear();
    this.lastSyncedAt = 0;
    const now = new Date().toISOString();
    for (const key of FEATURE_FLAG_KEYS) {
      this.flags.set(key, {
        key,
        enabled: true,
        description: DEFAULT_FLAG_DESCRIPTIONS[key],
        updatedAt: now,
        updatedBy: null,
      });
    }
  }

  public async syncFromRedis(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastSyncedAt < FEATURE_FLAGS_SYNC_TTL_MS) {
      return;
    }

    const client = getRedisClient();
    if (!client || client.status !== 'ready') {
      return;
    }

    try {
      const raw = await client.get(REDIS_FEATURE_FLAGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<FeatureFlagKey, FeatureFlagItem>>;
        for (const key of FEATURE_FLAG_KEYS) {
          const item = parsed[key];
          if (item && typeof item.enabled === 'boolean') {
            this.flags.set(key, {
              key,
              enabled: item.enabled,
              description: item.description || DEFAULT_FLAG_DESCRIPTIONS[key],
              updatedAt: item.updatedAt || new Date().toISOString(),
              updatedBy: item.updatedBy ?? null,
            });
          }
        }
      }
      this.lastSyncedAt = now;
    } catch {
      // Fallback safely to local flag cache when Redis read/parse fails
    }
  }

  private async persistToRedis(): Promise<void> {
    const client = getRedisClient();
    if (!client || client.status !== 'ready') {
      return;
    }

    try {
      const payload: Partial<Record<FeatureFlagKey, FeatureFlagItem>> = {};
      for (const [key, item] of this.flags.entries()) {
        payload[key] = item;
      }
      await client.set(REDIS_FEATURE_FLAGS_KEY, JSON.stringify(payload));
      this.lastSyncedAt = Date.now();
    } catch {
      // Non-blocking Redis write-through
    }
  }

  public getAllFlags(): FeatureFlagItem[] {
    return Array.from(this.flags.values());
  }

  public isEnabled(key: FeatureFlagKey): boolean {
    const flag = this.flags.get(key);
    return flag ? flag.enabled : true;
  }

  public assertEnabled(key: FeatureFlagKey): void {
    if (!this.isEnabled(key)) {
      throw new AppError(
        `Operación rechazada temporalmente: el módulo ${key} se encuentra deshabilitado por mantenimiento operativo.`,
        503,
        'SERVICE_UNAVAILABLE'
      );
    }
  }

  public async toggleFlag(adminId: string, dto: UpdateFeatureFlagDTO): Promise<FeatureFlagItem> {
    const existing = this.flags.get(dto.key);
    const updated: FeatureFlagItem = {
      key: dto.key,
      enabled: dto.enabled,
      description: existing?.description || DEFAULT_FLAG_DESCRIPTIONS[dto.key],
      updatedAt: new Date().toISOString(),
      updatedBy: adminId,
    };

    this.flags.set(dto.key, updated);
    await this.persistToRedis();

    if (prisma.platformFeatureFlag?.upsert) {
      await prisma.platformFeatureFlag
        .upsert({
          where: { key: dto.key },
          create: {
            key: dto.key,
            enabled: dto.enabled,
            description: updated.description,
            updatedBy: adminId,
          },
          update: {
            enabled: dto.enabled,
            description: updated.description,
            updatedBy: adminId,
          },
        })
        .catch(() => {});
    }

    try {
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'FEATURE_FLAG_TOGGLED',
          targetId: dto.key,
          details: {
            key: dto.key,
            enabled: dto.enabled,
            reason: dto.reason || null,
          },
        },
      });
    } catch {
      // Non-blocking persistence for test / environment resilience
    }

    return updated;
  }
}

export const featureFlagsService = new FeatureFlagsService();
