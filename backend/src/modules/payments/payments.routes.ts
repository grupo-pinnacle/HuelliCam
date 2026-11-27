import { Router } from 'express';
import { authenticate } from '../auth/auth.middleware';
import { PaymentsController } from './payments.controller';

const router = Router();
const controller = new PaymentsController();

router.use(authenticate);
router.get('/vet/earnings', controller.getVetEarnings);

export default router;
