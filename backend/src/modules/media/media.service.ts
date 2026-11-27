import fs from 'fs';
import path from 'path';
import { User, Role } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { config } from '../../config/env';

const MAX_DAILY_BYTES = 50 * 1024 * 1024; // 50 MB in bytes
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const rawUploadDir = config.UPLOAD_DIR || 'uploads';
const uploadsDir = path.isAbsolute(rawUploadDir)
  ? rawUploadDir
  : path.resolve(BACKEND_ROOT, rawUploadDir);
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const STORAGE_DRIVER = config.STORAGE_DRIVER;
const AWS_REGION = config.AWS_REGION;
const AWS_BUCKET_NAME = config.AWS_BUCKET_NAME;

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY || '',
  },
});

export class MediaService {
  public async uploadMediaFile(
    user: User,
    file: Express.Multer.File,
    consultationId?: string,
    petId?: string
  ) {
    const today = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
    const fileSizeBigInt = BigInt(file.size);

    // 1. Check daily upload counter (RNF-06)
    const counter = await prisma.dailyUploadCounter.findUnique({
      where: {
        userId_date: {
          userId: user.id,
          date: today,
        },
      },
    });

    const currentTotalBytes = counter ? counter.totalBytes : BigInt(0);
    if (currentTotalBytes + fileSizeBigInt > BigInt(MAX_DAILY_BYTES)) {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      throw new AppError('Cuota diaria de subida superada (maximo 50 MB por dia)', 429, 'UPLOAD_QUOTA_EXCEEDED');
    }

    let resolvedPetId: string | undefined = petId;

    // 2. Validate consultation if provided
    if (consultationId) {
      const consultation = await prisma.consultation.findUnique({
        where: { id: consultationId },
      });

      if (!consultation || consultation.deletedAt) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
      }

      const isParticipant =
        consultation.clientId === user.id ||
        consultation.vetId === user.id ||
        user.role === Role.ADMIN;

      if (!isParticipant) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        throw new AppError('Acceso denegado: no eres participante de la consulta', 403, 'FORBIDDEN');
      }

