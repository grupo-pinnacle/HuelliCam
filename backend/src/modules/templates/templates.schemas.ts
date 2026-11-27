import { z } from 'zod';

export const createTemplateSchema = z.object({
  kind: z.enum(['EVOLUTION', 'PRESCRIPTION']),
  title: z.string().min(2, 'El título debe tener al menos 2 caracteres').max(120),
  category: z.string().min(1).max(60).optional().default('General'),
  content: z.record(z.string(), z.unknown()),
});

export type CreateTemplateDTO = z.infer<typeof createTemplateSchema>;
