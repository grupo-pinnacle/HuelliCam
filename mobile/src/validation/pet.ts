import { z } from 'zod';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const birthDateClientSchema = z
  .preprocess((val) => {
    if (typeof val === 'string' && val.trim() === '') return null;
    return val;
  }, z.string().nullable().optional())
  .refine((val) => {
    if (!val) return true;
    const trimmed = val.trim();
    if (!DATE_ONLY_REGEX.test(trimmed)) return false;
    const parsed = new Date(`${trimmed}T12:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) return false;
    const endOfToday = new Date();
    endOfToday.setUTCHours(23, 59, 59, 999);
    return parsed >= new Date('1900-01-01T00:00:00.000Z') && parsed <= endOfToday;
  }, 'La fecha de nacimiento debe tener formato AAAA-MM-DD y no ser futura');

/** Espejo de backend pets.schemas.ts (create) para validación temprana en cliente. */
export const petCreateSchema = z.object({
  name: z.string().min(1, 'El nombre de la mascota es requerido').max(100),
  species: z.string().min(1, 'La especie es requerida').max(50),
  breed: z.string().min(1, 'La raza es requerida').max(50),
  weightKg: z.number().positive('El peso debe ser positivo').optional().nullable(),
  sex: z.string().optional().nullable(),
  birthDate: birthDateClientSchema,
  microchip: z
    .string()
    .regex(/^\d{15}$/, 'El microchip debe poseer exactamente 15 dígitos numéricos ISO')
    .optional()
    .nullable(),
  allergies: z.string().optional().nullable(),
  chronicConditions: z.string().optional().nullable(),
});

export const petUpdateSchema = petCreateSchema.partial();

export type PetCreateInput = z.infer<typeof petCreateSchema>;
export type PetUpdateInput = z.infer<typeof petUpdateSchema>;