      if (!resolvedPetId) {
        resolvedPetId = consultation.petId;
      }
    } else if (petId && typeof prisma.pet?.findFirst === 'function') {
      const pet = await prisma.pet.findFirst({
        where: { id: petId, deletedAt: null },
      });
      if (!pet) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
      }
      const isCoOwner =
        typeof prisma.petCoOwner?.findFirst === 'function'
          ? Boolean(
              await prisma.petCoOwner
                .findFirst({ where: { petId: pet.id, userId: user.id } })
                .catch((err) => {
                  if (isMissingTableError(err)) return null;
                  throw err;
                })
            )
          : false;
      const isAuthorizedVet =
        user.role === Role.VET &&
        user.vetStatus === 'APPROVED' &&
        typeof prisma.consultation?.findFirst === 'function'
          ? Boolean(
              await prisma.consultation.findFirst({
                where: {
                  petId: pet.id,
                  vetId: user.id,
                  deletedAt: null,
                },
              })
            )
          : false;

      if (pet.ownerId !== user.id && !isCoOwner && !isAuthorizedVet && user.role !== Role.ADMIN) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        throw new AppError('Acceso denegado a la mascota', 403, 'FORBIDDEN');
      }
    }

    let finalPath: string | null = null;
    let s3Key: string | null = null;

    const finalFileName = `${Date.now()}-${path.basename(file.path)}`;

    // 3, 4 & 5. Persist binary object + re-verify quota + update counter + create MediaFile atomically,
    // cleaning up temp files or uploaded artifacts on any failure.
    try {
      if (STORAGE_DRIVER === 's3') {
        const targetS3Key = `uploads/${user.id}/${finalFileName}`;
        const fileBuffer = fs.readFileSync(file.path);

        await s3Client.send(
          new PutObjectCommand({
            Bucket: AWS_BUCKET_NAME,
            Key: targetS3Key,
            Body: fileBuffer,
            ContentType: file.mimetype,
          })
        );
        s3Key = targetS3Key;

        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } else {
        finalPath = path.join(uploadsDir, finalFileName);
        fs.renameSync(file.path, finalPath);
      }

      const mediaFile = await prisma.$transaction(async (tx) => {
        const txCounter = await tx.dailyUploadCounter.findUnique({
          where: {
            userId_date: {
              userId: user.id,
              date: today,
            },
          },
        });
        const txCurrentTotalBytes = txCounter ? txCounter.totalBytes : BigInt(0);
        if (txCurrentTotalBytes + fileSizeBigInt > BigInt(MAX_DAILY_BYTES)) {
          throw new AppError('Cuota diaria de subida superada (maximo 50 MB por dia)', 429, 'UPLOAD_QUOTA_EXCEEDED');
        }

        await tx.dailyUploadCounter.upsert({
          where: {
            userId_date: {
              userId: user.id,
              date: today,
            },
          },
          create: {
            userId: user.id,
            date: today,
            count: 1,
            totalBytes: fileSizeBigInt,
          },
          update: {
            count: { increment: 1 },
            totalBytes: { increment: fileSizeBigInt },
          },
        });

        const created = await tx.mediaFile.create({
          data: {
            ownerId: user.id,
            consultationId: consultationId || null,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
            localPath: finalPath,
            s3Key,
          },
        });

        if (resolvedPetId && typeof tx.mediaPetLink?.create === 'function') {
          await tx.mediaPetLink.create({
            data: {
              mediaFileId: created.id,
              petId: resolvedPetId,
            },
          });
        }

        return created;
      });

      return mediaFile;
    } catch (err) {
      if (finalPath && fs.existsSync(finalPath)) {
        try {
          fs.unlinkSync(finalPath);
        } catch {
          // Best-effort orphan file cleanup
        }
      }
      if (s3Key) {
        await s3Client
          .send(new DeleteObjectCommand({ Bucket: AWS_BUCKET_NAME, Key: s3Key }))
          .catch(() => {});
      }
      if (fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch {
          // Best-effort temp file cleanup
        }
      }
      throw err;
    }
  }

  public async canAccessMedia(
    requester: User,
    mediaFile: {
      id: string;
      ownerId: string;
      consultation?: { clientId: string; vetId: string | null; petId?: string | null } | null;
    }
  ): Promise<boolean> {
    if (requester.role === Role.ADMIN || mediaFile.ownerId === requester.id) {
      return true;
    }

    if (mediaFile.consultation) {
      if (
        mediaFile.consultation.clientId === requester.id ||
        mediaFile.consultation.vetId === requester.id
      ) {
        return true;
      }
    }

    const candidatePetIds = new Set<string>();
    if (mediaFile.consultation?.petId) {
      candidatePetIds.add(mediaFile.consultation.petId);
    }

    if (typeof prisma.mediaPetLink?.findUnique === 'function') {
      const petLink = await prisma.mediaPetLink
        .findUnique({
          where: { mediaFileId: mediaFile.id },
        })
        .catch((err) => {
          if (isMissingTableError(err)) return null;
          throw err;
        });
      if (petLink?.petId) {
        candidatePetIds.add(petLink.petId);
      }
    }

    if (typeof prisma.petDocument?.findFirst === 'function') {
      const petDoc = await prisma.petDocument
        .findFirst({
          where: { mediaFileId: mediaFile.id, deletedAt: null },
        })
        .catch((err) => {
          if (isMissingTableError(err)) return null;
          throw err;
        });
      if (petDoc?.petId) {
        candidatePetIds.add(petDoc.petId);
      }
    }

    for (const petId of candidatePetIds) {
      if (typeof prisma.pet?.findFirst === 'function') {
        const pet = await prisma.pet.findFirst({
          where: { id: petId, deletedAt: null },
        });
        if (pet?.ownerId === requester.id) {
          return true;
        }
      }

      if (typeof prisma.petCoOwner?.findFirst === 'function') {
        const coOwner = await prisma.petCoOwner
          .findFirst({
            where: { petId, userId: requester.id },
          })
          .catch((err) => {
            if (isMissingTableError(err)) return null;
            throw err;
          });
        if (coOwner) {
          return true;
        }
      }

      if (
        requester.role === Role.VET &&
        requester.vetStatus === 'APPROVED' &&
        typeof prisma.consultation?.findFirst === 'function'
      ) {
        const vetConsult = await prisma.consultation.findFirst({
          where: {
            petId,
            deletedAt: null,
            OR: [{ vetId: requester.id }, { status: 'WAITING' }],
          },
        });
        if (vetConsult) {
          return true;
        }
      }
    }

    return false;
  }

  public async getMediaFile(mediaId: string, requester: User) {
    const mediaFile = await prisma.mediaFile.findFirst({
      where: { id: mediaId, deletedAt: null },
      include: { consultation: true },
    });

    if (!mediaFile) {
      throw new AppError('Archivo no encontrado', 404, 'MEDIA_NOT_FOUND');
    }

    const allowed = await this.canAccessMedia(requester, mediaFile);
    if (!allowed) {
      throw new AppError('Acceso denegado al archivo medico', 403, 'FORBIDDEN');
    }

    if (STORAGE_DRIVER === 's3' && mediaFile.s3Key) {
      const command = new GetObjectCommand({
        Bucket: AWS_BUCKET_NAME,
        Key: mediaFile.s3Key,
      });

      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
      return {
        type: 's3' as const,
        presignedUrl,
        mediaFile,
      };
    }

    if (!mediaFile.localPath || !fs.existsSync(mediaFile.localPath)) {
      throw new AppError('El archivo fisico no esta disponible en el servidor', 404, 'FILE_NOT_FOUND_ON_DISK');
    }

    return {
      type: 'local' as const,
      localPath: mediaFile.localPath,
      mediaFile,
    };
  }
}
