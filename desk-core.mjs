// 归并清舱终端、两岸保管台与寻物柜台记录的投影核心。
// 只做状态归并与规则推导，不做任何 IO，便于单测与持续收集器复用。
//
// 规则要点：
// - 物件 P 与外袋 BAG 是独立身份；旧袋到新袋的关联只认拆装回执中逐件点交的记录。
// - 保管台盘点只证明列出的物件及保管地点；未清点的物件不能报作遗失、不能办理保留。
// - 找寻登记的私下核验特征（checked）与清舱登记的物件特征（feature）相符，且保管事实成立，
//   才可以为登记人保留一个物件；保留期内两个柜台不能对同一物件分别办领取。
// - 交出分两阶段：柜台先接下申请（回执 202 仍在确认），交件班组确认（回执 200 / released）
//   才算实际交出。等待期间保留即使到期，另一岸也不能就同件发新凭据。
// - 柜台明确未交且实物仍在相应保管点后，才可重新办理。
// - 实际交出后保管链终止，后续整理旧袋资料只能更正此前沿革。
// - 一袋被两次拆录时，凭据只跟到点交记录仍成立的物件；受修订影响的物件由柜台重核，
//   不能仅凭新袋状态自动移交。
// - 已领物件确认误交时，保留交出回执并交原柜台逐件处理，不把物件回填成仍在库。

export const OBJECT_STATUS_TEXT = {
  reported: '清舱已登记，保管台未清点',
  'in-custody': '在库可核对',
  reserved: '已有登记保留',
  'handover-pending': '交出确认中',
  'needs-recheck': '需柜台重核',
  released: '已实际交出',
};

export const CLAIM_STATUS_TEXT = {
  'handed-over': '已实际交出',
  claimable: '可前往保管点领取',
  candidate: '仍在候选',
  pending: '多个可信候选，保留待核',
  'held-by-other': '同件他案办理中，暂不能发凭据',
  'needs-recheck': '需柜台重核',
  'handover-pending': '交出确认中',
  'no-lead': '暂无候选',
};

