import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/auth.middleware';
import { paymentsService } from './payments.service';

export class PaymentsController {
  public getVetEarnings = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const summary = await paymentsService.getVetEarningsSummary(req.user!);
      res.status(200).json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  };
}
