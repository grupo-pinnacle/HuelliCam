import { Router } from 'express';
import { authenticate } from '../auth/auth.middleware';
import { TemplatesController } from './templates.controller';

const router = Router();
const controller = new TemplatesController();

router.use(authenticate);

router.get('/', controller.list);
router.post('/', controller.create);
router.delete('/:id', controller.remove);

export default router;
