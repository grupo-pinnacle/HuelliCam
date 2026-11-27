import { Router } from 'express';
import { authenticate } from '../auth/auth.middleware';
import { SchedulingController } from './scheduling.controller';

const router = Router();
const controller = new SchedulingController();

router.use(authenticate);

router.get('/vets/me/availability', controller.getMyAvailability);
router.put('/vets/me/availability', controller.upsertMyAvailability);
router.get('/vets', controller.listVets);
router.get('/vets/:vetId/slots', controller.getVetSlots);
router.post('/appointments', controller.createAppointment);
router.get('/follow-ups', controller.listFollowUps);
router.post('/follow-ups', controller.createFollowUp);
router.patch('/follow-ups/:id', controller.updateFollowUp);

export default router;
