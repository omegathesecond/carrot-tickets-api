import { Router } from 'express';
import { WaiterController } from '@controllers/waiter.controller';
import { authenticateWaiter, requireWaiterPermission } from '@middleware/waiterAuth.middleware';
import { WaiterPermission } from '@interfaces/waiter.interface';

const router = Router();
router.use(authenticateWaiter);

router.get('/events', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), WaiterController.getEvents);

router.post('/tables', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.openTable);
router.get('/tables', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.listTables);
router.post('/tables/:id/items', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.addItem);

export default router;
