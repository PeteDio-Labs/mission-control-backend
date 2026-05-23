import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { logger } from './utils/logger';
import routes from './api/routes';

const app: Application = express();

// Morgan HTTP logger integration with Pino
const morganStream = {
  write: (message: string) => logger.info(message.trim()),
};

// Middleware
app.use(helmet());

// CORS: explicit allow-list (per security review, dropping the '*' fallback).
// With credentials:true, '*' would be refused by browsers anyway AND opens a
// CSRF window if someone misreads the response — better to fail closed.
// Override via CORS_ORIGINS (comma-separated) for prod / dev overlays.
const corsAllowList = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [
      'https://mc.pdlab.dev',
      'https://mc-dev.pdlab.dev',
      'http://localhost:5173', // Vite dev
      'http://localhost:3001',
    ];
if (!process.env.CORS_ORIGINS) {
  logger.warn(
    `CORS_ORIGINS not set — using built-in dev allow-list: ${corsAllowList.join(', ')}. ` +
      'Set CORS_ORIGINS in prod to your actual public origins.',
  );
}
app.use(
  cors({
    origin: corsAllowList,
    credentials: true,
  })
);
// RETRO.13: capture raw request body for HMAC verification.
// /api/v1/discord (Pete Bot v2 click forwarder) and /api/v1/github/webhook both
// verify HMAC over the literal bytes the sender signed. Without this verify
// callback, express.json() consumes the stream and the only way to reconstruct
// "what was signed" is JSON.stringify(req.body) — which is NOT byte-equivalent
// (key ordering, whitespace, escaping all differ). Storing the raw buffer here
// costs ~bytes-of-body extra memory (we already buffer to parse JSON anyway)
// and unlocks byte-exact HMAC verify in every downstream handler.
app.use(
  express.json({
    limit: '2mb',
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan('combined', { stream: morganStream }));

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Mission Control Backend API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use(routes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
  });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

export { app };
export default app;
