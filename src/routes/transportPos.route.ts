import { Router } from 'express';
import { authenticateReseller, requireResellerPermission } from '@middleware/resellerAuth.middleware';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';
import { TransportPosController } from '@controllers/transportPos.controller';

// POS / conductor bus selling + boarding. Mounted at /api/reseller/transport
// (a distinct path under the reseller namespace; not shadowed by /api/reseller).
const router = Router();

router.use(authenticateReseller);

router.get('/trips', requireResellerPermission(ResellerPermission.VIEW_EVENTS), TransportPosController.listTrips);
router.get('/trips/:id', requireResellerPermission(ResellerPermission.VIEW_EVENTS), TransportPosController.getTrip);
router.post('/bookings', requireResellerPermission(ResellerPermission.SELL_TICKETS), TransportPosController.sell);
router.post('/board', requireResellerPermission(ResellerPermission.SELL_TICKETS), TransportPosController.board);

export default router;
