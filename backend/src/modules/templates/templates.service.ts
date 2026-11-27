import { ClinicalTemplateKind, Role, User } from '@prisma/client';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import type { CreateTemplateDTO } from './templates.schemas';

const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin-evo-soap',
    vetId: null,
    kind: 'EVOLUTION' as const,
    title: 'SOAP Clínica General',
    category: 'SOAP',
    isDefault: true,
    content: {
      summary:
        'S (Subjetivo): Motivo reportado por el tutor y evolución previa.\nO (Objetivo): Mucosas rosadas, hidratación adecuada, actitud alerta.\nA (Evaluación): Cuadro compatible con proceso leve.\nP (Plan): Control en 48-72 hs o antes ante signos de alarma.',
    },
  },
  {
    id: 'builtin-evo-derma',
    vetId: null,
    kind: 'EVOLUTION' as const,
    title: 'Control Dermatológico',
    category: 'Dermatología',
    isDefault: true,
    content: {
      summary:
        'Se evalúan imágenes de piel y manto piloso. Prurito referido. Se indica higiene tópica medicada, monitoreo de lesiones y control fotográfico en 7 días.',
    },
  },
  {
    id: 'builtin-evo-gastro',
    vetId: null,
    kind: 'EVOLUTION' as const,
    title: 'Seguimiento Gastrointestinal',
    category: 'Gastroenterología',
    isDefault: true,
    content: {
      summary:
        'Episodios digestivos evaluados por teleconsulta. Se indica dieta blanda fraccionada, hidratación oral frecuente y pautas de alarma (vómitos incoercibles o decaimiento).',
    },
  },
  {
    id: 'builtin-rx-gastro',
    vetId: null,
    kind: 'PRESCRIPTION' as const,
    title: 'Protector Gástrico + Probiótico',
    category: 'Gastroenterología',
    isDefault: true,
    content: {
      medication: 'Omeprazol + Probiótico veterinario',
      dosage: 'Según peso corporal',
      frequency: 'Cada 24 horas',
      durationDays: 5,
      indications: 'Administrar 30 minutos antes de la primera comida junto con dieta blanda fraccionada.',
    },
  },
  {
    id: 'builtin-rx-derma',
    vetId: null,
    kind: 'PRESCRIPTION' as const,
    title: 'Shampoo Antiséptico Tópico',
    category: 'Dermatología',
    isDefault: true,
    content: {
      medication: 'Clorhexidina 2% + Miconazol (Shampoo)',
      dosage: 'Uso tópico en zona afectada',
      frequency: 'Cada 72 horas',
      durationDays: 14,
      indications: 'Dejar actuar la espuma durante 10 minutos antes de enjuagar con agua tibia y secar bien.',
    },
  },
];

export class TemplatesService {
  public async listTemplates(requester: User, kindParam?: string) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden acceder a plantillas clínicas', 403, 'FORBIDDEN');
    }

    const kindFilter =
      kindParam === 'EVOLUTION' || kindParam === 'PRESCRIPTION'
        ? (kindParam as ClinicalTemplateKind)
        : undefined;

    const customRows = prisma.clinicalTemplate?.findMany
      ? await prisma.clinicalTemplate
          .findMany({
            where: {
              OR: [{ vetId: requester.id }, { vetId: null }],
              ...(kindFilter ? { kind: kindFilter } : {}),
            },
            orderBy: { createdAt: 'desc' },
          })
          .catch((err) => {
            if (isMissingTableError(err)) return [];
            throw err;
          })
      : [];

    const customMapped = customRows.map((row) => ({
      id: row.id,
      vetId: row.vetId,
      kind: row.kind,
      title: row.name,
      category: row.category,
      content: (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>,
      isDefault: row.vetId === null,
    }));

    const defaults = BUILT_IN_TEMPLATES.filter((t) => !kindFilter || t.kind === kindFilter);
    return [...customMapped, ...defaults];
  }

  public async createTemplate(requester: User, dto: CreateTemplateDTO) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden crear plantillas clínicas', 403, 'FORBIDDEN');
    }

    const created = await prisma.clinicalTemplate.create({
      data: {
        vetId: requester.id,
        kind: dto.kind as ClinicalTemplateKind,
        name: dto.title.trim(),
        category: dto.category?.trim() || 'General',
        payload: dto.content as any,
      },
    });

    return {
      id: created.id,
      vetId: created.vetId,
      kind: created.kind,
      title: created.name,
      category: created.category,
      content: (created.payload && typeof created.payload === 'object' ? created.payload : {}) as Record<string, unknown>,
      isDefault: false,
    };
  }

  public async deleteTemplate(id: string, requester: User) {
    const existing = await prisma.clinicalTemplate.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Plantilla no encontrada', 404, 'TEMPLATE_NOT_FOUND');
    }

    if (existing.vetId !== requester.id && requester.role !== Role.ADMIN) {
      throw new AppError('No tenés permisos para eliminar esta plantilla', 403, 'FORBIDDEN');
    }

    await prisma.clinicalTemplate.delete({ where: { id } });
  }
}

export const templatesService = new TemplatesService();
