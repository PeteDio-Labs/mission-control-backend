/**
 * import-roadmap-from-ts.ts
 *
 * One-shot importer: reads the TASKS array from the static kanban TS file
 * (planning/master-plan-kanban-tasks.ts) and POSTs them to MC Backend's
 * /api/v1/roadmap/tasks/bulk endpoint.
 *
 * Reference design: planning/MIGRATE-KANBAN-TO-MC.md (Phase 1, step 4).
 *
 * Run from the workspace root:
 *
 *   MC_URL=http://localhost:3000 \
 *   MC_ADMIN_TOKEN=<bearer-token> \
 *   bun run apps/mission-control/mission-control-backend/scripts/import-roadmap-from-ts.ts
 *
 * Idempotent — repeat runs upsert (existing rows get title/description/effort/
 * ws/depends_on updated; status is preserved on conflict to avoid clobbering
 * MC-side edits).
 *
 * Until Phase 4 retires the static HTML, this script can be re-run to one-way
 * sync any kanban-TS edits into MC.
 */

// The TS path is relative to this script's location; resolved at runtime by Bun.
// The kanban file uses ESM `import type { Task } from './master-plan-kanban-types'`
// which Bun handles via the registered tsconfig paths.
import { TASKS } from '../../../../planning/master-plan-kanban-tasks';

const MC_URL = process.env.MC_URL ?? 'http://localhost:3000';
const MC_ADMIN_TOKEN = process.env.MC_ADMIN_TOKEN;
const BATCH_SIZE = 200; // /bulk caps at 500/req; batch conservatively

if (!MC_ADMIN_TOKEN) {
  console.error('Missing MC_ADMIN_TOKEN env var.');
  console.error('Set it to a bearer token for an mc-admins user, then re-run.');
  process.exit(1);
}

interface KanbanTask {
  id: string;
  ws: string;
  status: string;
  effort: string;
  updatedAt: string;
  title: string;
  description: string;
  dependsOn?: string[];
}

interface BulkResult {
  imported: number;
  created: string[];
  updated: string[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postBatch(batch: KanbanTask[]): Promise<BulkResult> {
  // Map the kanban Task shape onto the API's CreateTaskBody schema. The
  // shapes already line up 1:1; we just rename the kanban's status values
  // (none needed — the kanban already uses backlog / in-progress / blocked /
  // awaiting-user / done, matching migration 007's CHECK constraint).
  const tasks = batch.map((t) => ({
    id: t.id,
    ws: t.ws,
    status: t.status as 'backlog' | 'in-progress' | 'blocked' | 'awaiting-user' | 'done',
    effort: t.effort,
    title: t.title,
    description: t.description,
    dependsOn: t.dependsOn ?? [],
  }));

  const res = await fetch(`${MC_URL}/api/v1/roadmap/tasks/bulk`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MC_ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tasks }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bulk upsert failed: ${res.status} ${res.statusText}\n${text}`);
  }

  return (await res.json()) as BulkResult;
}

async function main(): Promise<void> {
  console.log(`Importing ${TASKS.length} tasks to ${MC_URL}/api/v1/roadmap/tasks/bulk`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  const batches = chunk(TASKS as KanbanTask[], BATCH_SIZE);
  let totalCreated = 0;
  let totalUpdated = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    process.stdout.write(`  Batch ${i + 1}/${batches.length} (${batch.length} tasks)... `);
    const result = await postBatch(batch);
    totalCreated += result.created.length;
    totalUpdated += result.updated.length;
    console.log(`OK (created=${result.created.length}, updated=${result.updated.length})`);
  }

  console.log('');
  console.log('Done:');
  console.log(`  Total:   ${TASKS.length}`);
  console.log(`  Created: ${totalCreated}`);
  console.log(`  Updated: ${totalUpdated}`);
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
