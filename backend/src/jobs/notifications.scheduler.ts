import { config } from '../config/env';
import prisma from '../lib/prisma';
import { emailService } from '../services/email.service';
import { notificationsService } from '../modules/notifications/notifications.service';
import { logger, serializeError } from '../lib/logger';

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
      logger.info('[Scheduler] Email notifications scheduler disabled in this environment (set ENABLE_EMAIL_SCHEDULER=true to enable).');
      return;
    }

    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      this.runChecks().catch((err) => logger.warn({ err: serializeError(err) }, '[Scheduler] Initial run failed'));
    }, 5000);

    this.timer = setInterval(() => {
      this.runChecks().catch((err) => logger.warn({ err: serializeError(err) }, '[Scheduler] Periodic run failed'));
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
    await this.checkScheduledAppointments(now);
    await this.checkDueVaccines(now);
    await this.checkDueFollowUps(now);
    await this.checkPreventiveCheckups(now);
    await this.checkPetBirthdays(now);
  }

  private async getUserEmailPrefs(userId?: string | null) {
    if (!userId || !prisma.notificationPreference?.findUnique) {
      return { emailRemindersEnabled: true, vaccineReminders: true, appointmentReminders: true };
    }
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId } }).catch(() => null);
    return {
      emailRemindersEnabled: prefs ? prefs.emailRemindersEnabled : true,
      vaccineReminders: prefs ? prefs.vaccineReminders : true,
      appointmentReminders: prefs ? prefs.appointmentReminders : true,
    };
  }

  private async dispatchReminderOnce(params: {
    dedupeKey: string;
    entityId: string;
    to: string;
    clientName: string;
    type: 'APPOINTMENT' | 'CHECKUP' | 'BIRTHDAY' | 'VACCINE' | 'FOLLOW_UP';
    title: string;
    message: string;
    actionUrl?: string;
  }): Promise<boolean> {
    const { dedupeKey, entityId, to, clientName, type, title, message, actionUrl } = params;

    if (prisma.emailDispatchLog?.findUnique) {
      const existing = await prisma.emailDispatchLog.findUnique({
        where: { dedupeKey },
      });
      if (existing) return false;
    }

    try {
      await prisma.emailDispatchLog.create({
        data: {
          dedupeKey,
          type,
          entityId,
          recipientEmail: to,
        },
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2002') {
        return false;
      }
      logger.warn({ dedupeKey, err: serializeError(err) }, '[Scheduler] Dedupe lock insert failed');
      return false;
    }

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

    if (!sent) {
      await prisma.emailDispatchLog.delete({ where: { dedupeKey } }).catch(() => {});
      return false;
    }

    return true;
  }

  public async checkScheduledAppointments(now: Date = new Date()): Promise<void> {
    if (!prisma.consultationMetadata?.findMany) return;
    const in24h = new Date(now.getTime() + DAY_MS);
    const dayIso = now.toISOString().slice(0, 10);

    const upcoming = await prisma.consultationMetadata.findMany({
      where: {
        scheduledAt: { gte: now, lte: in24h },
        consultation: {
          status: 'WAITING',
          deletedAt: null,
        },
      },
      include: {
        consultation: {
          include: {
            client: { select: { id: true, email: true, firstName: true } },
            pet: { select: { name: true } },
          },
        },
      },
      take: 30,
    });

    for (const row of upcoming) {
      const c = row.consultation;
      if (!c?.client?.id) continue;
      const prefs = await this.getUserEmailPrefs(c.client.id);
      if (!prefs.appointmentReminders) continue;

      const scheduledLabel = row.scheduledAt
        ? row.scheduledAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        : '';
      const title = `Turno próximo para ${c.pet?.name || 'tu mascota'}`;
      const message = `Recordatorio: tenés una teleconsulta programada hoy${scheduledLabel ? ` a las ${scheduledLabel}` : ''} para ${c.pet?.name || 'tu mascota'}.`;

      if (prefs.emailRemindersEnabled && c.client.email) {
        const dispatched = await this.dispatchReminderOnce({
          dedupeKey: `SCHEDULED_APPT:${c.id}:${dayIso}`,
          entityId: c.id,
          to: c.client.email,
          clientName: c.client.firstName || 'Tutor',
          type: 'APPOINTMENT',
          title,
          message,
          actionUrl: `${this.clientBaseUrl}/client/appointments`,
        });
        if (dispatched) {
          await notificationsService
            .createAndDispatch(c.client.id, title, message, 'APPOINTMENT_REMINDER', {
              consultationId: c.id,
            })
            .catch(() => {});
        }
      }
    }
  }

  public async checkDueVaccines(now: Date = new Date()): Promise<void> {
    if (!prisma.petVaccine?.findMany) return;
    const in7Days = new Date(now.getTime() + 7 * DAY_MS);

    const vaccines = await prisma.petVaccine.findMany({
      where: {
        deletedAt: null,
        nextDueAt: { gte: now, lte: in7Days },
      },
      include: {
        pet: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            owner: { select: { id: true, email: true, firstName: true } },
          },
        },
      },
      take: 50,
    });

    for (const v of vaccines) {
      const owner = v.pet?.owner;
      if (!owner?.id || !v.nextDueAt) continue;
      const prefs = await this.getUserEmailPrefs(owner.id);
      if (!prefs.vaccineReminders) continue;

      const dueDay = v.nextDueAt.toISOString().slice(0, 10);
      const title = `Vacuna próxima: ${v.name} (${v.pet.name})`;
      const message = `La vacuna ${v.name} de ${v.pet.name} vence el ${v.nextDueAt.toLocaleDateString('es-AR')}. Coordiná su aplicación para mantener su libreta al día.`;

      let shouldNotifyInApp = true;
      if (prefs.emailRemindersEnabled && owner.email) {
        shouldNotifyInApp = await this.dispatchReminderOnce({
          dedupeKey: `VACCINE_DUE:${v.id}:${dueDay}`,
          entityId: v.id,
          to: owner.email,
          clientName: owner.firstName || 'Tutor',
          type: 'VACCINE',
          title,
          message,
          actionUrl: `${this.clientBaseUrl}/client/pets/${v.pet.id}`,
        });
      }

      if (shouldNotifyInApp) {
        await notificationsService
          .createAndDispatch(owner.id, title, message, 'VACCINE_REMINDER', {
            petId: v.pet.id,
            vaccineId: v.id,
          })
          .catch(() => {});
      }
    }
  }

  public async checkDueFollowUps(now: Date = new Date()): Promise<void> {
    if (!prisma.followUp?.findMany) return;
    const in24h = new Date(now.getTime() + DAY_MS);

    const followUps = await prisma.followUp.findMany({
      where: {
        status: 'PENDING',
        reminderSentAt: null,
        dueAt: { gte: now, lte: in24h },
      },
      include: {
        client: { select: { id: true, email: true, firstName: true } },
        pet: { select: { id: true, name: true } },
      },
      take: 50,
    });

    for (const fu of followUps) {
      if (!fu.client?.id) continue;
      const prefs = await this.getUserEmailPrefs(fu.client.id);
      if (!prefs.appointmentReminders) continue;

      const title = `Seguimiento clínico: ${fu.title}`;
      const message = `Tenés un seguimiento programado para ${fu.pet?.name || 'tu mascota'} el ${fu.dueAt.toLocaleDateString('es-AR')}.`;

      if (prefs.emailRemindersEnabled && fu.client.email) {
        await this.dispatchReminderOnce({
          dedupeKey: `FOLLOW_UP_DUE:${fu.id}`,
          entityId: fu.id,
          to: fu.client.email,
          clientName: fu.client.firstName || 'Tutor',
          type: 'FOLLOW_UP',
          title,
          message,
          actionUrl: `${this.clientBaseUrl}/client/appointments`,
        });
      }

      await notificationsService
        .createAndDispatch(fu.client.id, title, message, 'FOLLOW_UP_REMINDER', {
          followUpId: fu.id,
          petId: fu.petId,
        })
        .catch(() => {});

      await prisma.followUp
        .update({
          where: { id: fu.id },
          data: { reminderSentAt: now },
        })
        .catch(() => {});
    }
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

export function stopNotificationsScheduler(): void {
  notificationsScheduler.stop();
}
