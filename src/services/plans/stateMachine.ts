/**
 * Plan state machine — valid transitions and helpers.
 *
 * Diagram (matches .claude/plans/look-into-turning-lxc-twinkly-tiger.md):
 *
 *   pending → presented → clicked → dispatched → in_progress → succeeded
 *                                                             → failed
 *                                                             → stuck
 *   presented → dismissed | expired
 *   any → resolved        (manual close from MC Web)
 *
 * Why explicit:
 *   - Catches bugs early (a stuck plan can't go straight to "succeeded";
 *     it must come back through dispatched or be manually resolved).
 *   - Documents the design in code, not just in the plan doc.
 *
 * Note: callers (planStore) wrap each transition in a transaction and
 * log to plan_events whether the transition was valid or rejected.
 */

export type PlanStatus =
  | 'pending'
  | 'presented'
  | 'clicked'
  | 'dispatched'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'stuck'
  | 'resolved'
  | 'dismissed'
  | 'expired';

const TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  pending:     ['presented', 'dismissed', 'expired', 'resolved'],
  presented:   ['clicked', 'dismissed', 'expired', 'resolved'],
  clicked:     ['dispatched', 'failed', 'resolved'],
  dispatched:  ['in_progress', 'failed', 'resolved'],
  in_progress: ['succeeded', 'failed', 'stuck', 'resolved'],
  // stuck → dispatched again when user picks one of the stuck-proposals
  stuck:       ['dispatched', 'failed', 'resolved', 'dismissed'],
  // terminal states — only 'resolved' allowed as override
  succeeded:   ['resolved'],
  failed:      ['dispatched', 'resolved'], // retry path
  dismissed:   ['resolved'],
  expired:     ['resolved'],
  resolved:    [], // truly terminal
};

export function isValidTransition(from: PlanStatus, to: PlanStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedNextStatuses(from: PlanStatus): PlanStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function isTerminal(status: PlanStatus): boolean {
  return TRANSITIONS[status]?.length === 0 || status === 'resolved';
}

export function isClosed(status: PlanStatus): boolean {
  return ['succeeded', 'failed', 'resolved', 'dismissed', 'expired'].includes(status);
}

export function isActive(status: PlanStatus): boolean {
  return ['pending', 'presented', 'clicked', 'dispatched', 'in_progress', 'stuck'].includes(status);
}
