import { User, Role, PetDocumentCategory, VaccineStatus } from '@prisma/client';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import {
  CreatePetDTO,
  UpdatePetDTO,
  CreateVaccineDTO,
  UpdateVaccineDTO,
  CreateEvolutionDTO,
  CreatePetDocumentDTO,
} from './pets.schemas';

function mapDocumentCategory(typeLabel?: string, explicit?: PetDocumentCategory): PetDocumentCategory {
  if (explicit) return explicit;
  const lower = (typeLabel || '').toLowerCase();
  if (lower.includes('sangre') || lower.includes('análisis') || lower.includes('analisis') || lower.includes('lab')) {
    return PetDocumentCategory.LAB_RESULT;
  }
  if (lower.includes('radio') || lower.includes('eco') || lower.includes('imagen') || lower.includes('estudio')) {
    return PetDocumentCategory.IMAGING;
  }
  if (lower.includes('certificado') || lower.includes('vacuna')) {
    return PetDocumentCategory.CERTIFICATE;
  }
  if (lower.includes('receta')) {
    return PetDocumentCategory.PRESCRIPTION;
  }
  return PetDocumentCategory.OTHER;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseFlexibleDate(raw?: string | null): Date | null {
  if (!raw || !raw.trim()) return null;
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class PetsService {
  public async createPet(ownerId: string, dto: CreatePetDTO) {
    if (dto.microchip) {
      const existing = await prisma.pet.findFirst({
        where: { microchip: dto.microchip, deletedAt: null },
      });
      if (existing) {
        throw new AppError('El numero de microchip ya se encuentra registrado', 409, 'MICROCHIP_ALREADY_EXISTS');
      }
    }

    const pet = await prisma.pet.create({
      data: {
        ownerId,
        name: dto.name,
        species: dto.species,
        breed: dto.breed,
        weightKg: dto.weightKg || null,
        sex: dto.sex || null,
        birthDate: dto.birthDate ?? null,
        microchip: dto.microchip || null,
        allergies: dto.allergies || null,
        chronicConditions: dto.chronicConditions || null,
      },
    });

    return pet;
  }

  public async getPetsByOwner(ownerId: string) {
    const [owned, coOwnedRows] = await Promise.all([
      prisma.pet.findMany({
        where: { ownerId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      typeof prisma.petCoOwner?.findMany === 'function'
        ? prisma.petCoOwner
            .findMany({
              where: { userId: ownerId, pet: { deletedAt: null } },
              include: { pet: true },
              orderBy: { createdAt: 'desc' },
            })
            .catch((err) => {
              if (isMissingTableError(err)) return [];
              throw err;
            })
        : Promise.resolve([]),
    ]);

    const merged = [...owned];
    const seen = new Set(owned.map((p) => p.id));
    for (const row of coOwnedRows) {
      if (row.pet && !seen.has(row.pet.id)) {
        merged.push(row.pet);
        seen.add(row.pet.id);
      }
    }

    if (merged.length > 0 && typeof prisma.petProfileMedia?.findMany === 'function') {
      const photos = await prisma.petProfileMedia
        .findMany({
          where: { petId: { in: merged.map((p) => p.id) } },
        })
        .catch((err) => {
          if (isMissingTableError(err)) return [];
          throw err;
        });
      const photoMap = new Map(photos.map((ph) => [ph.petId, ph.photoUrl]));
      return merged.map((p) => ({
        ...p,
        photoUrl: photoMap.get(p.id) ?? null,
      }));
    }

    return merged;
  }

  private async isCoOwner(petId: string, userId: string): Promise<boolean> {
    if (typeof prisma.petCoOwner?.findFirst !== 'function') return false;
    try {
      const match = await prisma.petCoOwner.findFirst({
        where: { petId, userId },
      });
      return Boolean(match);
    } catch (err) {
      if (isMissingTableError(err)) return false;
      throw err;
    }
  }

  public async getPetById(petId: string, requester: User) {
    const pet = await prisma.pet.findFirst({
      where: { id: petId, deletedAt: null },
      include: {
        owner: true,
      },
    });

    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    // Access control: Owner, Co-owner, VET, or ADMIN
    const isOwner = pet.ownerId === requester.id;
    const isCoOwner = !isOwner && requester.role === Role.CLIENT ? await this.isCoOwner(pet.id, requester.id) : false;
    const isAdmin = requester.role === Role.ADMIN;
    const isVet = requester.role === Role.VET;

    if (!isOwner && !isCoOwner && !isAdmin && !isVet) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    // PII Redaction rule:
    // When a VET accesses a pet, redact owner email/phone unless there is a consultation between this VET and this pet
    let redactPII = false;
    if (isVet && !isOwner && !isAdmin) {
      const activeOrPastConsultation = await prisma.consultation.findFirst({
        where: {
          petId: pet.id,
          vetId: requester.id,
          deletedAt: null,
        },
      });

      if (!activeOrPastConsultation) {
        redactPII = true;
      }
    }

    const profileMedia =
      typeof prisma.petProfileMedia?.findUnique === 'function'
        ? await prisma.petProfileMedia
            .findUnique({ where: { petId: pet.id } })
            .catch((err) => {
              if (isMissingTableError(err)) return null;
              throw err;
            })
        : null;

    const ownerData = {
      id: pet.owner.id,
      firstName: pet.owner.firstName,
      lastName: pet.owner.lastName,
      email: redactPII ? '[REDACTED]' : pet.owner.email,
      phone: redactPII ? '[REDACTED]' : pet.owner.phone,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { owner, ...petData } = pet;
    return {
      ...petData,
      ...(profileMedia?.photoUrl ? { photoUrl: profileMedia.photoUrl } : {}),
      owner: ownerData,
    };
  }

  public async updatePet(petId: string, requester: User, dto: UpdatePetDTO) {
    const pet = await prisma.pet.findFirst({
      where: { id: petId, deletedAt: null },
    });

    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    if (pet.ownerId !== requester.id && !isCoOwner && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado: solo el dueño puede modificar la mascota', 403, 'FORBIDDEN');
    }

    if (dto.microchip && dto.microchip !== pet.microchip) {
      const existing = await prisma.pet.findFirst({
        where: { microchip: dto.microchip, deletedAt: null },
      });
      if (existing) {
        throw new AppError('El numero de microchip ya se encuentra registrado', 409, 'MICROCHIP_ALREADY_EXISTS');
      }
    }

    return prisma.pet.update({
      where: { id: petId },
      data: dto,
    });
  }

  public async deletePet(petId: string, requester: User) {
    const pet = await prisma.pet.findFirst({
      where: { id: petId, deletedAt: null },
    });

    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    if (pet.ownerId !== requester.id && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado: solo el dueño puede eliminar la mascota', 403, 'FORBIDDEN');
    }

    // Soft-delete
    await prisma.pet.update({
      where: { id: petId },
      data: { deletedAt: new Date() },
    });

    return { message: 'Mascota eliminada exitosamente' };
  }

  public async setPetPhoto(petId: string, requester: User, mediaId: string) {
    const pet = await prisma.pet.findFirst({
      where: { id: petId, deletedAt: null },
    });
    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }
    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    if (pet.ownerId !== requester.id && !isCoOwner && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado: solo tutores autorizados pueden cambiar la foto', 403, 'FORBIDDEN');
    }

    const media = await prisma.mediaFile.findFirst({
      where: { id: mediaId, deletedAt: null },
    });
    if (!media) {
      throw new AppError('Imagen no encontrada', 404, 'MEDIA_NOT_FOUND');
    }
    if (media.ownerId !== requester.id && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado al archivo multimedia', 403, 'FORBIDDEN');
    }
    if (!media.mimeType.startsWith('image/')) {
      throw new AppError('La foto de la mascota debe ser una imagen válida', 400, 'INVALID_FILE_TYPE');
    }

    const photoUrl = `/api/media/${media.id}`;
    if (typeof prisma.mediaPetLink?.upsert === 'function') {
      await prisma.mediaPetLink.upsert({
        where: { mediaFileId: media.id },
        create: { mediaFileId: media.id, petId: pet.id },
        update: { petId: pet.id },
      });
    }

    const saved = await prisma.petProfileMedia.upsert({
      where: { petId: pet.id },
      create: { petId: pet.id, mediaFileId: media.id, photoUrl },
      update: { mediaFileId: media.id, photoUrl },
    });

    return saved;
  }

  public async listVaccines(petId: string, requester: User) {
    await this.getPetById(petId, requester);
    return prisma.petVaccine.findMany({
      where: { petId, deletedAt: null },
      orderBy: { appliedAt: 'desc' },
    });
  }

  public async createVaccine(petId: string, requester: User, dto: CreateVaccineDTO) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    const isApprovedVet = requester.role === Role.VET && requester.vetStatus === 'APPROVED';
    if (pet.ownerId !== requester.id && !isCoOwner && !isApprovedVet && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    const appliedAt = parseFlexibleDate(dto.appliedAt) ?? new Date();
    const nextDueAt = parseFlexibleDate(dto.nextDueAt ?? undefined);
    return prisma.petVaccine.create({
      data: {
        petId,
        createdById: requester.id,
        name: dto.name,
        appliedAt,
        nextDueAt,
        status: dto.status ?? VaccineStatus.UP_TO_DATE,
        notes: dto.notes ?? null,
      },
    });
  }

  public async updateVaccine(petId: string, vaccineId: string, requester: User, dto: UpdateVaccineDTO) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    const isApprovedVet = requester.role === Role.VET && requester.vetStatus === 'APPROVED';
    if (pet.ownerId !== requester.id && !isCoOwner && !isApprovedVet && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    const existing = await prisma.petVaccine.findFirst({ where: { id: vaccineId, petId, deletedAt: null } });
    if (!existing) throw new AppError('Vacuna no encontrada', 404, 'VACCINE_NOT_FOUND');

    return prisma.petVaccine.update({
      where: { id: vaccineId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.appliedAt !== undefined ? { appliedAt: parseFlexibleDate(dto.appliedAt) ?? existing.appliedAt } : {}),
        ...(dto.nextDueAt !== undefined ? { nextDueAt: parseFlexibleDate(dto.nextDueAt) } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  public async deleteVaccine(petId: string, vaccineId: string, requester: User) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    if (pet.ownerId !== requester.id && !isCoOwner && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }
    const existing = await prisma.petVaccine.findFirst({ where: { id: vaccineId, petId, deletedAt: null } });
    if (!existing) throw new AppError('Vacuna no encontrada', 404, 'VACCINE_NOT_FOUND');
    await prisma.petVaccine.update({ where: { id: vaccineId }, data: { deletedAt: new Date() } });
    return { message: 'Vacuna eliminada' };
  }

  public async listDocuments(petId: string, requester: User) {
    await this.getPetById(petId, requester);
    const docs = await prisma.petDocument.findMany({
      where: { petId, deletedAt: null },
      include: { mediaFile: true },
      orderBy: { createdAt: 'desc' },
    });
    return docs.map((d) => ({
      id: d.id,
      petId: d.petId,
      consultationId: d.consultationId,
      mediaFileId: d.mediaFileId,
      name: d.title,
      title: d.title,
      category: d.category,
      mimeType: d.mediaFile?.mimeType ?? null,
      url: d.mediaFileId ? `/api/media/${d.mediaFileId}` : d.externalUrl,
      size: d.sizeLabel ?? (d.mediaFile ? formatByteSize(d.mediaFile.fileSize) : 'Adjunto'),
      date: d.createdAt.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }),
      persisted: true,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  public async createDocument(
    petId: string,
    requester: User,
    dto: CreatePetDocumentDTO,
    uploadedFile?: Express.Multer.File
  ) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    let isAssignedVet = false;
    if (requester.role === Role.VET && pet.ownerId !== requester.id) {
      const vetConsultation = prisma.consultation?.findFirst
        ? await prisma.consultation.findFirst({
            where: { petId: pet.id, vetId: requester.id, deletedAt: null },
          })
        : null;
      isAssignedVet = Boolean(vetConsultation);
    }
    if (pet.ownerId !== requester.id && !isCoOwner && !isAssignedVet && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado: no autorizado para adjuntar documentos a esta mascota', 403, 'FORBIDDEN');
    }

    let mediaFileId: string | null = null;
    let resolvedUrl = (dto.fileUrl || dto.url || '').trim() || (uploadedFile ? `/uploads/${uploadedFile.filename}` : null);
    let resolvedSize = uploadedFile ? formatByteSize(uploadedFile.size) : 'Referencia externa';
    let mimeType: string | null = uploadedFile?.mimetype ?? null;

    const requestedMediaId = dto.mediaId || (dto as { mediaFileId?: string }).mediaFileId;
    if (requestedMediaId && prisma.mediaFile?.findFirst) {
      const media = await prisma.mediaFile.findFirst({
        where: { id: requestedMediaId, deletedAt: null },
      });
      if (!media) {
        throw new AppError('Archivo multimedia no encontrado', 404, 'MEDIA_NOT_FOUND');
      }
      if (media.ownerId !== requester.id && requester.role !== Role.ADMIN) {
        throw new AppError('Acceso denegado al archivo multimedia', 403, 'FORBIDDEN');
      }
      mediaFileId = media.id;
      resolvedUrl = `/api/media/${media.id}`;
      resolvedSize = formatByteSize(media.fileSize);
      mimeType = media.mimeType;

      if (typeof prisma.mediaPetLink?.upsert === 'function') {
        await prisma.mediaPetLink.upsert({
          where: { mediaFileId: media.id },
          create: { mediaFileId: media.id, petId },
          update: { petId },
        });
      }
    }

    const title = (
      dto.name ||
      dto.title ||
      (uploadedFile ? uploadedFile.originalname : 'Documento clínico')
    ).trim();
    const category = mapDocumentCategory(dto.type, dto.category);

    if (typeof prisma.petDocument?.create !== 'function') {
      const now = new Date();
      return {
        id: `doc-ephemeral-${now.getTime()}`,
        petId,
        consultationId: dto.consultationId ?? null,
        mediaFileId,
        name: title,
        title,
        type: dto.type || category,
        category,
        mimeType,
        url: resolvedUrl,
        size: resolvedSize,
        date: now.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }),
        persisted: false,
        createdAt: now.toISOString(),
      };
    }

    const created = await prisma.petDocument.create({
      data: {
        petId,
        consultationId: dto.consultationId ?? null,
        mediaFileId,
        uploadedById: requester.id,
        title,
        category,
        externalUrl: mediaFileId ? null : resolvedUrl,
        sizeLabel: resolvedSize,
      },
    });

    return {
      id: created.id,
      petId: created.petId,
      consultationId: created.consultationId,
      mediaFileId: created.mediaFileId,
      name: created.title,
      title: created.title,
      type: dto.type || created.category,
      category: created.category,
      mimeType,
      url: resolvedUrl,
      size: resolvedSize,
      date: created.createdAt.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }),
      persisted: true,
      createdAt: created.createdAt.toISOString(),
    };
  }

  public async deleteDocument(petId: string, documentId: string, requester: User) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    const isCoOwner = pet.ownerId !== requester.id ? await this.isCoOwner(pet.id, requester.id) : false;
    if (pet.ownerId !== requester.id && !isCoOwner && requester.role !== Role.ADMIN) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }
    const existing = await prisma.petDocument.findFirst({ where: { id: documentId, petId, deletedAt: null } });
    if (!existing) throw new AppError('Documento no encontrado', 404, 'DOCUMENT_NOT_FOUND');
    await prisma.petDocument.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
    return { message: 'Documento eliminado' };
  }

  public async listEvolutions(petId: string, requester: User) {
    await this.getPetById(petId, requester);
    return prisma.clinicalEvolution.findMany({
      where: { petId, deletedAt: null },
      include: { vet: { select: { id: true, firstName: true, lastName: true, licenseNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async createEvolution(petId: string, requester: User, dto: CreateEvolutionDTO) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden registrar evoluciones clínicas', 403, 'FORBIDDEN');
    }
    if (requester.role === Role.VET && requester.vetStatus !== 'APPROVED') {
      throw new AppError('Matrícula profesional pendiente de aprobación', 403, 'VET_NOT_APPROVED');
    }
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');

    if (dto.consultationId) {
      const consultation = await prisma.consultation.findFirst({
        where: { id: dto.consultationId, petId, deletedAt: null },
      });
      if (!consultation) {
        throw new AppError('Consulta clínica no encontrada para esta mascota', 404, 'CONSULTATION_NOT_FOUND');
      }
      await prisma.consultation.update({
        where: { id: consultation.id },
        data: { diagnosisNotes: dto.summary },
      });
    }

    return prisma.clinicalEvolution.create({
      data: {
        petId,
        consultationId: dto.consultationId ?? null,
        vetId: requester.id,
        summary: dto.summary,
        subjective: dto.subjective ?? null,
        objective: dto.objective ?? null,
        assessment: dto.assessment ?? null,
        plan: dto.plan ?? null,
      },
      include: { vet: { select: { id: true, firstName: true, lastName: true, licenseNumber: true } } },
    });
  }

  public async listCoOwners(petId: string, requester: User) {
    await this.getPetById(petId, requester);
    return prisma.petCoOwner.findMany({
      where: { petId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  public async addCoOwner(petId: string, requester: User, email: string) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    if (pet.ownerId !== requester.id && requester.role !== Role.ADMIN) {
      throw new AppError('Solo el tutor titular puede invitar co-tutores', 403, 'FORBIDDEN');
    }

    const targetUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!targetUser || targetUser.deletedAt) {
      throw new AppError('No encontramos un usuario registrado con ese correo', 404, 'USER_NOT_FOUND');
    }
    if (targetUser.id === pet.ownerId) {
      throw new AppError('El tutor titular ya tiene acceso completo a la mascota', 400, 'ALREADY_OWNER');
    }

    const existing = await prisma.petCoOwner.findFirst({
      where: { petId, userId: targetUser.id },
    });
    if (existing) {
      throw new AppError('Ese usuario ya es co-tutor de esta mascota', 409, 'CO_OWNER_ALREADY_EXISTS');
    }

    return prisma.petCoOwner.create({
      data: {
        petId,
        userId: targetUser.id,
        invitedById: requester.id,
        role: 'CO_TUTOR',
        acceptedAt: new Date(),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
  }

  public async removeCoOwner(petId: string, coOwnerId: string, requester: User) {
    const pet = await prisma.pet.findFirst({ where: { id: petId, deletedAt: null } });
    if (!pet) throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    if (pet.ownerId !== requester.id && requester.role !== Role.ADMIN) {
      throw new AppError('Solo el tutor titular puede quitar co-tutores', 403, 'FORBIDDEN');
    }

    const existing = await prisma.petCoOwner.findFirst({
      where: { id: coOwnerId, petId },
    });
    if (!existing) {
      throw new AppError('Co-tutor no encontrado', 404, 'CO_OWNER_NOT_FOUND');
    }
    await prisma.petCoOwner.delete({ where: { id: coOwnerId } });
    return { message: 'Co-tutor removido correctamente' };
  }

  public async getPetDossier(petId: string, requester: User) {
    const pet = await this.getPetById(petId, requester);
    const [vaccines, documents, evolutions, consultations, coOwners] = await Promise.all([
      typeof prisma.petVaccine?.findMany === 'function'
        ? prisma.petVaccine
            .findMany({
              where: { petId, deletedAt: null },
              orderBy: { appliedAt: 'desc' },
            })
            .catch((err) => {
              if (isMissingTableError(err)) return [];
              throw err;
            })
        : Promise.resolve([]),
      this.listDocuments(petId, requester).catch((err) => {
        if (isMissingTableError(err)) return [];
        throw err;
      }),
      typeof prisma.clinicalEvolution?.findMany === 'function'
        ? prisma.clinicalEvolution
            .findMany({
              where: { petId, deletedAt: null },
              include: { vet: { select: { id: true, firstName: true, lastName: true, licenseNumber: true } } },
              orderBy: { createdAt: 'desc' },
            })
            .catch((err) => {
              if (isMissingTableError(err)) return [];
              throw err;
            })
        : Promise.resolve([]),
      prisma.consultation.findMany({
        where: { petId, deletedAt: null },
        include: {
          vet: { select: { id: true, firstName: true, lastName: true, licenseNumber: true } },
          prescriptions: true,
          messages: {
            where: { attachmentUrl: { not: null }, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 30,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      typeof prisma.petCoOwner?.findMany === 'function'
        ? prisma.petCoOwner
            .findMany({
              where: { petId },
              include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
            })
            .catch((err) => {
              if (isMissingTableError(err)) return [];
              throw err;
            })
        : Promise.resolve([]),
    ]);

    const prescriptions = consultations.flatMap((c) =>
      c.prescriptions.map((rx) => ({
        ...rx,
        vet: c.vet,
      }))
    );

    const mediaGallery = [
      ...documents
        .filter((d) => Boolean(d.url))
        .map((d) => ({
          id: d.id,
          url: d.url!,
          title: d.title,
          mimeType: d.mimeType,
          date: d.date,
          source: 'document' as const,
        })),
      ...consultations.flatMap((c) =>
        c.messages
          .filter((m) => Boolean(m.attachmentUrl))
          .map((m) => ({
            id: m.id,
            url: m.attachmentUrl!,
            title: m.content?.replace(/^📎\s*Adjunto:\s*/i, '') || 'Adjunto de consulta',
            mimeType: /\.(pdf)$/i.test(m.attachmentUrl || '') ? 'application/pdf' : 'image/jpeg',
            date: m.createdAt.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }),
            source: 'consultation' as const,
          }))
      ),
    ];

    return {
      pet,
      vaccines,
      documents,
      evolutions,
      consultations: consultations.map(({ messages: _msgs, ...rest }) => rest),
      prescriptions,
      coOwners,
      mediaGallery,
    };
  }
}
