import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { createProjection } from './desk-core.mjs';
import { createCollector } from './desk-collector.mjs';
import { startDesk } from './desk-server.mjs';

const feed = (projection, list) => {
  for (const [source, record, kind, payload] of list) {
    projection.apply({ source, record, kind, payload });
  }
};

const claimStatus = (projection, id) => projection.claimViews().find((view) => view.claim === id);
const objectStatus = (projection, id) => projection.objectViews().find((view) => view.object === id);
const custodyObject = (projection, id) => projection.custodyObjectViews().find((view) => view.object === id);

test('未清点的物件不能报作遗失，相似线索催补清舱资料', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '星形划痕' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '星形划痕' }],
  ]);
  assert.equal(objectStatus(projection, 'P1').status, 'reported');
  const claim = claimStatus(projection, 'C1');
  assert.equal(claim.status, 'candidate');
  assert.equal(claim.claimAt, null);
  const supplements = projection.supplements();
  assert.equal(supplements.length, 1);
  assert.deepEqual(supplements[0].bag, 'BAG-1');
  assert.match(supplements[0].reason, /催补清舱资料/);
});

test('相同描述对应多件时保留待核，私下核验唯一对应才可办理', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕甲' }],
    ['cabin', 'c2', 'find', { leg: 'F1-上', zone: '仓西', object: 'P2', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕乙' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1', 'P2'] }, time: '10:00' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '都对不上' }],
    ['counters', 'k2', 'claim', { claim: 'C2', point: '东岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕乙' }],
  ]);
  assert.equal(claimStatus(projection, 'C1').status, 'pending');
  const c2 = claimStatus(projection, 'C2');
  assert.equal(c2.status, 'claimable');
  assert.equal(c2.claimAt, '西岸');
  assert.deepEqual(c2.verified, ['P2']);
});

test('保留需要保管事实与领取核验相符，且两个柜台不能对同件分别办理', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['cabin', 'c2', 'find', { leg: 'F1-上', zone: '仓西', object: 'P2', bag: 'BAG-2', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['counters', 'k2', 'claim', { claim: 'C2', point: '东岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['counters', 'k3', 'claim', { claim: 'C3', point: '东岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '不符' }],
    ['counters', 'r0', 'reserve', { claim: 'C1', object: 'P2', point: '西岸', expires: '12:00' }],
    ['counters', 'r1', 'reserve', { claim: 'C1', object: 'P1', point: '西岸', expires: '12:00' }],
    ['counters', 'r2', 'reserve', { claim: 'C2', object: 'P1', point: '东岸', expires: '12:00' }],
    ['counters', 'r3', 'reserve', { claim: 'C3', object: 'P1', point: '东岸', expires: '12:00' }],
  ]);
  const c1 = claimStatus(projection, 'C1');
  assert.equal(c1.reserves[0].valid, false);
  assert.match(c1.reserves[0].problems.join(), /无保管事实/);
  assert.equal(c1.reserves[1].valid, true);
  const c2 = claimStatus(projection, 'C2');
  assert.equal(c2.reserves[0].valid, false);
  assert.match(c2.reserves[0].problems.join(), /两个柜台不能对同一物件分别办领取/);
  const c3 = claimStatus(projection, 'C3');
  assert.equal(c3.reserves[0].valid, false);
  assert.match(c3.reserves[0].problems.join(), /私下核验不符/);
  assert.equal(objectStatus(projection, 'P1').status, 'reserved');
});

test('交出确认期间保留到期也不放件；柜台明确未交且实物仍在才可重新办理', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['counters', 'k2', 'claim', { claim: 'C2', point: '东岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['counters', 'r1', 'reserve', { claim: 'C1', object: 'P1', point: '西岸', expires: '10:30' }],
    ['receipt', 'q1', 'receipt', { point: '西岸', claim: 'C1', status: 202, body: { case: 'C1', state: '等待柜台确认' } }],
    ['storage', 's2', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '11:00' }],
    ['counters', 'r2', 'reserve', { claim: 'C2', object: 'P1', point: '东岸', expires: '12:00' }],
  ]);
  assert.equal(objectStatus(projection, 'P1').status, 'handover-pending');
  const c2 = claimStatus(projection, 'C2');
  assert.equal(c2.reserves[0].valid, false);
  assert.equal(c2.status, 'held-by-other');
  feed(projection, [
    ['counters', 'n1', 'notHandedOver', { claim: 'C1', object: 'P1', point: '西岸', time: '11:10' }],
    ['counters', 'r3', 'reserve', { claim: 'C2', object: 'P1', point: '东岸', expires: '12:00' }],
  ]);
  assert.equal(claimStatus(projection, 'C2').reserves[1].valid, true);
  assert.equal(objectStatus(projection, 'P1').status, 'reserved');
});

