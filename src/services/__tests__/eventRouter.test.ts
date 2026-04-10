// import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
// import { EventEmitter } from 'events';
// import type { InfraEvent } from '@petedio/shared';

// // ─── Controllable eventBus ────────────────────────────────────────

// const testEventBus = new EventEmitter();
// testEventBus.setMaxListeners(50);

// mock.module('../../api/routes/events.js', () => ({ eventBus: testEventBus }));

// const { EventRouter } = await import('../eventRouter.js');

// // ─── Fixtures ─────────────────────────────────────────────────────

// function makeEvent(overrides: Partial<InfraEvent> = {}): InfraEvent {
//   return {
//     source: 'kubernetes',
//     type: 'pod-failure',
//     severity: 'warning',
//     message: 'Pod crashed',
//     timestamp: new Date().toISOString(),
//     affected_service: 'blog-agent',
//     namespace: 'blog-dev',
//     metadata: {},
//     ...overrides,
//   };
// }

// async function emit(event: InfraEvent): Promise<void> {
//   testEventBus.emit('event', event);
//   await new Promise(resolve => setTimeout(resolve, 0));
// }

// // ─── Tests ────────────────────────────────────────────────────────

// describe('EventRouter', () => {
//   let router: InstanceType<typeof EventRouter>;
//   let mockEnqueue: ReturnType<typeof mock>;

//   beforeEach(() => {
//     mockEnqueue = mock(() => Promise.resolve(undefined));
//     router = new EventRouter({ enqueue: mockEnqueue } as any);
//     router.start();
//   });

//   afterEach(() => {
//     router.stop();
//   });

//   it('routes pod-failure to ops-investigator', async () => {
//     await emit(makeEvent({ source: 'kubernetes', type: 'pod-failure' }));

//     expect(mockEnqueue).toHaveBeenCalledWith(
//       expect.objectContaining({
//         agentName: 'ops-investigator',
//         trigger: 'infra-event',
//         input: expect.objectContaining({ focus: 'pod-failure' }),
//       }),
//       expect.objectContaining({ priority: 5 }),
//     );
//   });

//   it('routes critical severity to ops-investigator with priority 1', async () => {
//     await emit(makeEvent({ severity: 'critical', source: 'prometheus', type: 'alert' }));

//     expect(mockEnqueue).toHaveBeenCalledWith(
//       expect.objectContaining({
//         agentName: 'ops-investigator',
//         input: expect.objectContaining({ focus: 'incident' }),
//       }),
//       expect.objectContaining({ priority: 1 }),
//     );
//   });

//   it('does not route k8s deployment events (blog-agent feedback loop removed)', async () => {
//     await emit(makeEvent({ source: 'kubernetes', type: 'deployment', severity: 'info' }));

//     expect(mockEnqueue).not.toHaveBeenCalled();
//   });

//   it('routes argocd sync-drift to ops-investigator', async () => {
//     await emit(makeEvent({ source: 'argocd', type: 'sync-drift', severity: 'warning' }));

//     expect(mockEnqueue).toHaveBeenCalledWith(
//       expect.objectContaining({
//         agentName: 'ops-investigator',
//         input: expect.objectContaining({ focus: 'sync-drift' }),
//       }),
//       expect.anything(),
//     );
//   });

//   it('ignores events that match no rules', async () => {
//     await emit(makeEvent({ source: 'proxmox', type: 'storage', severity: 'info' }));

//     expect(mockEnqueue).not.toHaveBeenCalled();
//   });

//   it('enforces cooldown — second event within window is dropped', async () => {
//     const event = makeEvent({ source: 'kubernetes', type: 'pod-failure' });

//     await emit(event);
//     expect(mockEnqueue).toHaveBeenCalledTimes(1);

//     await emit(event);
//     expect(mockEnqueue).toHaveBeenCalledTimes(1);
//   });

//   it('fires again after cooldown window expires', async () => {
//     const event = makeEvent({ source: 'kubernetes', type: 'pod-failure' });

//     await emit(event);
//     expect(mockEnqueue).toHaveBeenCalledTimes(1);

//     const realNow = Date.now;
//     Date.now = () => realNow() + 10 * 60 * 1000 + 1;
//     await emit(event);
//     Date.now = realNow;

//     expect(mockEnqueue).toHaveBeenCalledTimes(2);
//   });

//   it('stop() removes listener — no dispatch after stop', async () => {
//     router.stop();

//     await emit(makeEvent({ source: 'kubernetes', type: 'pod-failure' }));

//     expect(mockEnqueue).not.toHaveBeenCalled();
//   });

//   it('start() is idempotent — second call does not double-dispatch', async () => {
//     router.start();

//     await emit(makeEvent({ source: 'kubernetes', type: 'pod-failure' }));

//     expect(mockEnqueue).toHaveBeenCalledTimes(1);
//   });
// });
