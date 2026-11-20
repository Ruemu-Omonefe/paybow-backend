/** Scenario tests for the transaction service (report §3.9 + the updated spec), run against in-memory persistence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, kobo, oid, uuid } from './world';

test('registration state: mirror starts at zero; funding credits the mirror once', async () => {
  const w = createWorld();
  const a = w.user('Ada');
  assert.equal(w.balance(a), 0);
  const f = await w.fund(a, kobo(1000));
  assert.equal(f.res.status, 'CONFIRMED');
  assert.equal(w.balance(a), kobo(1000));
  const again = await w.funding.applyOnSync(a.auth, { reference: f.rec.reference, amount: kobo(1000) });
  assert.equal(again.status, 'CONFIRMED');
  assert.equal(again.duplicate, true);
  assert.equal(w.balance(a), kobo(1000)); // "Wallet funding repeat: credited once"
});

test('funding: unverified, foreign, wrong-amount and unknown references are not credited', async () => {
  const w = createWorld();
  const a = w.user('Ada');
  const b = w.user('Bola');
  const rec = await w.funding.initiate(a.auth, kobo(500));
  assert.equal((await w.funding.applyOnSync(a.auth, { reference: rec.reference, amount: kobo(500) })).status, 'REJECTED'); // not paid/verified
  await assert.rejects(() => w.funding.verify(a.auth, rec.reference), /not completed/);
  await w.funding.simulatePayment(a.auth, rec.reference);
  const conf1 = await w.funding.verify(a.auth, rec.reference);
  const conf2 = await w.funding.verify(a.auth, rec.reference);
  assert.deepEqual(conf1, conf2); // verification is idempotent
  assert.equal((await w.funding.applyOnSync(b.auth, { reference: rec.reference, amount: kobo(500) })).status, 'REJECTED'); // someone else's reference
  assert.equal((await w.funding.applyOnSync(a.auth, { reference: rec.reference, amount: kobo(900) })).status, 'REJECTED'); // amount mismatch
  assert.equal((await w.funding.applyOnSync(a.auth, { reference: 'FND-0000000000000000', amount: kobo(500) })).status, 'REJECTED');
  assert.equal(w.balance(a), 0);
  await assert.rejects(() => w.funding.initiate(a.auth, 5), /between/);
});

test('both sides submit: confirmed once, mirrors move, total conserved', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(400));
  const r1 = await w.txs.processOne(b.auth, w.received(p, b), 'devB');
  assert.equal(r1.status, 'CONFIRMED');
  const r2 = await w.txs.processOne(a.auth, p, 'devA');
  assert.equal(r2.status, 'CONFIRMED');
  assert.equal(r2.duplicate, true);
  assert.equal(w.balance(a), kobo(600));
  assert.equal(w.balance(b), kobo(400));
  assert.equal(w.total(), kobo(1000));
});

test('sender-only: UNRESOLVED (debit applied); receiver arrives later: credited once, no second debit', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(300));
  const r1 = await w.txs.processOne(a.auth, p);
  assert.equal(r1.status, 'UNRESOLVED');
  assert.equal(w.balance(a), kobo(700));
  assert.equal(w.balance(b), 0);
  const r2 = await w.txs.processOne(b.auth, w.received(p, b));
  assert.equal(r2.status, 'CONFIRMED');
  assert.equal(w.balance(a), kobo(700));
  assert.equal(w.balance(b), kobo(300));
  // resubmissions change nothing
  await w.txs.processOne(a.auth, p);
  await w.txs.processOne(b.auth, w.received(p, b));
  assert.equal(w.balance(a), kobo(700));
  assert.equal(w.balance(b), kobo(300));
});

test('concurrent submissions of the same transaction (both sides): exactly one effect', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(250));
  const calls = [
    ...Array.from({ length: 5 }, () => w.txs.processOne(a.auth, p)),
    ...Array.from({ length: 5 }, () => w.txs.processOne(b.auth, w.received(p, b))),
  ];
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.status === 'CONFIRMED' || r.status === 'UNRESOLVED'));
  assert.equal(w.balance(a), kobo(750));
  assert.equal(w.balance(b), kobo(250));
  assert.equal(w.repo._txs.size, 1);
});

test('tampered payment, forged signer, foreign/expired/unregistered certificates are rejected', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola'), mallory = w.user('Mallory');
  await w.fund(a, kobo(1000));
  const tampered = w.payment(a, b, kobo(100));
  tampered.amount = kobo(900);
  assert.match((await w.txs.processOne(a.auth, tampered)).reason!, /Invalid signature/);

  const forged = w.payment(a, b, kobo(100), { signature: w.payment(mallory, b, kobo(100)).signature });
  assert.match((await w.txs.processOne(a.auth, forged)).reason!, /Invalid signature/);

  // Mallory presents Ada's certificate for her own key: certificate/name mismatch or signature failure
  const stolen = w.payment(mallory, b, kobo(100), { payer_id: a.id, payer_name: a.name, payer_certificate: a.cert });
  assert.equal((await w.txs.processOne(a.auth, stolen)).status, 'REJECTED');

  // self-made certificate (not signed by the backend)
  const fake = { ...mallory.cert, aid: a.id, nm: a.name, pk: mallory.publicKey };
  const selfCert = w.payment(mallory, b, kobo(100), { payer_id: a.id, payer_name: a.name, payer_certificate: fake });
  assert.match((await w.txs.processOne(a.auth, selfCert)).reason!, /certificate/i);

  // certificate expired at the time of the payment
  w.advance(40 * 24 * 3600_000);
  const late = w.payment(a, b, kobo(100));
  assert.match((await w.txs.processOne(a.auth, late)).reason!, /expired sender certificate/);
  assert.equal(w.balance(a), kobo(1000));
});

test('invalid receiver acceptance (wrong signer / other payment) is rejected and nobody is credited', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola'), c = w.user('Chidi');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(200));
  const forged = w.received(p, b, undefined, b.cert, c); // signed with Chidi's key
  const r = await w.txs.processOne(b.auth, forged);
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason!, /acceptance/i);
  assert.equal(w.balance(b), 0);
  assert.equal(w.balance(a), kobo(1000)); // nothing applied
  const late = w.received(p, b, p.expires_at + 10 * 60_000);
  assert.match((await w.txs.processOne(b.auth, late)).reason!, /validity/);
  const noAcceptance = { ...p };
  assert.match((await w.txs.processOne(b.auth, noAcceptance)).reason!, /Missing receiver acceptance/);
});

test('same transaction ID with different details => CONFLICT; malformed / third-party / limits rejected', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola'), c = w.user('Chidi');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(200));
  await w.txs.processOne(a.auth, p);
  const clash = w.payment(a, b, kobo(500), { transaction_id: p.transaction_id });
  assert.equal((await w.txs.processOne(a.auth, clash)).status, 'CONFLICT');
  assert.equal(w.balance(a), kobo(800));
  assert.match((await w.txs.processOne(a.auth, { transaction_id: 'nope', amount: -5 })).reason!, /Malformed/);
  assert.match((await w.txs.processOne(c.auth, w.payment(a, b, kobo(100)))).reason!, /not a party/);
  assert.match((await w.txs.processOne(a.auth, w.payment(a, a, kobo(100)))).reason!, /same account/);
  assert.match((await w.txs.processOne(a.auth, w.payment(a, b, kobo(50)))).reason!, /limits/); // below ₦100
  assert.match((await w.txs.processOne(a.auth, w.payment(a, { ...b, id: oid() } as any, kobo(100)))).reason!, /Receiver account/);
  assert.match((await w.txs.processOne(a.auth, w.payment(a, b, kobo(100), { timestamp: w.now() + 10 * 60_000, expires_at: w.now() + 11 * 60_000 }))).reason!, /future/);
});

test('insufficient mirror balance with all dependencies applied => REJECTED (overspend)', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(300));
  const p = w.payment(a, b, kobo(500), { dependencies: [] });
  const r = await w.txs.processOne(a.auth, p);
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason!, /Insufficient/);
  assert.equal(w.balance(a), kobo(300));
});

test('A→B→C offline chain: C syncs first, then A, then B – dependency order is respected', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola'), c = w.user('Chidi');
  // A funded ₦1,000 (online, but funding not yet synced to the mirror)
  const fundingRec = await w.funding.initiate(a.auth, kobo(1000));
  await w.funding.simulatePayment(a.auth, fundingRec.reference);
  await w.funding.verify(a.auth, fundingRec.reference);

  const t1 = w.payment(a, b, kobo(500), { dependencies: [fundingRec.reference] }); // A → B ₦500
  const t2 = w.payment(b, c, kobo(300), { dependencies: [t1.transaction_id] }); // B → C ₦300 (spends received money)

  // 1) C synchronizes first
  const rc = await w.txs.processOne(c.auth, w.received(t2, c));
  assert.equal(rc.status, 'DEFERRED');
  assert.equal(w.total(), 0);

  // 2) A synchronizes: funding then payment
  assert.equal((await w.funding.applyOnSync(a.auth, { reference: fundingRec.reference, amount: kobo(1000) })).status, 'CONFIRMED');
  const ra = await w.txs.processOne(a.auth, t1);
  assert.equal(ra.status, 'UNRESOLVED'); // B's record not here yet
  assert.equal(w.balance(a), kobo(500));

  // 3) B synchronizes: incoming first, then outgoing
  const rb1 = await w.txs.processOne(b.auth, w.received(t1, b));
  assert.equal(rb1.status, 'CONFIRMED');
  // the deferred B→C payment is released automatically as soon as B's mirror is credited
  assert.equal(w.repo._txs.get(t2.transaction_id)!.state, 'CONFIRMED');
  const rb2 = await w.txs.processOne(b.auth, { ...t2, dependencies: [t1.transaction_id] });
  assert.equal(rb2.status, 'CONFIRMED');
  assert.deepEqual([w.balance(a), w.balance(b), w.balance(c)], [kobo(500), kobo(200), kobo(300)]);
  assert.equal(w.total(), kobo(1000)); // the total is conserved
});

test('dependent spend submitted by its sender before the source syncs is DEFERRED, then confirms', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola'), c = w.user('Chidi');
  await w.fund(a, kobo(1000));
  const t1 = w.payment(a, b, kobo(500));
  const t2 = w.payment(b, c, kobo(300), { dependencies: [t1.transaction_id] });
  // B submits only its outgoing payment first (its incoming t1 not synced yet)
  const r = await w.txs.processOne(b.auth, t2);
  assert.equal(r.status, 'DEFERRED');
  assert.equal(w.balance(b), 0);
  await w.txs.processOne(a.auth, t1);
  await w.txs.processOne(b.auth, w.received(t1, b)); // B's mirror credited -> t2 released (debit B), awaiting C
  assert.equal(w.repo._txs.get(t2.transaction_id)!.state, 'UNRESOLVED');
  await w.txs.processOne(c.auth, w.received(t2, c));
  assert.deepEqual([w.balance(a), w.balance(b), w.balance(c)], [kobo(500), kobo(200), kobo(300)]);
});

test('refund: expired payment, receiver not credited – only after the receiver completed a sync; one refund only', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(400));
  // sender syncs while the QR is still valid -> unresolved, no refund
  assert.equal((await w.txs.processOne(a.auth, p)).status, 'UNRESOLVED');
  // QR expires; receiver has not synchronized yet -> still unresolved (receiver may have scanned offline)
  w.advance(10 * 60_000);
  assert.equal((await w.txs.processOne(a.auth, p)).status, 'UNRESOLVED');
  assert.equal(w.balance(a), kobo(600));
  // receiver completes a full synchronization with no record of this payment -> refund evidence exists
  await w.txs.completeSync(b.id);
  const r = await w.txs.processOne(a.auth, p);
  assert.equal(r.status, 'REFUNDED');
  assert.equal(r.refund!.reference, `RFD-${p.transaction_id}`);
  assert.equal(w.balance(a), kobo(1000));
  assert.equal(w.balance(b), 0);
  // repeated refund attempts return the earlier result; no second credit
  const again = await w.txs.processOne(a.auth, p);
  assert.equal(again.status, 'REFUNDED');
  assert.deepEqual(again.refund, r.refund);
  await w.txs.completeSync(b.id);
  assert.equal(w.balance(a), kobo(1000));
  // a late receiver record cannot claim a refunded payment
  const late = await w.txs.processOne(b.auth, w.received(p, b));
  assert.equal(late.status, 'CONFLICT');
  assert.match(late.reason!, /already refunded/);
  assert.equal(w.balance(b), 0);
});

test('refund is issued as soon as the receiver completes a sync after the sender already synced', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(400));
  await w.txs.processOne(a.auth, p);
  w.advance(10 * 60_000);
  await w.txs.completeSync(b.id); // triggers evaluation of unresolved expired payments addressed to B
  assert.equal(w.repo._txs.get(p.transaction_id)!.state, 'REFUNDED');
  assert.equal(w.balance(a), kobo(1000));
});

test('no refund when the receiver DID accept (receiver record exists), even if expired', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const p = w.payment(a, b, kobo(400));
  await w.txs.processOne(b.auth, w.received(p, b));
  w.advance(10 * 60_000);
  await w.txs.completeSync(b.id);
  const r = await w.txs.processOne(a.auth, p);
  assert.equal(r.status, 'CONFIRMED');
  assert.equal(w.balance(a), kobo(600));
  assert.equal(w.balance(b), kobo(400));
});

test('refund unblocks the sender: a previously deferred spend can proceed', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola'), c = w.user('Chidi');
  await w.fund(a, kobo(500));
  const lost = w.payment(a, b, kobo(500));
  await w.txs.processOne(a.auth, lost);
  const next = w.payment(a, c, kobo(300), { dependencies: [lost.transaction_id] });
  assert.equal((await w.txs.processOne(c.auth, w.received(next, c))).status, 'DEFERRED'); // A has no mirror funds now
  w.advance(10 * 60_000);
  await w.txs.completeSync(b.id); // refund A ₦500 -> cascade releases the deferred A→C payment
  assert.equal(w.repo._txs.get(lost.transaction_id)!.state, 'REFUNDED');
  assert.equal(w.repo._txs.get(next.transaction_id)!.state, 'CONFIRMED');
  assert.deepEqual([w.balance(a), w.balance(b), w.balance(c)], [kobo(200), 0, kobo(300)]);
});

test('intermittent network: whole queue resubmitted repeatedly causes no extra effects', async () => {
  const w = createWorld();
  const a = w.user('Ada'), b = w.user('Bola');
  await w.fund(a, kobo(1000));
  const queue = Array.from({ length: 4 }, () => w.payment(a, b, kobo(100)));
  for (let round = 0; round < 3; round++) {
    for (const t of queue) await w.txs.processOne(a.auth, t);
    for (const t of queue) await w.txs.processOne(b.auth, w.received(t, b));
  }
  assert.equal(w.balance(a), kobo(600));
  assert.equal(w.balance(b), kobo(400));
  assert.equal(w.total(), kobo(1000));
  assert.equal(w.repo._ledger.size, 1 + 8); // 1 funding + 4 debits + 4 credits, each exactly once
  void uuid;
});
