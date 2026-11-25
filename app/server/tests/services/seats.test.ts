// Seats (spec 72) and the allowance they carry (72.5, 73.4): assigning creates the allowance
// and, on first activation, the onboarding grant; a joining member is given a free seat;
// pools draw from their parent; suspension reclaims; unassigning frees at once; releasing
// takes a seat out of the count for good.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { allocateSeatPool, assignSeat, listSeats, releaseSeat, unassignSeat } from '../../src/contracts/auth/seats.contract.ts';
import { suspendMember } from '../../src/contracts/policy/admin.contract.ts';
import { createMeteringService } from '../../src/routes/metering/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let root: Signed;
let gateway: ReturnType<ConnectCell['client']>;
let subscription: string;

const sql = (text: string, values: unknown[] = []) => inTx(cell.app, { orgId: cell.org }, () => cell.app.query(text, values));
const events = async (name: string) => (await sql(
  `select payload -> 'detail' as detail from platform.outbox where organisation_id = $1 and payload ->> 'event' = $2`, [cell.org, name])).rows;
const seatOf = async (membershipId: string) => (await sql(`select id, status, allocated_scope_id from billing.seats where membership_id = $1`, [membershipId])).rows[0];

before(async () => {
  cell = await createConnectCell({
    early: [{ definition: createMeteringService(), name: 'metering', extra: { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl } }],
  });
  root = await cell.signIn('root@acme.example');
  gateway = cell.client('gateway');
  // What billing writes from a verified subscription: the entitlement and three purchased, unassigned seats.
  subscription = uuidv7();
  await sql(`insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id, stripe_subscription_id,
               current_period_start, current_period_end, status)
             values ($1, $2, 'business', 3, 'monthly', 'list', 'cus_s', $3, now() - interval '1 day', now() + interval '29 days', 'active')`,
  [subscription, cell.org, `sub_${uuidv7().slice(-12)}`]);
  await sql(`insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit,
               storage_included_bytes, capabilities, source, subscription_id, effective_from)
             values ($1, $2, 3, 1000, 5, 40, 0, '{}', 'subscription', $3, now())`, [uuidv7(), cell.org, subscription]);
  for (let n = 0; n < 3; n++) {
    await sql(`insert into billing.seats (id, organisation_id, subscription_id, plan_tier) values ($1, $2, $3, 'business')`, [uuidv7(), cell.org, subscription]);
  }
});

after(async () => {
  await cell?.close();
});

describe('seats (spec 72)', () => {
  test('assigning a seat creates the allowance and the onboarding grant, once', async () => {
    const first = await gateway.call(assignSeat, { body: { membershipId: root.membershipId } }, cell.as(root));
    assert.equal(first.seat.status, 'assigned');
    assert.deepEqual([first.allowanceGranted, first.onboardingGranted], [true, true]);
    const { rows } = await sql('select onboarding_grant_remaining from billing.token_balances where membership_id = $1', [root.membershipId]);
    assert.equal(rows[0].onboarding_grant_remaining, 200);
    const again = await gateway.call(assignSeat, { body: { membershipId: root.membershipId } }, cell.as(root));
    assert.equal(again.seat.id, first.seat.id, 'a membership holds one seat');
    assert.equal(again.onboardingGranted, false);
    assert.equal((await events('seat_assigned')).length, 1);
  });

  test('a pool draws from its parent\'s free seats, and a member who joins there is given one of them', async () => {
    const pool = await gateway.call(allocateSeatPool, { body: { scopeId: cell.scopes['engineering']!, planTier: 'business', seats: 1 } }, cell.as(root));
    assert.deepEqual([pool.seatsAllocated, pool.available], [1, 1]);
    await assert.rejects(gateway.call(allocateSeatPool, { body: { scopeId: cell.scopes['sales']!, planTier: 'business', seats: 5 } }, cell.as(root)),
      { code: 'seats.pool_exceeded' });

    const engineer = await cell.member('eng@acme.example', 'Member', 'engineering');
    const seat = await seatOf(engineer.membershipId);
    assert.deepEqual([seat.status, seat.allocated_scope_id], ['assigned', cell.scopes['engineering']]);
    const { rows } = await sql('select tokens_granted from billing.token_allowances where membership_id = $1', [engineer.membershipId]);
    assert.equal(rows.length, 1, 'joining with a seat brings the allowance');
  });

  test('suspension reclaims the seat for someone else; unassigning frees one; releasing takes it out for good', async () => {
    const other = await cell.member('ops@acme.example', 'Member');
    assert.equal((await seatOf(other.membershipId)).status, 'assigned', 'the last organisation seat');
    const late = await cell.member('late@acme.example', 'Member');
    assert.equal(await seatOf(late.membershipId), undefined, 'none was free: they join seatless');
    await assert.rejects(gateway.call(assignSeat, { body: { membershipId: late.membershipId } }, cell.as(root)), { code: 'seats.none_available' });

    await gateway.call(suspendMember, { params: { membershipId: other.membershipId } }, cell.as(root));
    assert.equal((await events('seat_reclaimed')).length, 1);
    const moved = await gateway.call(assignSeat, { body: { membershipId: late.membershipId } }, cell.as(root));
    assert.equal(moved.seat.status, 'assigned', 'a reclaimed seat is assigned again');

    const freed = await gateway.call(unassignSeat, { params: { seatId: moved.seat.id } }, cell.as(root));
    assert.deepEqual([freed.status, freed.membershipId], ['unassigned', null]);
    const held = (await seatOf(root.membershipId)).id as string;
    await assert.rejects(gateway.call(releaseSeat, { params: { seatId: held } }, cell.as(root)), { code: 'seats.assigned' });
    const released = await gateway.call(releaseSeat, { params: { seatId: freed.id } }, cell.as(root));
    assert.equal(released.status, 'released');
    await assert.rejects(gateway.call(assignSeat, { body: { membershipId: late.membershipId } }, cell.as(root)), { code: 'seats.none_available' },
      'a released seat is never reassigned');

    const { counts } = await gateway.call(listSeats, {}, cell.as(root));
    assert.deepEqual(counts, { unassigned: 0, assigned: 2, reclaimed: 0, released: 1 });
    for (const e of ['seat_pool_allocated', 'seat_unassigned', 'seat_released']) assert.equal((await events(e)).length, 1, e);
  });
});
