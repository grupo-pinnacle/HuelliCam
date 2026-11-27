import { z } from 'zod';

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const availabilitySlotInputSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(hhmmRegex, 'Formato de hora inválido (HH:mm)'),
    endTime: z.string().regex(hhmmRegex, 'Formato de hora inválido (HH:mm)'),
    slotDurationMin: z.number().int().min(15).max(120).optional().default(30),
    isActive: z.boolean().optional().default(true),
  })
  .refine((slot) => slot.startTime < slot.endTime, {
    message: 'La hora de inicio debe ser anterior a la hora de cierre',
  });

export const upsertAvailabilitySchema = z.object({
  slots: z.array(availabilitySlotInputSchema).max(28),
});

export const createAppointmentSchema = z.object({
  petId: z.string().min(1, 'El ID de la mascota es requerido'),
  vetId: z.string().min(1, 'El ID del veterinario es requerido'),
  scheduledAt: z.string().datetime({ message: 'scheduledAt debe ser una fecha ISO válida' }),
  notes: z.string().min(1, 'El motivo de la consulta es requerido').max(1000),
  symptoms: z.array(z.string()).optional(),
  duration: z
    .enum(['LESS_THAN_2_HOURS', 'HOURS_2_TO_12', 'DAYS_1_TO_2', 'MORE_THAN_2_DAYS'])
    .optional(),
});

export const createFollowUpSchema = z.object({
  petId: z.string().min(1, 'petId es requerido'),
  consultationId: z.string().min(1).optional().nullable(),
  title: z.string().min(1, 'El título del seguimiento es requerido').max(200),
  notes: z.string().max(1500).optional().nullable(),
  dueAt: z.string().datetime({ message: 'dueAt debe ser una fecha ISO válida' }),
});

export const updateFollowUpSchema = z.object({
  status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  dueAt: z.string().datetime().optional(),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(1500).optional().nullable(),
});

export type UpsertAvailabilityDTO = z.infer<typeof upsertAvailabilitySchema>;
export type CreateAppointmentDTO = z.infer<typeof createAppointmentSchema>;
export type CreateFollowUpDTO = z.infer<typeof createFollowUpSchema>;
export type UpdateFollowUpDTO = z.infer<typeof updateFollowUpSchema>;
