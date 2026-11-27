import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/auth.middleware';
import { templatesService } from './templates.service';
import { createTemplateSchema } from './templates.schemas';

const getParamId = (param: string | string[]): string => (Array.isArray(param) ? param[0] : param);

export class TemplatesController {
  public list = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const items = await templatesService.listTemplates(req.user!, kind);
      res.status(200).json({ success: true, data: items });
    } catch (error) {
      next(error);
    }
  };

  public create = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = createTemplateSchema.parse(req.body);
      const created = await templatesService.createTemplate(req.user!, validated);
      res.status(201).json({ success: true, data: created });
    } catch (error) {
      next(error);
    }
  };

  public remove = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = getParamId(req.params.id);
      await templatesService.deleteTemplate(id, req.user!);
      res.status(200).json({ success: true, message: 'Plantilla eliminada' });
    } catch (error) {
      next(error);
    }
  };
}