export function createProjection() {
  const state = {
    events: [],
    seen: new Set(),
    objects: new Map(),
    bags: new Map(),
    claims: new Map(),
    receipts: new Map(),
    followUps: [],
    inconsistencies: [],
    clock: null,
  };

  const getObject = (id) => {
    if (!state.objects.has(id)) {
      state.objects.set(id, {
        id, leg: null, zone: null, type: null, color: null, feature: null,
        foundBag: null, splits: [], counts: [], released: null, misdelivered: null,
        hold: null, history: [],
      });
    }
    return state.objects.get(id);
  };

  const getBag = (id) => {
    if (!state.bags.has(id)) {
      state.bags.set(id, { id, foundObjects: [], splitsOut: [], splitsIn: [], counts: [] });
    }
    return state.bags.get(id);
  };

  const getClaim = (id) => {
    if (!state.claims.has(id)) {
      state.claims.set(id, { id, point: null, leg: null, type: null, publicFields: {}, checked: null, reserves: [] });
    }
    return state.claims.get(id);
  };

  const bumpClock = (time) => {
    if (typeof time === 'string' && (state.clock === null || time > state.clock)) state.clock = time;
  };

  const findSplit = (receiptId) => {
    for (const bag of state.bags.values()) {
      const hit = bag.splitsOut.find((split) => split.receipt === receiptId);
      if (hit) return hit;
    }
    return null;
  };

  // 最近一次盘点（先比时刻，再比到达次序）
  const latestCount = (object) => object.counts.reduce(
    (best, count) => (best === null || count.time > best.time ||
      (count.time === best.time && count.seq > best.seq) ? count : best),
    null,
  );

  // 物件当前所属的封装：以拆装回执逐件点交为准；被修订回执点交过的物件按修订走，
  // 修订未提及的物件仍按原回执。
  const effectiveBag = (object) => {
    let bag = object.foundBag;
    for (const split of object.splits) {
      const superseded = object.splits.some((other) => other.revisionOf === split.receipt);
      if (!superseded) bag = split.to;
    }
    return bag;
  };

  // 需要柜台重核的情形（已交出的物件保管链已终止，不再重核）
  const recheckReasons = (object) => {
    if (object.released) return [];
    const reasons = [];
    const byFrom = new Map();
    for (const split of object.splits) {
      if (!byFrom.has(split.from)) byFrom.set(split.from, []);
      byFrom.get(split.from).push(split);
    }
    for (const [from, list] of byFrom) {
      const receipts = new Set(list.map((split) => split.receipt));
      const linked = list.some((split) => split.revisionOf && receipts.has(split.revisionOf));
      if (receipts.size > 1 && !linked) {
        reasons.push({
          kind: 'ambiguous-split',
          from,
          receipts: [...receipts],
          text: `外袋 ${from} 被两次拆录且回执间无修订关联，点交去向待柜台重核`,
        });
      }
    }
    const revised = object.splits.some((split) => split.revisionOf);
    const last = latestCount(object);
    const bag = effectiveBag(object);
    if (revised && last && bag && last.bag !== bag) {
      reasons.push({
        kind: 'revision-conflict',
        expectedBag: bag,
        countedBag: last.bag,
        point: last.point,
        text: `拆装修订指向 ${bag}，盘点却证实物件在 ${last.point} 的 ${last.bag}，不能仅凭新袋状态自动移交`,
      });
    }
    return reasons;
  };

  // 交接缺口：保管台按封装记录查起时能看到
  const gapsFor = (object) => {
    if (object.released) return [];
    const gaps = [...recheckReasons(object)];
    if (!object.foundBag && (object.counts.length > 0 || object.released)) {
      gaps.push({ kind: 'no-find-record', text: '保管台有记录但清舱未登记该物件' });
    }
    if (object.foundBag && object.counts.length === 0) {
      gaps.push({ kind: 'never-counted', bag: object.foundBag, text: `清舱登记于 ${object.foundBag}，保管台尚未清点` });
    }
    const bag = effectiveBag(object);
    if (object.splits.length > 0 && bag && !object.counts.some((count) => count.bag === bag)) {
      gaps.push({ kind: 'awaiting-count', bag, text: `拆装目标 ${bag} 尚无盘点，交接未闭合` });
    }
    return gaps;
  };

  // 当前有效的持有：交出确认中的持有不因保留到期而释放
  const activeHold = (object) => {
    if (!object.hold || object.released) return null;
    if (object.hold.type === 'handover-pending') return object.hold;
    if (state.clock === null || object.hold.expires > state.clock) return object.hold;
    return null;
  };

  const objectStatus = (object) => {
    if (object.released) return 'released';
    if (recheckReasons(object).length > 0) return 'needs-recheck';
    const hold = activeHold(object);
    if (hold?.type === 'handover-pending') return 'handover-pending';
    if (hold) return 'reserved';
    if (object.counts.length > 0) return 'in-custody';
    return 'reported';
  };

  // 当前责任方：已交出 > 最近盘点的保管点 > 清舱侧
  const responsible = (object) => {
    if (object.released) {
      return {
        kind: '已交出',
        point: object.released.point,
        claim: object.released.claim,
        receipt: object.released.receipt,
        time: object.released.time,
        misdelivered: object.misdelivered !== null,
      };
    }
    const last = latestCount(object);
    if (last) return { kind: '保管点', point: last.point, bag: last.bag, time: last.time };
    return { kind: '清舱', bag: object.foundBag, leg: object.leg, zone: object.zone };
  };

  const handlers = {
    // 清舱终端：发现物件，登记舱位与封装
    'cabin:find': (payload, ref) => {
      const object = getObject(payload.object);
      Object.assign(object, {
        leg: payload.leg, zone: payload.zone, type: payload.type,
        color: payload.color, feature: payload.feature, foundBag: payload.bag,
      });
      const bag = getBag(payload.bag);
      if (!bag.foundObjects.includes(payload.object)) bag.foundObjects.push(payload.object);
      object.history.push({ kind: 'find', bag: payload.bag, leg: payload.leg, zone: payload.zone, record: ref });
    },
    // 清舱终端：拆装回执，逐件点交；revisionOf 表示对既往回执的修订
    'cabin:split': (payload, ref) => {
      bumpClock(payload.time);
      const from = getBag(payload.from);
      const receipt = {
        receipt: payload.receipt, from: payload.from, to: { ...payload.to },
        time: payload.time, revisionOf: payload.revisionOf ?? null, supersededBy: null, record: ref,
      };
      from.splitsOut.push(receipt);
      if (payload.revisionOf) {
        const revised = findSplit(payload.revisionOf);
        if (revised) revised.supersededBy = payload.receipt;
      }
      for (const [objectId, to] of Object.entries(payload.to)) {
        const object = getObject(objectId);
        object.splits.push({ receipt: payload.receipt, from: payload.from, to, time: payload.time, revisionOf: payload.revisionOf ?? null });
        getBag(to).splitsIn.push({ receipt: payload.receipt, from: payload.from, object: objectId, time: payload.time });
        object.history.push({ kind: 'split', receipt: payload.receipt, from: payload.from, to, time: payload.time, revisionOf: payload.revisionOf ?? null });
      }
    },
    // 保管台：盘点只证明列出的物件及保管地点
    'storage:count': (payload, ref) => {
      bumpClock(payload.time);
      for (const [bagId, objectIds] of Object.entries(payload.inventory)) {
        const bag = getBag(bagId);
        bag.counts.push({ point: payload.point, objects: [...objectIds], time: payload.time, record: ref });
        for (const objectId of objectIds) {
          const object = getObject(objectId);
          object.counts.push({ point: payload.point, bag: bagId, time: payload.time, seq: state.events.length, record: ref });
          object.history.push({ kind: 'count', point: payload.point, bag: bagId, time: payload.time });
        }
      }
    },
    // 保管台：实物离库，该编号不再可领，保管链终止
    'storage:released': (payload, ref) => {
      bumpClock(payload.time);
      const object = getObject(payload.object);
      const incoming = { receipt: payload.receipt, object: payload.object, point: payload.point, claim: payload.claim, time: payload.time };
      if (object.released) {
        if (object.released.receipt !== payload.receipt) {
          state.inconsistencies.push({ kind: 'released-conflict', object: payload.object, have: object.released, got: incoming });
        }
      } else {
        object.released = incoming;
      }
      if (object.hold) {
        if (object.hold.claim !== payload.claim) {
          state.inconsistencies.push({ kind: 'released-while-held', object: payload.object, hold: object.hold, released: incoming });
        }
        object.hold = null;
      }
      object.history.push({ kind: 'released', ...incoming });
    },
    // 寻物柜台：找寻登记（票面乘船段、物件类别、私下核验特征）
    'counters:claim': (payload) => {
      const claim = getClaim(payload.claim);
      Object.assign(claim, {
        point: payload.point, leg: payload.leg, type: payload.type,
        publicFields: { ...payload.publicFields }, checked: payload.checked,
      });
    },
    // 寻物柜台：为登记人保留物件。只有保管事实与领取核验相符才成立。
    'counters:reserve': (payload, ref) => {
      const claim = getClaim(payload.claim);
      const object = state.objects.get(payload.object);
      const problems = [];
      if (!object || !object.foundBag) {
        problems.push('清舱未登记该物件');
      } else {
        if (object.counts.length === 0) problems.push('保管台未清点，无保管事实');
        if (object.released) problems.push('物件已交出');
        if (recheckReasons(object).length > 0) problems.push('物件需重核');
        if (claim.checked == null || claim.checked !== object.feature) problems.push('私下核验不符');
        const hold = activeHold(object);
        if (hold && hold.claim !== payload.claim) problems.push(`他案办理中(${hold.claim})，两个柜台不能对同一物件分别办领取`);
      }
      const valid = problems.length === 0;
      claim.reserves.push({ object: payload.object, point: payload.point, expires: payload.expires, valid, problems, record: ref });
      if (valid) {
        object.hold = { type: 'reserved', claim: payload.claim, point: payload.point, expires: payload.expires, record: ref };
      }
    },
    // 柜台交出回执：202 仍在确认，200 已确认，404 仅表示该柜台当前无回执
    'receipt:receipt': (payload) => {
      state.receipts.set(`${payload.point}|${payload.claim}`, { status: payload.status, body: payload.body });
      if (payload.status === 200 && payload.body) {
        bumpClock(payload.body.time);
        const object = getObject(payload.body.object);
        const incoming = {
          receipt: payload.body.receipt, object: payload.body.object,
          point: payload.body.point, claim: payload.body.claim, time: payload.body.time,
        };
        if (object.released) {
          if (object.released.receipt !== incoming.receipt || object.released.claim !== incoming.claim) {
            state.inconsistencies.push({ kind: 'receipt-conflict', object: object.id, have: object.released, got: incoming });
          }
        } else {
          object.released = incoming;
        }
        if (object.hold && object.hold.claim === incoming.claim) object.hold = null;
        object.history.push({ kind: 'receipt', ...incoming });
      } else if (payload.status === 202) {
        for (const object of state.objects.values()) {
          if (!object.released && object.hold && object.hold.type === 'reserved' &&
            object.hold.claim === payload.claim && object.hold.point === payload.point) {
            object.hold = { ...object.hold, type: 'handover-pending' };
            object.history.push({ kind: 'handover-pending', point: payload.point, claim: payload.claim });
          }
        }
      }
    },
    // 柜台明确未交：实物仍在相应保管点后才可重新办理
    'counters:notHandedOver': (payload) => {
      bumpClock(payload.time);
      const object = state.objects.get(payload.object);
      if (!object) {
        state.inconsistencies.push({ kind: 'not-handed-over-unknown', object: payload.object, claim: payload.claim });
        return;
      }
      if (object.released) {
        state.inconsistencies.push({ kind: 'not-handed-over-after-release', object: payload.object, receipt: object.released });
        return;
      }
      if (object.counts.length === 0) {
        state.inconsistencies.push({ kind: 'not-handed-over-missing', object: payload.object, text: '柜台报未交，但实物不在任何保管点，不能重新办理' });
        return;
      }
      object.hold = null;
      object.history.push({ kind: 'not-handed-over', point: payload.point, claim: payload.claim, time: payload.time });
    },
    // 已领物件确认误交：保留交出回执，交原柜台逐件处理，不回填成仍在库
    misdelivered: (payload, ref) => {
      bumpClock(payload.time);
      const object = getObject(payload.object);
      object.misdelivered = {
        receipt: payload.receipt ?? object.released?.receipt ?? null,
        claim: payload.claim ?? object.released?.claim ?? null,
        point: payload.point ?? object.released?.point ?? null,
        time: payload.time ?? null,
        record: ref,
      };
      state.followUps.push({
        point: object.released?.point ?? payload.point ?? null,
        object: object.id,
        claim: object.released?.claim ?? payload.claim ?? null,
        receipt: object.released?.receipt ?? payload.receipt ?? null,
        reason: '已领物件确认误交，原柜台逐件处理',
      });
      object.history.push({ kind: 'misdelivered', receipt: object.misdelivered.receipt, time: payload.time ?? null });
    },
  };

  const apply = (event) => {
    const { source, record, kind, payload } = event;
    const key = `${source}:${record}`;
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    state.events.push({ source, record, kind, payload });
    const handler = handlers[`${source}:${kind}`] ?? handlers[kind];
    if (handler) handler(payload, key);
    return true;
  };

  const matchesPublic = (object, claim) =>
    object.leg === claim.leg && object.type === claim.type &&
    Object.entries(claim.publicFields ?? {}).every(([field, value]) => object[field] === value);

  const objectView = (object) => {
    const last = latestCount(object);
    const status = objectStatus(object);
    const hold = activeHold(object);
    return {
      object: object.id,
      type: object.type,
      color: object.color,
      leg: object.leg,
      zone: object.zone,
      feature: object.feature,
      status,
      statusText: OBJECT_STATUS_TEXT[status],
      foundBag: object.foundBag,
      effectiveBag: effectiveBag(object),
      counted: last ? { point: last.point, bag: last.bag, time: last.time } : null,
      hold: hold ? { ...hold } : null,
      released: object.released,
      misdelivered: object.misdelivered,
      gaps: gapsFor(object),
      history: object.history,
    };
  };

  const claimView = (claim, internal) => {
    const registered = [...state.objects.values()].filter((object) => object.foundBag);
    const matched = registered.filter((object) => matchesPublic(object, claim));
    const open = matched.filter((object) => !object.released);
    const closed = matched.filter((object) => object.released);
    const verified = open.filter((object) =>
      object.feature != null && claim.checked != null && object.feature === claim.checked);
    const mine = closed.filter((object) => object.released.claim === claim.id);
    const holds = [...state.objects.values()].filter((object) => activeHold(object)?.claim === claim.id);

    let status;
    let claimAt = null;
    const notes = [];
    if (mine.length > 0) {
      status = 'handed-over';
    } else if (holds.length > 0) {
      const object = holds[0];
      if (objectStatus(object) === 'needs-recheck') {
        status = 'needs-recheck';
      } else if (object.hold.type === 'handover-pending') {
        status = 'handover-pending';
        notes.push('交件班组确认中；等待期间保留即使到期，他案也不能就同件发新凭据');
      } else {
        status = 'claimable';
        claimAt = latestCount(object)?.point ?? null;
        notes.push(`已保留至 ${object.hold.expires}`);
      }
    } else if (verified.length === 1) {
      const object = verified[0];
      if (objectStatus(object) === 'needs-recheck') {
        status = 'needs-recheck';
      } else {
        const hold = activeHold(object);
        if (hold && hold.claim !== claim.id) {
          status = 'held-by-other';
          notes.push('同件他案办理中；只能继续核对自己的登记，不能就同件发新凭据');
        } else if (object.counts.length > 0) {
          status = 'claimable';
          claimAt = latestCount(object).point;
        } else {
          status = 'candidate';
          notes.push('候选尚未经保管台清点，已催补清舱资料');
        }
      }
    } else if (open.length > 1) {
      status = 'pending';
      notes.push('相同描述对应多件，保留待核');
    } else if (open.length === 1) {
      status = 'candidate';
      notes.push('私下核验特征未对应，继续核对');
    } else {
      status = 'no-lead';
    }

    const view = {
      claim: claim.id,
      point: claim.point,
      leg: claim.leg,
      type: claim.type,
      publicFields: claim.publicFields,
      status,
      statusText: CLAIM_STATUS_TEXT[status],
      claimAt,
      candidates: open.map((object) => {
        const hold = activeHold(object);
        const last = latestCount(object);
        return {
          object: object.id,
          point: last?.point ?? null,
          status: objectStatus(object),
          heldByOther: hold !== null && hold.claim !== claim.id,
        };
      }),
      closed: closed.map((object) => {
        const own = object.released.claim === claim.id;
        return own
          ? { object: object.id, own, receipt: object.released.receipt, point: object.released.point, time: object.released.time }
          : { object: object.id, own };
      }),
      notes,
    };
    if (internal) {
      view.checked = claim.checked;
      view.verified = verified.map((object) => object.id);
      view.reserves = claim.reserves;
    }
    return view;
  };

  const byId = (a, b) => (a.object ?? a.claim ?? a.bag).localeCompare(b.object ?? b.claim ?? b.bag);

  return {
    state,
    apply,
    // 需要追问答出回执的（保管点, 登记）组合：来自有效保留
    receiptQueries: () => {
      const queries = new Map();
      for (const claim of state.claims.values()) {
        for (const reserve of claim.reserves) {
          if (reserve.valid) queries.set(`${reserve.point}|${claim.id}`, { point: reserve.point, claim: claim.id });
        }
      }
      return [...queries.values()];
    },
    objectViews: () => [...state.objects.values()].map(objectView).sort(byId),
    claimViews: () => [...state.claims.values()].map((claim) => claimView(claim, true)).sort(byId),
    publicClaimViews: () => [...state.claims.values()].map((claim) => claimView(claim, false)).sort(byId),
    // 相似线索催补清舱资料：候选物件缺少保管事实时列出
    supplements: () => {
      const list = [];
      for (const claim of state.claims.values()) {
        const candidates = [...state.objects.values()].filter((object) =>
          object.foundBag && !object.released && matchesPublic(object, claim));
        for (const object of candidates) {
          if (object.counts.length === 0) {
            list.push({
              claim: claim.id, object: object.id, bag: effectiveBag(object),
              leg: object.leg, zone: object.zone,
              reason: '清舱已登记但保管台未清点，催补清舱资料',
            });
          } else if (object.splits.length > 0 && !object.counts.some((count) => count.bag === effectiveBag(object))) {
            list.push({
              claim: claim.id, object: object.id, bag: effectiveBag(object),
              leg: object.leg, zone: object.zone,
              reason: '拆装目标袋尚未经保管台清点，催补清舱资料',
            });
          }
        }
      }
      return list;
    },
    custodyObjectViews: () => [...state.objects.values()].map((object) => ({
      object: object.id,
      status: objectStatus(object),
      statusText: OBJECT_STATUS_TEXT[objectStatus(object)],
      foundBag: object.foundBag,
      effectiveBag: effectiveBag(object),
      counted: latestCount(object),
      responsible: responsible(object),
      gaps: gapsFor(object),
      released: object.released,
      misdelivered: object.misdelivered,
      history: object.history,
    })).sort(byId),
    // 保管台按封装记录查起：每袋的沿革、每件当前的责任方和交接缺口
    custodyBagViews: () => [...state.bags.values()].map((bag) => ({
      bag: bag.id,
      foundObjects: [...bag.foundObjects],
      splitsOut: bag.splitsOut.map((split) => ({
        receipt: split.receipt, to: split.to, time: split.time,
        revisionOf: split.revisionOf, supersededBy: split.supersededBy,
      })),
      splitsIn: [...bag.splitsIn],
      counts: [...bag.counts],
      doubleSplit: bag.splitsOut.length > 1,
      items: [...state.objects.values()]
        .filter((object) => object.foundBag === bag.id ||
          object.splits.some((split) => split.from === bag.id || split.to === bag.id) ||
          object.counts.some((count) => count.bag === bag.id))
        .map((object) => ({ object: object.id, responsible: responsible(object), gaps: gapsFor(object) }))
        .sort(byId),
    })).sort(byId),
    overview: () => ({
      clock: state.clock,
      events: state.events.length,
      objects: state.objects.size,
      bags: state.bags.size,
      claims: state.claims.size,
      followUps: state.followUps,
      inconsistencies: state.inconsistencies,
    }),
  };
}
