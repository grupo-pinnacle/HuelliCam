import { Router } from 'express';
import { PetsController } from './pets.controller';
import { authenticate } from '../auth/auth.middleware';

const router = Router();
const controller = new PetsController();

router.use(authenticate);

router.post('/', controller.create);
router.get('/', controller.listMine);
router.get('/:id', controller.getById);
router.get('/:id/dossier', controller.getDossier);
router.post('/:id/photo', controller.setPhoto);
router.get('/:id/vaccines', controller.listVaccines);
router.post('/:id/vaccines', controller.createVaccine);
router.patch('/:id/vaccines/:vaccineId', controller.updateVaccine);
router.delete('/:id/vaccines/:vaccineId', controller.deleteVaccine);
router.get('/:id/documents', controller.listDocuments);
router.post('/:id/documents', controller.uploadDocument);
router.delete('/:id/documents/:documentId', controller.deleteDocument);
router.get('/:id/evolutions', controller.listEvolutions);
router.post('/:id/evolutions', controller.createEvolution);
router.get('/:id/co-owners', controller.listCoOwners);
router.post('/:id/co-owners', controller.addCoOwner);
router.delete('/:id/co-owners/:coOwnerId', controller.removeCoOwner);
router.patch('/:id', controller.update);
router.delete('/:id', controller.delete);

export default router;
