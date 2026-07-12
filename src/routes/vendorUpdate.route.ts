import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { UpdateController } from '@controllers/update.controller';

// Vendor (organizer dashboard) counterpart to update.route.ts's buyer
// endpoints. Mounted at /api/tickets/updates — see src/app.ts, placed
// before the broader /api/tickets mount so this specific path isn't
// shadowed.
const router = Router();

router.post('/', authenticateTickets, UpdateController.createAsVendor);
router.post('/:id/finalize', authenticateTickets, UpdateController.finalizeAsVendor);

export default router;
