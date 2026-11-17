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

export type CreatePetDTO = z.infer<typeof createPetSchema>;
export type UpdatePetDTO = z.infer<typeof updatePetSchema>;
