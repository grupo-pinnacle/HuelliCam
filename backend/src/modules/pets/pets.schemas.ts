import { z } from 'zod';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const birthDateSchema = z
  .preprocess((val) => {
    if (val === undefined) return undefined;
    if (val === null) return null;
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return null;
        if (DATE_ONLY_REGEX.test(trimmed)) {
          const parsed = new Date(`${trimmed}T12:00:00.000Z`);
          if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
            return new Date(NaN);
          }
          return parsed;
        }
        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? new Date(NaN) : parsed;
      }
    return val;
  }, z.date({ message: 'La fecha de nacimiento es inválida' }).nullable())
  .refine((date) => {
    if (!date) return true;
    const minDate = new Date('1900-01-01T00:00:00.000Z');
    const endOfToday = new Date();
    endOfToday.setUTCHours(23, 59, 59, 999);
    return date >= minDate && date <= endOfToday;
  }, 'La fecha de nacimiento debe estar entre 1900 y hoy')
  .optional();

export const createPetSchema = z.object({
  name: z.string().min(1, 'El nombre de la mascota es requerido').max(100),
  species: z.string().min(1, 'La especie es requerida').max(50),
  breed: z.string().min(1, 'La raza es requerida').max(50),
  weightKg: z
    .number()
    .positive('El peso debe ser positivo')
    .max(1500, 'El peso excede el límite fisiológico posible')
    .optional()
    .nullable(),
  sex: z.string().optional().nullable(),
  birthDate: birthDateSchema,
  microchip: z
    .string()
    .regex(/^\d{15}$/, 'El microchip debe poseer exactamente 15 digitos numericos ISO')
    .optional()
    .nullable(),
  allergies: z.string().optional().nullable(),
  chronicConditions: z.string().optional().nullable(),
});

export const updatePetSchema = createPetSchema.partial();

const ALLOWED_DOCUMENT_URL_REGEX = /^(https?:\/\/|\/uploads\/|\/api\/media\/|data:(image\/(?:png|jpeg|jpg|webp)|application\/pdf);base64,)/i;

export const createPetDocumentSchema = z.object({
  name: z.string().trim().min(1, 'El nombre del documento no puede estar vacío').max(200).optional(),
  title: z.string().trim().min(1, 'El título del documento no puede estar vacío').max(200).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  fileUrl: z
    .string()
    .max(15_000_000, 'El adjunto supera el tamaño máximo permitido')
    .refine(
      (val) => val.trim() === '' || ALLOWED_DOCUMENT_URL_REGEX.test(val.trim()),
      'Formato o protocolo de archivo no permitido'
    )
    .optional(),
  url: z
    .string()
    .max(15_000_000, 'El adjunto supera el tamaño máximo permitido')
    .refine(
      (val) => val.trim() === '' || ALLOWED_DOCUMENT_URL_REGEX.test(val.trim()),
      'Formato o protocolo de archivo no permitido'
    )
    .optional(),
  mediaId: z.string().uuid('Identificador de archivo inválido').optional(),
  category: z.enum(['LAB_RESULT', 'IMAGING', 'CERTIFICATE', 'PRESCRIPTION', 'OTHER']).optional(),
  consultationId: z.string().uuid('Identificador de consulta inválido').optional(),
});

export const setPetPhotoSchema = z.object({
  mediaId: z.string().uuid('Identificador de foto inválido'),
});

export const createVaccineSchema = z.object({
  name: z.string().trim().min(1, 'El nombre de la vacuna es requerido').max(120),
  appliedAt: z.string().trim().optional(),
  nextDueAt: z.string().trim().optional().nullable(),
  status: z.enum(['UP_TO_DATE', 'UPCOMING', 'OVERDUE']).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const updateVaccineSchema = createVaccineSchema.partial();

export const createEvolutionSchema = z.object({
  summary: z.string().trim().min(3, 'La evolución clínica debe tener al menos 3 caracteres').max(5000),
  consultationId: z.string().uuid('Identificador de consulta inválido').optional(),
  subjective: z.string().trim().max(2000).optional().nullable(),
  objective: z.string().trim().max(2000).optional().nullable(),
  assessment: z.string().trim().max(2000).optional().nullable(),
  plan: z.string().trim().max(2000).optional().nullable(),
});

export const addCoOwnerSchema = z.object({
  email: z.string().trim().email('Ingresá un correo válido para el co-tutor'),
});

export type CreatePetDTO = z.infer<typeof createPetSchema>;
export type UpdatePetDTO = z.infer<typeof updatePetSchema>;
export type CreatePetDocumentDTO = z.infer<typeof createPetDocumentSchema>;
export type CreateVaccineDTO = z.infer<typeof createVaccineSchema>;
export type UpdateVaccineDTO = z.infer<typeof updateVaccineSchema>;
export type CreateEvolutionDTO = z.infer<typeof createEvolutionSchema>;
export type AddCoOwnerDTO = z.infer<typeof addCoOwnerSchema>;
