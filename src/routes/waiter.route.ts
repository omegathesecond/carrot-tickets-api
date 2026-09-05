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
router.delete('/tables/:id/items/:lineId', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.removeItem);
router.post('/tables/:id/void', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.voidTable);
// SETTLE_TABLES, deliberately NOT MANAGE_TABLES: serving a table and taking
// money for it are different jobs, and the money one is a separate per-person
// grant (see WAITER_PERMISSIONS, which omits it).
router.post('/tables/:id/settle', requireWaiterPermission(WaiterPermission.SETTLE_TABLES), WaiterController.settleTable);

export default router;
