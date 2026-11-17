import { config } from '../config/env';
import prisma from '../lib/prisma';
import { emailService } from '../services/email.service';

const CHECKUP_INTERVAL_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function isBirthdayToday(birthDate: Date, today: Date): boolean {
  const bMonth = birthDate.getUTCMonth();
  const bDay = birthDate.getUTCDate();
  const tMonth = today.getUTCMonth();
  const tDay = today.getUTCDate();

  if (bMonth === tMonth && bDay === tDay) return true;

  const year = today.getUTCFullYear();
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return !isLeapYear && bMonth === 1 && bDay === 29 && tMonth === 1 && tDay === 28;
}

/**
 * Servicio autónomo de recordatorios preventivos y notificaciones por correo (Resend).
 * Ejecuta chequeos deduplicados en DB para:
 * 1. Consultas en espera recientes (máximo 1 aviso por consulta).
 * 2. Chequeo médico preventivo (máximo 1 aviso cada 180 días por mascota).
 * 3. Cumpleaños de la mascota (máximo 1 aviso anual si tiene fecha de nacimiento).
 */
export class NotificationsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private readonly intervalMs = 60 * 60 * 1000; // Tick cada 1 hora con deduplicación en DB

  private get clientBaseUrl(): string {
    return (config.CLIENT_URL || config.FRONTEND_URL || 'https://app.huellicam.com.ar').replace(/\/$/, '');
  }

  public isEnabled(): boolean {
    if (config.NODE_ENV === 'production') {
      return config.ENABLE_EMAIL_SCHEDULER !== 'false';
    }
    return config.ENABLE_EMAIL_SCHEDULER === 'true';
  }

  public start() {
    if (this.timer || this.bootTimer) return;
    if (!this.isEnabled()) {
      console.log('[Scheduler] Email notifications scheduler disabled in this environment (set ENABLE_EMAIL_SCHEDULER=true to enable).');
      return;
    }

    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      this.runChecks().catch((err) => console.warn('[Scheduler] Initial run failed:', err));
    }, 5000);

    this.timer = setInterval(() => {
      this.runChecks().catch((err) => console.warn('[Scheduler] Periodic run failed:', err));
    }, this.intervalMs);
  }

  public stop() {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runChecks(now: Date = new Date()): Promise<void> {
    await this.checkUpcomingConsultations(now);
    await this.checkPreventiveCheckups(now);
    await this.checkPetBirthdays(now);
  }

  private async dispatchReminderOnce(params: {
    dedupeKey: string;
    entityId: string;
    to: string;
    clientName: string;
    type: 'APPOINTMENT' | 'CHECKUP' | 'BIRTHDAY';
    title: string;
    message: string;
    actionUrl?: string;
  }): Promise<boolean> {
    const { dedupeKey, entityId, to, clientName, type, title, message, actionUrl } = params;

    const existing = await prisma.emailDispatchLog.findUnique({
      where: { dedupeKey },
    });
    if (existing) return false;

    const sent = await emailService
      .sendReminderEmail({
        to,
        clientName,
        type,
        title,
        message,
        actionUrl,
      })
      .catch(() => false);

    if (!sent) return false;

    try {
      await prisma.emailDispatchLog.create({
        data: {
          dedupeKey,
          type,
          entityId,
          recipientEmail: to,
        },
      });
    } catch {
      // Ignorar colisión concurrente sobre dedupeKey
    }

    return true;
  }

  /**
   * Envía como máximo 1 correo por consulta en espera creada en las últimas 24 horas.
   */
  public async checkUpcomingConsultations(now: Date = new Date()): Promise<void> {
    const last24h = new Date(now.getTime() - DAY_MS);

    const upcoming = await prisma.consultation.findMany({
      where: {
        status: 'WAITING',
        deletedAt: null,
        createdAt: { gte: last24h },
      },
      include: {
        client: { select: { email: true, firstName: true } },
        pet: { select: { name: true } },
      },
    });

    for (const c of upcoming) {
      if (!c.client?.email) continue;
      await this.dispatchReminderOnce({
        dedupeKey: `APPOINTMENT:${c.id}`,
        entityId: c.id,
        to: c.client.email,
        clientName: c.client.firstName || 'Tutor',
        type: 'APPOINTMENT',
        title: `Recordatorio de atención para ${c.pet?.name || 'tu mascota'}`,
        message: `Tenés una consulta activa en sala de espera de Huellicam para ${c.pet?.name || 'tu mascota'}. Verificá tu conexión a internet y tené lista la libreta sanitaria.`,
        actionUrl: `${this.clientBaseUrl}/client/dashboard`,
      });
    }
  }

  /**
   * Envía como máximo 1 recordatorio preventivo cada 180 días a mascotas con >= 6 meses de registro y sin consultas recientes.
   */
  public async checkPreventiveCheckups(now: Date = new Date()): Promise<void> {
    const sixMonthsAgo = new Date(now.getTime() - CHECKUP_INTERVAL_DAYS * DAY_MS);
    const todayIso = now.toISOString().slice(0, 10);

    const petsDue = await prisma.pet.findMany({
      where: {
        deletedAt: null,
        createdAt: { lte: sixMonthsAgo },
        consultations: {
          none: {
            deletedAt: null,
            createdAt: { gte: sixMonthsAgo },
          },
        },
      },
      include: {
        owner: { select: { email: true, firstName: true } },
      },
      take: 20,
    });

    if (petsDue.length === 0) return;

    const recentLogs = await prisma.emailDispatchLog.findMany({
      where: {
        type: 'CHECKUP',
        entityId: { in: petsDue.map((p) => p.id) },
        sentAt: { gte: sixMonthsAgo },
      },
      select: { entityId: true },
    });
    const recentlyNotifiedIds = new Set(recentLogs.map((l) => l.entityId).filter(Boolean));

    for (const pet of petsDue) {
      if (recentlyNotifiedIds.has(pet.id) || !pet.owner?.email) continue;

      await this.dispatchReminderOnce({
        dedupeKey: `CHECKUP:${pet.id}:${todayIso}`,
        entityId: pet.id,
        to: pet.owner.email,
        clientName: pet.owner.firstName || 'Tutor',
        type: 'CHECKUP',
        title: `Chequeo preventivo recomendado para ${pet.name}`,
        message: `Pasaron más de 6 meses desde el último control de ${pet.name}. Te recomendamos coordinar un chequeo general con un profesional matriculado para mantener sus vacunas y peso al día.`,
        actionUrl: `${this.clientBaseUrl}/client/triage`,
      });
    }
  }

  /**
   * Envía 1 saludo anual el día del cumpleaños de cada mascota con fecha de nacimiento registrada.
   */
  public async checkPetBirthdays(now: Date = new Date()): Promise<void> {
    const currentYear = now.getUTCFullYear();

    const petsWithBirthDate = await prisma.pet.findMany({
      where: {
        deletedAt: null,
        birthDate: { not: null },
      },
      include: {
        owner: { select: { email: true, firstName: true } },
      },
    });

    for (const pet of petsWithBirthDate) {
      if (!pet.birthDate || !pet.owner?.email) continue;
      if (!isBirthdayToday(pet.birthDate, now)) continue;

      const ageYears = currentYear - pet.birthDate.getUTCFullYear();
      if (ageYears < 1) continue;

      const ageLabel = ageYears === 1 ? '1 año' : `${ageYears} años`;
      await this.dispatchReminderOnce({
        dedupeKey: `BIRTHDAY:${pet.id}:${currentYear}`,
        entityId: pet.id,
        to: pet.owner.email,
        clientName: pet.owner.firstName || 'Tutor',
        type: 'BIRTHDAY',
        title: `¡Feliz cumpleaños para ${pet.name}!`,
        message: `Hoy ${pet.name} cumple ${ageLabel}. Todo el equipo de Huellicam les desea un gran día y te recuerda mantener su control anual y vacunas al día.`,
        actionUrl: `${this.clientBaseUrl}/client/dashboard`,
      });
    }
  }
}

export const notificationsScheduler = new NotificationsScheduler();
