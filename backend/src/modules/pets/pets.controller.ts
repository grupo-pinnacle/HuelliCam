import { Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { PetsService } from './pets.service';
import { createPetSchema, updatePetSchema, createPetDocumentSchema, setPetPhotoSchema, createVaccineSchema, updateVaccineSchema, createEvolutionSchema, addCoOwnerSchema } from './pets.schemas';
import { AuthenticatedRequest } from '../auth/auth.middleware';

const petsService = new PetsService();
const getParam = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value);

export class PetsController {
  public create = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createPetSchema.parse(req.body);
      const pet = await petsService.createPet(req.user!.id, validated);
      res.status(201).json({
        success: true,
        data: pet,
      });
    } catch (error) {
      next(error);
    }
  };

  public listMine = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pets = await petsService.getPetsByOwner(req.user!.id);
      res.status(200).json({
        success: true,
        data: pets,
      });
    } catch (error) {
      next(error);
    }
  };

  public getById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const petId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const pet = await petsService.getPetById(petId, req.user!);
      res.status(200).json({
        success: true,
        data: pet,
      });
    } catch (error) {
      next(error);
    }
  };

  public update = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const petId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const validated = updatePetSchema.parse(req.body);
      const pet = await petsService.updatePet(petId, req.user!, validated);
      res.status(200).json({
        success: true,
        data: pet,
      });
    } catch (error) {
      next(error);
    }
  };

  public delete = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const petId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await petsService.deletePet(petId, req.user!);
      res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  };

  public uploadDocument = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const petId = getParam(req.params.id);
      const validated = createPetDocumentSchema.parse(req.body || {});
      const document = await petsService.createDocument(petId, req.user!, validated, req.file);
      res.status(201).json({
        success: true,
        data: document,
      });
    } catch (error) {
      next(error);
    }
  };

  public listDocuments = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await petsService.listDocuments(getParam(req.params.id), req.user!);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public deleteDocument = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await petsService.deleteDocument(getParam(req.params.id), getParam(req.params.documentId), req.user!);
      res.status(200).json({ success: true, message: result.message });
    } catch (error) {
      next(error);
    }
  };

  public getDossier = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await petsService.getPetDossier(getParam(req.params.id), req.user!);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public setPhoto = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { mediaId } = setPetPhotoSchema.parse(req.body || {});
      const data = await petsService.setPetPhoto(getParam(req.params.id), req.user!, mediaId);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public listVaccines = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await petsService.listVaccines(getParam(req.params.id), req.user!);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public createVaccine = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createVaccineSchema.parse(req.body || {});
      const data = await petsService.createVaccine(getParam(req.params.id), req.user!, validated);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public updateVaccine = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = updateVaccineSchema.parse(req.body || {});
      const data = await petsService.updateVaccine(getParam(req.params.id), getParam(req.params.vaccineId), req.user!, validated);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public deleteVaccine = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await petsService.deleteVaccine(getParam(req.params.id), getParam(req.params.vaccineId), req.user!);
      res.status(200).json({ success: true, message: result.message });
    } catch (error) {
      next(error);
    }
  };

  public listEvolutions = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await petsService.listEvolutions(getParam(req.params.id), req.user!);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public createEvolution = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createEvolutionSchema.parse(req.body || {});
      const data = await petsService.createEvolution(getParam(req.params.id), req.user!, validated);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public listCoOwners = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await petsService.listCoOwners(getParam(req.params.id), req.user!);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public addCoOwner = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email } = addCoOwnerSchema.parse(req.body || {});
      const data = await petsService.addCoOwner(getParam(req.params.id), req.user!, email);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  public removeCoOwner = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await petsService.removeCoOwner(getParam(req.params.id), getParam(req.params.coOwnerId), req.user!);
      res.status(200).json({ success: true, message: result.message });
    } catch (error) {
      next(error);
    }
  };
}
