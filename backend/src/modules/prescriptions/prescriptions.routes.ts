import { Router } from 'express';
import { PrescriptionsController } from './prescriptions.controller';
import { authenticate, optionalAuthenticate } from '../auth/auth.middleware';

const router = Router();
const controller = new PrescriptionsController();

// Public QR verification endpoint for third-party pharmacies / official scans (also populates req.user when Bearer token is sent)
router.get('/prescriptions/:id', optionalAuthenticate, controller.getByIdPublic);

// Authenticated client/user prescriptions listing
router.get('/prescriptions', authenticate, controller.getMyPrescriptions);

// Authenticated creation of official digital prescriptions
router.post('/consultations/:id/prescriptions', authenticate, controller.create);

export default router;
