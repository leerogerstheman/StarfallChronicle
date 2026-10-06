'use strict';

/**
 * API client and shared client-side state.
 *
 * The browser is deliberately dumb: it holds one `State` object, sends commands,
 * and re-renders from the view the server returns. No game logic lives here, so
 * there is exactly one implementation of every rule and the client cannot
 * desync from the engine.
 *
 * Every function returns a promise that *rejects* on a failed request, with the
 * server's `reason` attached — the UI shows those reasons as toasts, which is
 * how the player learns why a button is disabled.
 */

/** The single source of client state. Mutated in place; re-rendered on change. */
const State = {
  sessionId: null,
  view: null,
  data: null,
  /** Actor currently choosing an action (a battle view of an ally). */
  activeActor: null,
  /** Pending command waiting for a target to be picked. */
  pendingCommand: null,
  /** The last batch of events, for animation. */
  lastEvents: [],
  battleLogLines: [],
  /** Immutable snapshots for the timeline animation. */
  previousOrder: [],
};

/** Handle to whatever the UI is currently doing, so renders can cancel. */
const Runtime = {
  /** Set while an animation sequence is playing, to block double input. */
  busy: false,
  renderers: {},
};

class ApiError extends Error {
  constructor(message, reason, status) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    // A network failure here is almost always "the server was closed".
    throw new ApiError('无法连接到服务器。请确认 node src/server.js 仍在运行。', 'network', 0);
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(`服务器返回了无效的响应（${res.status}）`, 'badJson', res.status);
    }
  }

  if (!res.ok) {
    const reason = (payload && (payload.reason || payload.error || payload.code)) || `http${res.status}`;
    throw new ApiError(describeReason(reason, payload), reason, res.status);
  }
  return payload || {};
}

/**
 * Turn a machine-readable refusal into something a player can act on.
 *
 * The engine refuses actions with terse codes (`notCharged`, `noSkillPoints`).
 * Showing those raw is the difference between "the game is broken" and "I need
 * one more skill point", so every code the API can emit is mapped here.
 */
function describeReason(reason, payload) {
  const map = {
    noSession: '会话已失效，请刷新页面重新开始。',
    network: '无法连接到服务器。',
    notInBattle: '当前不在战斗中。',
    noActiveAlly: '现在不是我方的回合。',
    notYourTurn: '还没轮到这名角色行动。',
    notCharged: '终结技能量尚未充满。',
    noSkillPoints: '战技点不足，先用普攻积攒。',
    alreadyQueued: '该角色的终结技已经排队。',
    notAnUltimate: '这不是终结技。',
    down: '该角色已倒下。',
    controlled: '该角色被控制，无法行动。',
    silenced: '该角色被封印，无法使用战技或终结技。',
    battleOver: '战斗已经结束了。',
    noEscape: 'Boss 战无法逃跑。',
    cannotFlee: '这场战斗无法逃跑。',
    partyDown: '全队都倒下了，先回城镇旅店休息。',
    partyWiped: '全队阵亡。',
    notAdjacent: '无法直接前往那里。',
    notInTown: '这个功能只能在城镇使用。',
    notEnoughGold: `金币不足（需要 ${payload && payload.need}，现有 ${payload && payload.have}）。`,
    notOwned: '你还没有拥有这件装备。',
    unknownCharacter: '未知角色。',
    unknownItem: '未知道具。',
    noItemId: '没有指定要使用的道具。',
    notInInventory: '背包里已经没有这件道具了。',
    itemBudget: `本场道具已用完（${payload && payload.used}/${payload && payload.limit}）。`,
    unknownEnemy: '未知敌人。',
    tooMany: '出战人数已达上限。',
    emptyParty: '至少需要一名出战角色。',
    notSold: '这里不出售该物品。',
    inBattle: '战斗中无法进行此操作。',
    level: `平均等级不足（需要 ${payload && payload.reason && payload.reason.required}）。`,
    noStory: '没有待处理的剧情。',
    noEncounter: '这里没有遭遇。',
    turnLimit: '战斗超过了回合上限。',
  };
  return map[reason] || `操作被拒绝（${reason}）`;
}

const Api = {
  health: () => request('GET', '/api/health'),

  data: () => request('GET', '/api/data'),

  newSession: (options = {}) => request('POST', '/api/session', options),

  state: (session) => request('GET', `/api/state?session=${encodeURIComponent(session)}`),

  travel: (session, to) => request('POST', '/api/travel', { session, to }),

  enter: (session) => request('POST', '/api/enter', { session }),

  continueStory: (session) => request('POST', '/api/story/continue', { session }),

  setParty: (session, party) => request('POST', '/api/party', { session, party }),

  equip: (session, charId, item) => request('POST', '/api/party/equip', { session, charId, item }),

  rest: (session) => request('POST', '/api/party/rest', { session }),

  buy: (session, item) => request('POST', '/api/shop/buy', { session, item }),

  step: (session) => request('POST', '/api/battle/step', { session }),

  command: (session, cmd) => request('POST', '/api/battle/command', { session, ...cmd }),
  // Items travel in the same envelope as every other command — `{ type:'item',
  // item, target, unit }` — so the API route needed no new field, only a caller.
  item: (session, cmd) => request('POST', '/api/battle/command', { session, ...cmd }),

  ultimate: (session, unit, skill, target) =>
    request('POST', '/api/battle/ultimate', { session, unit, skill, target }),

  acknowledge: (session) => request('POST', '/api/battle/acknowledge', { session }),

  practice: (session, enemies, name) => request('POST', '/api/battle/practice', { session, enemies, name }),
};
