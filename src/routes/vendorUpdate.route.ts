import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { UpdateController } from '@controllers/update.controller';

// Vendor (organizer dashboard) counterpart to update.route.ts's buyer
// endpoints. Mounted at /api/tickets/updates — see src/app.ts, placed
// before the broader /api/tickets mount so this specific path isn't
// shadowed.
const router = Router();

router.post('/', authenticateTickets, requireProfilePhoto, UpdateController.createAsVendor);
router.post('/:id/finalize', authenticateTickets, requireProfilePhoto, UpdateController.finalizeAsVendor);
router.post('/:id/like', authenticateTickets, requireProfilePhoto, UpdateController.reactAsVendor('like'));
router.post('/:id/save', authenticateTickets, UpdateController.reactAsVendor('save'));

export default router;
