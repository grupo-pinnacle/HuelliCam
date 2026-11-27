import { Router } from 'express';
import { NotificationsController } from './notifications.controller';
import { authenticate } from '../auth/auth.middleware';

const router = Router();
const controller = new NotificationsController();

router.use(authenticate);

router.post('/register-token', controller.registerToken);
router.get('/preferences', controller.getPreferences);
router.put('/preferences', controller.updatePreferences);
router.get('/push/vapid-public-key', controller.getVapidPublicKey);
router.post('/push/subscribe', controller.subscribeWebPush);
router.delete('/push/subscribe', controller.unsubscribeWebPush);
router.get('/', controller.listMine);
router.patch('/read-all', controller.markAllRead);
router.patch('/:id/read', controller.markRead);

export default router;