test('柜台报未交但实物不在保管点时不能重新办理', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['counters', 'n1', 'notHandedOver', { claim: 'C1', object: 'P1', point: '西岸', time: '11:10' }],
  ]);
  assert.equal(projection.overview().inconsistencies.length, 1);
  assert.equal(projection.overview().inconsistencies[0].kind, 'not-handed-over-missing');
});

test('实际交出后保管链终止，后续拆装修订只更正沿革', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['cabin', 'c2', 'split', { receipt: 'FQ1', from: 'BAG-1', to: { P1: 'BAG-2' }, time: '10:30' }],
    ['storage', 's2', 'count', { point: '西岸', inventory: { 'BAG-2': ['P1'] }, time: '10:40' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['counters', 'r1', 'reserve', { claim: 'C1', object: 'P1', point: '西岸', expires: '12:00' }],
    ['storage', 's3', 'released', { receipt: 'GH1', object: 'P1', point: '西岸', claim: 'C1', time: '11:00' }],
    ['cabin', 'c3', 'split', { receipt: 'FQ9', from: 'BAG-1', to: { P1: 'BAG-3' }, time: '10:29', revisionOf: 'FQ1' }],
  ]);
  const object = objectStatus(projection, 'P1');
  assert.equal(object.status, 'released');
  assert.equal(object.released.receipt, 'GH1');
  assert.equal(object.gaps.length, 0);
  assert.ok(object.history.some((entry) => entry.kind === 'split' && entry.receipt === 'FQ9'));
  assert.equal(claimStatus(projection, 'C1').status, 'handed-over');
});

test('一袋两次拆录：无修订关联则待核；有修订冲突则重核且不自动移交', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['cabin', 'c2', 'split', { receipt: 'FQ1', from: 'BAG-1', to: { P1: 'BAG-2' }, time: '10:30' }],
    ['storage', 's2', 'count', { point: '西岸', inventory: { 'BAG-2': ['P1'] }, time: '10:40' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['cabin', 'c3', 'split', { receipt: 'FQ2', from: 'BAG-1', to: { P1: 'BAG-3' }, time: '10:35', revisionOf: 'FQ1' }],
  ]);
  const object = objectStatus(projection, 'P1');
  assert.equal(object.status, 'needs-recheck');
  assert.equal(object.effectiveBag, 'BAG-3');
  assert.equal(object.counted.bag, 'BAG-2');
  assert.ok(object.gaps.some((gap) => gap.kind === 'revision-conflict'));
  assert.equal(claimStatus(projection, 'C1').status, 'needs-recheck');
  const custody = custodyObject(projection, 'P1');
  assert.equal(custody.responsible.kind, '保管点');
  assert.equal(custody.responsible.point, '西岸');

  const ambiguous = createProjection();
  feed(ambiguous, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['cabin', 'c2', 'split', { receipt: 'FQ1', from: 'BAG-1', to: { P1: 'BAG-2' }, time: '10:30' }],
    ['cabin', 'c3', 'split', { receipt: 'FQ2', from: 'BAG-1', to: { P1: 'BAG-3' }, time: '10:31' }],
  ]);
  const gaps = objectStatus(ambiguous, 'P1').gaps;
  assert.ok(gaps.some((gap) => gap.kind === 'ambiguous-split'));
  assert.equal(objectStatus(ambiguous, 'P1').status, 'needs-recheck');
});

test('已领物件确认误交：保留回执交原柜台逐件处理，不回填在库', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '划痕' }],
    ['counters', 'r1', 'reserve', { claim: 'C1', object: 'P1', point: '西岸', expires: '12:00' }],
    ['storage', 's2', 'released', { receipt: 'GH1', object: 'P1', point: '西岸', claim: 'C1', time: '11:00' }],
    ['storage', 's3', 'misdelivered', { object: 'P1', time: '11:30' }],
  ]);
  const object = objectStatus(projection, 'P1');
  assert.equal(object.status, 'released');
  assert.equal(object.released.receipt, 'GH1');
  assert.ok(object.misdelivered);
  const followUps = projection.overview().followUps;
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].point, '西岸');
  assert.equal(followUps[0].object, 'P1');
  assert.equal(custodyObject(projection, 'P1').responsible.misdelivered, true);
});

test('台面公开视图不含私下核验特征', () => {
  const projection = createProjection();
  feed(projection, [
    ['cabin', 'c1', 'find', { leg: 'F1-上', zone: '仓东', object: 'P1', bag: 'BAG-1', type: '耳机盒', color: '灰', feature: '星形划痕' }],
    ['storage', 's1', 'count', { point: '西岸', inventory: { 'BAG-1': ['P1'] }, time: '10:00' }],
    ['counters', 'k1', 'claim', { claim: 'C1', point: '西岸', leg: 'F1-上', type: '耳机盒', publicFields: { color: '灰' }, checked: '星形划痕' }],
  ]);
  const publicViews = projection.publicClaimViews();
  const text = JSON.stringify(publicViews);
  assert.ok(!text.includes('星形划痕'));
  assert.ok(text.includes('灰'));
  assert.equal(publicViews[0].checked, undefined);
  assert.equal(projection.claimViews()[0].checked, '星形划痕');
});

