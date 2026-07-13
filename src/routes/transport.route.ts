import { Router } from 'express';
import { authenticateTickets, requireTicketsPermission } from '@middleware/ticketsAuth.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TransportController } from '@controllers/transport.controller';

// Vendor (bus operator) transport inventory. Mounted at /api/tickets/transport
// — see src/app.ts, placed BEFORE the broader /api/tickets mount so these
// specific paths aren't shadowed.
const router = Router();

router.use(authenticateTickets);

const VIEW = requireTicketsPermission(TicketsPermission.VIEW_TRANSPORT);
const MANAGE = requireTicketsPermission(TicketsPermission.MANAGE_TRANSPORT);

// Vehicle types
router.post('/vehicle-types', MANAGE, TransportController.createVehicleType);
router.get('/vehicle-types', VIEW, TransportController.listVehicleTypes);
router.patch('/vehicle-types/:id', MANAGE, TransportController.updateVehicleType);
router.delete('/vehicle-types/:id', MANAGE, TransportController.deleteVehicleType);

// Routes
router.post('/routes', MANAGE, TransportController.createRoute);
router.get('/routes', VIEW, TransportController.listRoutes);
router.patch('/routes/:id', MANAGE, TransportController.updateRoute);
router.delete('/routes/:id', MANAGE, TransportController.deleteRoute);

// Trips
router.post('/trips', MANAGE, TransportController.createTrip);
router.get('/trips', VIEW, TransportController.listTrips);
router.get('/trips/:id', VIEW, TransportController.getTrip);
router.post('/trips/:id/seats/:seatNumber/reserve', MANAGE, TransportController.reserveSeat);
router.delete('/trips/:id/seats/:seatNumber/reserve', MANAGE, TransportController.releaseSeat);
router.patch('/trips/:id/reserved-count', MANAGE, TransportController.setReservedCount);

export default router;
