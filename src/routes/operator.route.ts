// api/src/routes/operator.route.ts
import { Router } from 'express';
import { OperatorAuthController } from '@controllers/operatorAuth.controller';

const router = Router();
router.post('/login', OperatorAuthController.login);
export default router;
