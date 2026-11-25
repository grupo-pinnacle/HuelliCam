import { Request, Response, NextFunction } from 'express';
import { CallsService } from './calls.service';
import { AuthenticatedRequest } from '../auth/auth.middleware';
import { getRequestId } from '../../middlewares/requestId';
import { logger } from '../../lib/logger';

const callsService = new CallsService();

const getParamId = (param: string | string[]): string => (Array.isArray(param) ? param[0] : param);

export class CallsController {
  public handleWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      const requestId = getRequestId(req);
      if (!authHeader) {
        logger.warn({ requestId, path: req.originalUrl }, 'LiveKit webhook missing authorization header');
        res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing authorization header',
            ...(requestId ? { requestId } : {}),
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
      const rawBody =
        (req as { rawBody?: Buffer | string }).rawBody ??
        (typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
      await callsService.handleWebhook(rawBody, authHeader);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  };

  public getToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const consultationId = getParamId(req.params.consultationId);
      const result = await callsService.generateLiveKitToken(consultationId, req.user!);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  public ring = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const consultationId = getParamId(req.params.consultationId);
      const result = await callsService.ringCall(consultationId, req.user!);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}
