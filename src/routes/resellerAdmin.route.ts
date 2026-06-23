import { Router } from 'express';
import { ResellerAdminController } from '@controllers/resellerAdmin.controller';
import {
  authenticateTickets,
  requireSuperAdmin,
} from '@middleware/ticketsAuth.middleware';

const router = Router();

// All admin endpoints require a valid JWT + super-admin flag.
router.use(authenticateTickets, requireSuperAdmin);

// ─── Resellers ───────────────────────────────────────────────────────────────
router.post('/resellers', ResellerAdminController.createReseller);
router.get('/resellers', ResellerAdminController.listResellers);
router.get('/resellers/:id', ResellerAdminController.getReseller);
router.patch('/resellers/:id', ResellerAdminController.updateReseller);

// ─── Hubs ────────────────────────────────────────────────────────────────────
router.post('/resellers/:id/hubs', ResellerAdminController.createHub);
router.get('/resellers/:id/hubs', ResellerAdminController.listHubs);
router.get('/hubs/:hubId', ResellerAdminController.getHub);
router.get('/hubs/:hubId/analytics', ResellerAdminController.getHubAnalytics);

// ─── Operators ───────────────────────────────────────────────────────────────
router.post('/hubs/:hubId/operators', ResellerAdminController.createOperator);
router.get('/hubs/:hubId/operators', ResellerAdminController.listOperators);
router.post('/operators/:id/reset-pin', ResellerAdminController.resetOperatorPin);

// ─── Ledger A — Reseller Settlement ──────────────────────────────────────────
router.get('/resellers/:id/settlement', ResellerAdminController.previewResellerSettlement);
router.post('/resellers/:id/settlement/close', ResellerAdminController.closeResellerSettlement);
router.post('/resellers/:id/settlement/:sid/mark-paid', ResellerAdminController.markResellerSettlementPaid);

// ─── Ledger B — Organizer Payout ─────────────────────────────────────────────
router.get('/vendors/:id/payout', ResellerAdminController.previewOrganizerPayout);
router.post('/vendors/:id/payout/close', ResellerAdminController.closeOrganizerPayout);
router.post('/vendors/:id/payout/:pid/mark-paid', ResellerAdminController.markOrganizerPayoutPaid);

export default router;
