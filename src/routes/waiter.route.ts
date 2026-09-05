import { Router } from 'express';
import { WaiterController } from '@controllers/waiter.controller';
import { authenticateWaiter, requireWaiterPermission } from '@middleware/waiterAuth.middleware';
import { WaiterPermission } from '@interfaces/waiter.interface';

const router = Router();
router.use(authenticateWaiter);

router.get('/events', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), WaiterController.getEvents);

export default router;