test('双岸场景逐阶段归集：候选、保留、交出、重核', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const projection = createProjection();
  const collector = createCollector({ baseUrl: url, projection });
  const setStage = async (stage) => {
    await fetch(`${url}/control?stage=${stage}`, { method: 'POST' });
    await collector.pollOnce();
  };

  await setStage(1);
  assert.equal(objectStatus(projection, 'P11').status, 'in-custody');
  assert.equal(objectStatus(projection, 'P11').counted.point, '西岸');
  assert.equal(objectStatus(projection, 'P13').status, 'reported');
  assert.equal(claimStatus(projection, 'A7').status, 'claimable');
  assert.equal(claimStatus(projection, 'A7').claimAt, '西岸');
  assert.deepEqual(claimStatus(projection, 'A7').verified, ['P11']);
  assert.equal(claimStatus(projection, 'A8').claimAt, '西岸');
  assert.equal(custodyObject(projection, 'P13').responsible.kind, '清舱');
  assert.equal(projection.supplements().length, 0);

  await setStage(2);
  assert.equal(objectStatus(projection, 'P11').status, 'handover-pending');
  assert.equal(objectStatus(projection, 'P11').effectiveBag, 'BAG-9');
  assert.equal(objectStatus(projection, 'P12').counted.point, '东岸');
  assert.equal(claimStatus(projection, 'A7').status, 'handover-pending');
  assert.equal(claimStatus(projection, 'A7').reserves[0].valid, true);
  assert.equal(claimStatus(projection, 'A8').claimAt, '东岸');
  assert.equal(claimStatus(projection, 'A9').status, 'held-by-other');
  assert.equal(projection.state.receipts.get('西岸|A7').status, 202);

  await setStage(3);
  assert.equal(objectStatus(projection, 'P11').status, 'released');
  assert.equal(objectStatus(projection, 'P11').released.receipt, 'GH1');
  assert.equal(claimStatus(projection, 'A7').status, 'handed-over');
  assert.equal(claimStatus(projection, 'A9').status, 'candidate');
  assert.equal(projection.overview().clock, '12:06');
  assert.equal(projection.state.receipts.get('西岸|A7').status, 200);

  await setStage(4);
  const p12 = objectStatus(projection, 'P12');
  assert.equal(p12.status, 'needs-recheck');
  assert.equal(p12.effectiveBag, 'BAG-11');
  assert.equal(p12.counted.bag, 'BAG-10');
  assert.ok(p12.gaps.some((gap) => gap.kind === 'revision-conflict'));
  assert.ok(p12.gaps.some((gap) => gap.kind === 'awaiting-count'));
  assert.equal(claimStatus(projection, 'A8').status, 'needs-recheck');
  assert.equal(objectStatus(projection, 'P11').status, 'released');
  const bag7 = projection.custodyBagViews().find((bag) => bag.bag === 'BAG-7');
  assert.equal(bag7.doubleSplit, true);
  assert.equal(bag7.splitsOut.find((split) => split.receipt === 'FQ1').supersededBy, 'FQ9');
  const custody12 = custodyObject(projection, 'P12');
  assert.equal(custody12.responsible.kind, '保管点');
  assert.equal(custody12.responsible.point, '东岸');
  assert.equal(projection.overview().inconsistencies.length, 0);
  assert.equal(collector.stats.stage, 4);
});

test('归集服务接口：公开视图、单件登记与封装查询', async (t) => {
  const source = await start();
  t.after(() => new Promise((resolve) => source.server.close(resolve)));
  const desk = await startDesk({ sourceUrl: source.url, poll: false });
  t.after(() => new Promise((resolve) => desk.server.close(resolve)));
  t.after(() => desk.collector.stop());

  const poll = await fetch(`${desk.url}/poll`, { method: 'POST' });
  assert.equal(poll.status, 200);
  const publicClaims = await (await fetch(`${desk.url}/desk/public/claims`)).json();
  assert.ok(Array.isArray(publicClaims));
  const text = JSON.stringify(publicClaims);
  assert.ok(!text.includes('星形划痕') && !text.includes('红色小贴'));
  const one = await fetch(`${desk.url}/desk/claims/A7`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).claimAt, '西岸');
  assert.equal((await fetch(`${desk.url}/desk/claims/ZZ`)).status, 404);
  const bags = await (await fetch(`${desk.url}/custody/bags`)).json();
  assert.ok(bags.find((bag) => bag.bag === 'BAG-7'));
  const objects = await (await fetch(`${desk.url}/custody/objects`)).json();
  assert.ok(objects.find((item) => item.object === 'P13').gaps.some((gap) => gap.kind === 'never-counted'));
});
