/**
 * /api/v1/me — return the authenticated principal's profile.
 *
 * Used by the MC Web frontend on app load to populate the user widget +
 * gate admin-only UI affordances. Always behind authMiddleware so the
 * shape is guaranteed: a 401 here means the SPA should redirect to
 * /oauth2/sign_in.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  if (!req.user) {
    // authMiddleware should have rejected unauthenticated requests already.
    // If we reach here, the wiring is broken; surface it loudly.
    logger.error('GET /me: req.user missing — authMiddleware not wired?');
    res.status(500).json({ error: 'Auth middleware not wired' });
    return;
  }

  res.json({
    email: req.user.email,
    name: req.user.name,
    groups: req.user.groups,
    isAdmin: req.user.isAdmin,
  });
});

export default router;
