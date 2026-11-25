import express, { Router } from 'express';
import { CallsController } from './calls.controller';
import { authenticate } from '../auth/auth.middleware';

const router = Router();
const controller = new CallsController();

// Public LiveKit Webhook (authenticates via LiveKit HMAC header, not user JWT)
router.post('/webhook', express.raw({ type: '*/*' }), controller.handleWebhook);

router.use(authenticate);

router.post('/:consultationId/token', controller.getToken);
router.post('/:consultationId/ring', controller.ring);

export default router;
