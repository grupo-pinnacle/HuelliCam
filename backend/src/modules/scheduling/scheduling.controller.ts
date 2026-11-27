import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/auth.middleware';
import { schedulingService } from './scheduling.service';
import {
  createAppointmentSchema,
  createFollowUpSchema,
  updateFollowUpSchema,
  upsertAvailabilitySchema,
} from './scheduling.schemas';

const getParamId = (param: string | string[]): string => (Array.isArray(param) ? param[0] : param);

export class SchedulingController {
  public getMyAvailability = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const slots = await schedulingService.getMyAvailability(req.user!);
      res.status(200).json({ success: true, data: slots });
    } catch (error) {
      next(error);
    }
  };

  public upsertMyAvailability = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = upsertAvailabilitySchema.parse(req.body);
      const slots = await schedulingService.upsertMyAvailability(req.user!, validated);
      res.status(200).json({ success: true, data: slots });
    } catch (error) {
      next(error);
    }
  };

  public listVets = async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const vets = await schedulingService.listVetsWithAvailability();
      res.status(200).json({ success: true, data: vets });
    } catch (error) {
      next(error);
    }
  };

  public getVetSlots = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const vetId = getParamId(req.params.vetId);
      const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));
      const slots = await schedulingService.getVetAvailableSlots(vetId, dateStr);
      res.status(200).json({ success: true, data: slots });
    } catch (error) {
      next(error);
    }
  };

  public createAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createAppointmentSchema.parse(req.body);
      const appointment = await schedulingService.createScheduledAppointment(req.user!, validated);
      res.status(201).json({ success: true, data: appointment });
    } catch (error) {
      next(error);
    }
  };

  public listFollowUps = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await schedulingService.listFollowUps(req.user!);
      res.status(200).json({ success: true, data: items });
    } catch (error) {
      next(error);
    }
  };

  public createFollowUp = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createFollowUpSchema.parse(req.body);
      const followUp = await schedulingService.createFollowUp(req.user!, validated);
      res.status(201).json({ success: true, data: followUp });
    } catch (error) {
      next(error);
    }
  };

  public updateFollowUp = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = getParamId(req.params.id);
      const validated = updateFollowUpSchema.parse(req.body);
      const followUp = await schedulingService.updateFollowUp(id, req.user!, validated);
      res.status(200).json({ success: true, data: followUp });
    } catch (error) {
      next(error);
    }
  };
}
