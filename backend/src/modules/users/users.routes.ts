import { Router } from 'express';
import { UsersController } from './users.controller';
import { authenticate } from '../auth/auth.middleware';

const router = Router();
const controller = new UsersController();

router.use(authenticate);

router.patch('/profile', controller.updateProfile);
router.patch('/password', controller.changePassword);
router.get('/telemedicine-consent', controller.getTelemedicineConsent);
router.post('/telemedicine-consent', controller.acceptTelemedicineConsent);

export default router;
