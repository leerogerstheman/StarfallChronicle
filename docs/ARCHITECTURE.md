# 架构决策与踩坑记录 / Architecture & Post-mortems

这份文档记两件事：**为什么这样设计**，以及**开发中实际踩过的坑**。

后者尤其重要——每一条都在 `test/run-all.js` 里留了回归测试，
注释里写清了根因。这份文档是那些注释的完整版。

---

## 一、整体结构

### 三层，单向依赖

```
core/     纯数据与纯函数。不知道「战斗」是什么。
  ↓
battle/ + world/     状态机。读 core 的数据，操作 core 的实体。
  ↓
api/     HTTP。每个窗口一个 Game 会话。
  ↓
public/  渲染。零框架、零构建。
  ↑
desktop/ 原生窗口外壳（WinForms + WebView2）。只负责起服务、开窗口、收尾，
         不参与任何游戏逻辑，也不复制任何渲染代码。
  ↑
art/     人物美术生成器。纯函数：spec 进，SVG 字符串出。
         不认识战斗、不认识会话，只认识几何和颜色。
```

**为什么引擎跑在服务端而不是浏览器里？**

三个理由，按重要性排序：

1. **规则只有一份实现。** 如果引擎在客户端，服务端要么不校验（可作弊、可不同步），
   要么把规则实现两遍（必然分叉）。
2. **可以无头测试。** `test/balance.js` 在一秒内跑几十场完整战斗，
   完全不需要浏览器栈。
3. **不需要打包器。** 引擎是 CommonJS 的 Node 代码，直接 `require` 就能测。
   塞进浏览器意味着要么手写一个模块系统，要么引入构建步骤——
   而这个项目的核心承诺是「双击就能玩」。

代价是每次操作一个 HTTP 往返。本地回环上是 1ms 量级。
对一个回合制游戏来说完全无所谓。

### 数据流

```
浏览器                       服务端
  │  POST /api/battle/command
  │ ────────────────────────►
  │                            Game.command()
  │                              → Battle.takeTurn()
  │                                  → executeSkill()
  │                                      → dealDamage()
  │                                          → Battle.log.push(事件)
  │                              → Game._advance()  继续跑到需要输入
  │  ◄────────────────────────  { view, result: { events, actor, state } }
  │
  │  ① 逐条重放 events 播放动画
  │  ② 用 state 覆盖本地状态并重绘
  ↓
```

关键点：**事件用于演出，state 用于真相。**
动画可以因为 `prefers-reduced-motion` 被跳过，可以在慢标签页里延迟，
但最终状态永远来自服务端，所以不可能画错。

---

## 二、核心设计决策

### 决策 1：属性只推导，不缓存

角色的持久状态只有四样：等级、经验、装备 id、已解锁天赋。
所有属性在每次需要时重新推导。

```js
// 存档里没有 maxHp 这个字段
{ charId: 'ayaha', level: 12, exp: 340, equipment: {...}, unlocked: ['talent'] }
```

**好处**：改 `characters.js` 里的基础属性，会立刻正确影响所有已有存档。
调平衡不需要迁移存档。

**代价**：每次请求多构建几十个对象。在这个规模下是微秒级，无关紧要。

**反例（我们避开的）**：把 buff 直接写进 `entity.atk`。
这是「buff 过期了但数值没变回去」这类 bug 的经典来源，也让存档不可信。

### 决策 2：状态实例与状态定义分离

`status.js` 里的是**定义**（`atk_up` 是干什么的）。
实体上挂的是**实例**（谁在什么时候施加的，还剩几回合，几层）。

```js
// 定义
STATUSES.atk_up = { statMods: { atkPct: 0.25 }, stackMode: 'refresh', ... };

// 实例
{ id: 'atk_up', remaining: 2, stacks: 1, sourceUid: 'rinne#2' }
```

属性结算时遍历实例、查定义、求和。所以「两个 +25% 攻击」是 +50% 而不是 +56.25%——
百分比先求和再应用一次。这让叠 buff 可预期，也防止长线战斗里数值失控。

### 决策 3：行动条用绝对值，不用百分比

每个单位有一条行动值，达到 `ACTION_VALUE`（10000）就行动。
每推进一格，所有单位增加等于自身速度的行动值。

```
速度 200 → 50 格行动一次
速度 100 → 100 格行动一次
```

推条减去行动值，拉条加上行动值。因为都是绝对值，推条效果天然可叠加、可预期。
百分比进度条会有取整问题和「推条 25% 到底推了多少」的歧义。

### 决策 4：终极技是「排队」，不是「执行」

星穹铁道最标志性的规则：终结技可以在**任何时刻**插入，包括敌人回合中间。

实现方式是 `pendingUltimates` 队列：

- 玩家调用 `queueUltimate()` 只是把请求放进去，立刻返回
- 主循环在推进行动条**之前**检查队列，有就先结算
- 结算不会消耗回合，也不重置该单位的行动值

因为结算本身是同步、可重入的（只读写实体状态），不需要协程机制。

这条规则的战术价值：把两个角色的终结技攒到同一个击破窗口里连发，
伤害是单发的数倍。这是 demo 里最强的资源。

### 决策 5：技能是声明式效果列表

一个技能就是一段按顺序执行的效果数组：

```js
effects: [
  { type: 'damage', multiplier: 0.70, hits: 3, element: 'wind', toughness: 20 },
  { type: 'status', status: 'spd_up', duration: 2, target: 'allAllies' },
]
```

**顺序是设计的一部分。**「先加攻再打」和「先打再加攻」是两个不同的技能。

18 种效果类型覆盖了 demo 里全部 42 个技能。加技能不用写代码。

### 决策 6：敌人 AI 是纯数据

`ai.js` 只是解释器。所有行为来自 `enemies.js` 里的描述符。

```js
ai: {
  policy: 'boss',
  script: [{ turn: 1, skill: 'boss_ember_slash' }],
  phases: [{ atHpRatio: 0.5, skill: 'boss_phase2', once: true, phaseTo: 2 }],
  finishers: [{ atHpRatio: 0.2, skill: 'boss_lastword', once: true }],
  skillCooldowns: { boss_mark: 3 },
  actionsPerTurn: 2,
  targeting: 'highestAtk',
}
```

加一个新敌人**不需要写任何代码**。

### 决策 7：伤害管线的六步

每一步都有名字，因为「这个数字看起来不对」的第一个问题永远是
「是哪一步的系数」。

```
1. 攻击力 × 技能倍率           → 原始值
2. 等级差缩放（夹在 0.5–2.0）  → 防止等级碾压
3. 防御减免 def/(def+K)        → 永不到 0
4. 属性克制倍率                → 弱点/抵抗/免疫/吸收
5. 攻方增伤 × 守方受伤加成     → buff/debuff
6. 暴击 → 浮动 ±8%             → 最后两步，保证 RNG 抽取顺序稳定
```

第 6 步放在最后是刻意的：只有它和暴击消耗随机数，
放最后可以让「改了别的数值」不影响随机数抽取序列，回放才不会错位。

免疫和吸收会**短路返回，不抽随机数**，同样是为了保持序列一致。

### 决策 8：DoT 用施法瞬间的快照

持续伤害按**施加时**的攻击力计算，之后给施法者加攻不会让已存在的灼烧变强。

这需要三个特例处理：

1. 防御不能算两次（施加时已经「命中」过一次）
2. 等级缩放要用施加时的等级
3. 伤害归属给施加者，所以不能让持有者的暴击率或增益渗进来

这三个如果处理错，症状是「DoT 有时伤害高得离谱」，很难查。

---

## 三、踩坑记录

每一条都是**实际发生过**的 bug。测试都在 `test/run-all.js` 里。

---

### 坑 1：等级成长被应用两次

**症状**：Boss 防御力 562 而不是 244。一场仗打 76 回合。
自动战斗 200 回合都打不完，日志里 Boss 血量几乎不动。

**根因**：

```js
// 错误代码
const stats = {};
for (const key of Object.keys(def.baseStats)) {
  stats[key] = def.baseStats[key] * (1 + GROWTH[key] * (level - 1));  // 已经缩放
}
new Entity({ level, baseStats: stats });   // 实体又会缩放一次
```

`Entity.resolveStats()` 里是 `baseStats[k] * (1 + GROWTH[k] * (level - 1))`。
所以预先缩放过的 `stats` 又被乘了一遍。

**修复**：预先缩放后，把等级对应的成长因子除掉再交给实体。

```js
const entity = new Entity({ level, baseStats: stats });
const factor = 1 + GROWTH[key] * (level - 1);
entity.baseStats[key] = stats[key] / factor;   // → resolveStats 后正好等于 stats
```

这样实体保留了真实的等级（伤害公式要用），属性也正确。

**为什么难查**：属性看起来「只是偏高」，不像坏的。而且角色和敌人**都**中了这个 bug，
所以两边一起被放大，相对关系看起来还正常，只是数值整体偏大。

**回归测试**：「等级成长只被应用一次（角色与敌人）」

---

### 坑 2：治疗技能能给敌人回血

**症状**：Boss 一场仗被治疗了 130,773 点。看起来像「Boss 打不死」。

**根因**：

```js
case 'primary':
  if (!primaryTarget) return [];
  if (!primaryTarget.alive) return [];
  return [primaryTarget];      // ← 完全没检查阵营
```

艾莉丝的治疗技能效果默认目标是 `primary`。如果传入的 uid 是敌人，
它就真的给敌人回血。

**修复**：`primary` 的阵营由**技能本身**决定，不由调用方决定。

```js
function isBeneficialSelector(skill) {
  // 显式声明优先
  if (skill.target === 'ally' || skill.target === 'allyAll' || skill.target === 'self') return true;
  if (['single','aoe','blast','bounce'].includes(skill.target)) return false;
  // 否则看效果：有治疗/护盾/复活就是增益技能
  return (skill.effects || []).some(e =>
    e.type === 'heal' || e.type === 'shield' || e.type === 'cleanse' || e.type === 'revive');
}
```

然后 `primary` 解析到正确的阵营，目标不合法时回退到第一个合法单位。

**为什么难查**：日志里只有一个正数治疗量，看起来像 Boss 自己的技能。
真正让人怀疑人生的是：修这个 bug 之前，我花了一个小时调 Boss 血量。

**回归测试**：「治疗技能永远不会作用于敌人」「伤害技能永远不会作用于队友」
「增益与减益按施法者阵营解析」

---

### 坑 3：Boss 自愈无上限

**症状**：一场仗自愈 172,525 点，而全队总伤害是 172,659。
Boss 血量停在 99%，战斗超时。

**根因**：`boss_mark_of_doom` 回 8% 最大生命，AI 可以无限次选它。
实测一场仗放了 43 次。

**修复**：给 AI 加**技能冷却**机制（`ai.skillCooldowns`），
自愈技能 3 回合冷却。

```js
skillCooldowns: { boss_mark_of_doom: 3 },
```

**教训**：**任何敌人自愈都必须有硬性节奏限制。**
一个能每回合选「给自己回血」的 AI，迟早会真的每回合都选它。

**回归测试**：包含在平衡性测试里——Boss 战回合数上限 80 回合。

---

### 坑 4：召唤没有累计上限

**症状**：一场仗 Boss 召唤了 24 个灰烬残骸。玩家伤害全打在杂兵上，
Boss 血量不动。

**根因**：只限制了**场上同时存在**的数量（`summonCap`），
没限制**整场累计**数量。Boss 每打死一批就再召一批。

还有一个次生 bug：计数时用 `e.id === enemyId` 比较，
但 `_buildEnemies` 生成的 id 是 `${def.id}_${index}`，所以永远不相等，
并发上限其实从来没生效过。

**修复**：两个预算都加。

```js
const livingAdds = this.enemies.filter(e => e.summonedBy === summoner.uid && e.alive);
const roomConcurrent = Math.max(0, cap - livingAdds.length);
const roomLifetime = Math.max(0, totalCap - memory.summonedTotal);
const toSpawn = Math.min(count, roomConcurrent, roomLifetime);
```

**回归测试**：「召唤有并发上限与累计上限」

---

### 坑 5：Boss 阶段缩放会累积

**症状**：Boss 攻击力 397 → 456 → 525 → …，每次阶段检查都涨一次。

**根因**：

```js
for (const key of Object.keys(spec.statScale)) {
  actor.baseStats[key] = actor.baseStats[key] * spec.statScale[key];   // ← 乘在已经乘过的值上
}
```

AI 的阶段触发和脚本处理器在同一回合都会调用一次，
而且没有任何东西阻止它被调用第三次。

**修复**：记录「哪些阶段已经应用过」，系数永远相对**基准值**计算。

```js
actor.scaledPhases = actor.scaledPhases || new Set();
if (!actor.scaledPhases.has(phase)) {
  actor.scaledPhases.add(phase);
  actor.appliedStatScale[key] = (actor.appliedStatScale[key] || 1) * spec.statScale[key];
  const target = actor.phaseBaseline[key] * actor.appliedStatScale[key];
  actor.baseStats[key] = target / growthFactor;   // 反解成长因子
}
```

**教训**：任何「乘上去」的修改都要问一句「这个函数会被调用几次」。

**回归测试**：「Boss 阶段转换的数值缩放不会累积」

---

### 坑 6：事件类型被载荷字段覆盖

**症状**：前端收不到任何 `skill.cast` 事件，战斗日志永远只有伤害数字。

**根因**：

```js
const entry = { seq: ++this.seq, kind: resolved, t: Date.now(), ...data };
```

`kind` 写在前面，载荷展开在后面。而 `skill.cast` 事件的载荷里有一个
`kind: 'skill'` 字段（表示这是战技不是终结技），于是**它覆盖了事件类型**。
所有 cast 事件的 `kind` 都变成了 `'skill'`。

**修复**：两个改动。

```js
// 1. 类型永远赢
const entry = { seq: ++this.seq, ...data, kind: resolved, t: Date.now() };

// 2. 载荷字段改名，别跟事件类型撞
this.log.push(EVENTS.SKILL_CAST, { ..., skillKind: skill.kind, ... });
```

**教训**：一个到处都在用的字段名（`kind`）不要拿来当载荷字段。

**回归测试**：「事件类型不会被载荷字段覆盖」

---

### 坑 7：指令的事件被丢弃

**症状**：战斗日志永远是空的，没有任何伤害数字飘出来。
但状态（血量、战技点）是正确变化的。

**根因**：

```js
command(cmd) {
  const eventsBefore = this.battleLog.entries.length;
  battle.takeTurn(actor, ...);     // ← 这里产生了一堆事件
  return this.step();              // ← 但 step() 重新计算 eventsBefore！
}
```

`step()` 内部又算了一次 `this.battleLog.entries.length`，
这时候 turn 的事件**已经写进去了**，所以起始下标是错的，
返回的事件数组是空的。

**修复**：抽出 `_advance(eventsFrom)`，把起始下标作为参数传进去。

```js
command(cmd) {
  const eventsBefore = this.battleLog.entries.length;
  battle.takeTurn(actor, ...);
  return this._advance(eventsBefore);   // ← 保持事件窗口
}
```

同时 `_finishBattle` 也要从 `log` 里切出最终回合的事件——
击杀的那一下是最有戏剧性的时刻，不能丢。

**教训**：**事件窗口必须由调用方决定，不能由被调用方重新推导。**
只要有两层嵌套调用都记录「从哪开始」，就一定会错。

**回归测试**：「每次指令都会把战斗事件交回客户端」

---

### 坑 8：前端混用两种 view 形状

**症状**：点击战技后，**所有敌人卡片从 DOM 里消失**，无法选择目标。
但服务端的 `pendingCommand.side` 是正确的 `'enemy'`。

**根因**：服务端返回两种长得很像的对象：

```js
view          = { mode, node, party, battle: {...}, ... }   // 游戏 view
result.state  = { mode: 'battle', allies: [...], enemies: [...] }  // 战斗 view
```

前端用 `Object.assign(State.view, result.state)` 把战斗 view 合并进游戏 view，
于是 `State.view.enemies` 变成了 `undefined`（因为战斗数据其实在 `view.battle` 里），
`State.view.mode` 也被覆盖。

然后 `renderField(State.view)` 读 `view.enemies` 得到 undefined，
`swap($('side-enemy'), [])` 就把敌人全清空了。

**修复**：**`State.view` 永远是游戏 view，战斗状态永远写在 `view.battle`。**

```js
if (result.state) {
  State.view = State.view || {};
  State.view.battle = result.state;      // ← 只写这一个槽
}
```

所有渲染函数接受两种形状并自己归一化：

```js
renderField(view) {
  const battle = (view && view.battle) ? view.battle : view;
  ...
}
```

**教训**：两个形状相似但语义不同的对象，不要让它们能互相赋值。

**回归测试**：浏览器测试「战斗界面完整渲染」「点击战技会进入选目标状态」

---

### 坑 9：渲染时把 DOM id 删掉了

**症状**：`document.getElementById('actor-name')` 在第一次渲染后返回 `null`。

**根因**：

```html
<div class="actor-card" id="actor-card">
  <p class="actor-name" id="actor-name">—</p>     <!-- 静态元素，有 id -->
</div>
```

```js
swap($('actor-card'), [                             // ← 替换子节点
  el('div.actor-avatar', ...),
  el('div.actor-info', null, [
    el('div.actor-name', { text: actor.name }),     // ← 新建的，没有 id
  ]),
]);
```

第一次渲染就把带 id 的元素删了。之后任何持有该引用的代码（测试、动画）都拿到 null。

**修复**：渲染器只改**值**，不动结构。

```html
<div class="actor-card" id="actor-card">
  <div class="actor-avatar" id="actor-avatar">?</div>
  <div class="actor-info">
    <p class="actor-name" id="actor-name">—</p>
    <div class="bar bar-hp small"><div class="bar-fill" id="actor-hp"></div></div>
  </div>
</div>
```

```js
$('actor-name').textContent = actor.name;
$('actor-hp').style.width = `${actor.hpRatio * 100}%`;
```

**教训**：**带 id 的元素是接口。** 如果渲染器会替换它，那它就不是接口。

**回归测试**：浏览器测试里的 `actorCard` 断言

---

### 坑 10：战斗结束却卡在 battle 模式

**症状**：战斗打赢了，但界面永远停在战斗画面，所有指令都返回
`{"ok":false,"reason":"notInBattle","mode":"battle"}`。
看起来像游戏卡死。

**根因**：`takeTurn` 里的击杀已经结束了战斗，但会话层没有结算。

```js
battle.takeTurn(actor, ...);   // ← 这里 battle.phase 变成 'won'
return this.step();            // ← step() 检查 this.inBattle，此时已经是 false
                               //    于是返回 notInBattle，永远不结算
```

**修复**：`command()` 在委托之前检查战斗是否已结束。

```js
battle.takeTurn(actor, ...);
if (battle.phase !== PHASE.ACTIVE) {
  return this._finishBattle(eventsBefore);   // 直接结算
}
return this._advance(eventsBefore);
```

并且 `command()` 开头也要处理「上一次 step 就已经结束了但客户端不知道」的情况
（网络抖动、标签页重连）。

**教训**：**状态机的终止条件要在每一个出口检查，不能假设只有主循环会触发。**

**回归测试**：「战斗结束后总能结算，不会卡在 battle 模式」（12 个种子）

---

### 坑 11：`step()` 在战斗结束后还报告「等待输入」

**症状**：和坑 10 相关。`step()` 返回 `waiting: true` 和一个 actor，
但战斗其实已经结束了。

**根因**：`advanceToNextTurn()` 有可能作为副作用结束战斗
（比如一个 DoT 在回合交接前杀死了最后一个敌人）。
这时后面那段「交控制权给玩家」的代码仍然会执行。

**修复**：交接控制权之前再检查一次。

```js
if (unit.side === 'ally') {
  if (battle.phase !== PHASE.ACTIVE) break;   // ← 加这一行
  return { ok: true, waiting: true, actor: ..., state: ... };
}
```

**教训**：在异步/事件驱动的系统里，「我拿到了一个对象」不等于「这个对象还有效」。

---

## 四、测试策略

### 五层，各有各的职责

| 层 | 文件 | 项数 | 能抓到什么 |
|---|---|---|---|
| 引擎自检 | `test/run-all.js` | 59 | 数据引用错误、公式行为、确定性、状态机不变量 |
| HTTP 集成 | `test/integration.js` | 39 | 路由、会话隔离、游戏状态机、通关路径、美术路由 |
| 美术结构 | `test/art.js` | 21 | 覆盖缺口、SVG 合法性、几何出界、设计约束（纯 Node）|
| 平衡性 | `test/balance.js` | 5 场遭遇 × N 次 | 战斗是否可赢、长度是否合理、等级差是否有意义 |
| 原生窗口 | `test/desktop.js` | 8 | 启动器构建、进程生命周期、窗口是否真的存在、关闭是否收干净 |
| 浏览器 | `test/browser.js` | 20 | JS 异常、渲染形状错误、真实交互链路、头像是否真的解码 |

### 美术为什么也要测

美术是生成的几何，所以它和其他引擎代码一样能被断言。但它有个特殊之处：
**作者看不见成品**。几何可以推理，「这到底是不是一个人」推理不出来。
所以这一层拆成两半：`test/art.js` 是纯 Node 的结构闸门，
`tools/art-sheet.js` 在无头浏览器里栅格化后读像素。

后者里最值钱的一项是在 bust 上取固定点验证五官：
头顶必须是头发、双眼必须够暗、脸颊必须是暖肤色、头发与肤色色差必须 ≥ 45。
**包围盒可以完美，而刘海已经长到眼睛上了**——只有采样那几个像素能发现。

详见 [`ART.md`](ART.md)。

### 为什么原生窗口也要有测试

外壳最容易出的错不是「窗口打不开」，而是**关不干净**：
窗口关了，后台的 Node 还在跑，端口被占着，下次启动变成连上一个僵尸服务。
这种 bug 手工测很容易漏——手动关窗口时你会顺手看一眼进程，CI 里不会。

所以 `test/desktop.js` 的窗口层做三件具体的事：

1. **从操作系统读回窗口标题**，而不是相信启动器自己的输出。
   而且中英文两半都要匹配：只匹配 `Starfall` 的话，
   标题里的中文变成乱码也照样"通过"。
2. **用 `taskkill`（不带 `/F`）关闭**，也就是发 `WM_CLOSE`。
   这走的是真正的 `FormClosed` 处理器，而不是把进程从内存里拔掉。
3. **断言后台 Node 进程消失、端口不再响应**，并在 `finally` 里兜底清理。

窗口层依赖 WebView2 运行时，没有时会**报告跳过**（黄色 `-`），
不会混进绿色的通过计数。构建层和 `--selfcheck` 层不依赖图形环境，任何 Windows 上都能跑。

### 为什么要有浏览器层

API 测试**看不到**前端的两类致命问题：

1. **启动时的 JS 异常** —— 页面停在标题屏，控制台全红
2. **某个渲染分支抛异常** —— 画面只画了一半

坑 8 和坑 9 都只有浏览器层能抓到。API 层看到的一切都是正确的。

### 为什么不用 Playwright

项目的核心承诺是「双击就能玩」。一个需要下载 300MB 浏览器的测试工具
会破坏这个承诺。所以 `test/browser.js` 用 Node 内置的 `WebSocket` 和 `fetch`
直接说 Chrome DevTools Protocol——只用了 4 个命令，写一个 60 行的客户端就够了。

没装 Chromium 系浏览器时，测试会**跳过**而不是失败。

### 为什么平衡性测试要报置信区间

60 次采样下，真实的 50% 胜率可能落在 37%–63% 之间。
直接按百分比调数值就是在追噪声。

```
胜率  ████████████████░░░░ 79%  (95% 置信区间 69–86%)
```

测试用区间判断是否达标，`expect.winRate: [0.25, 0.95]` 只要区间和期望有重叠就算通过。

### 调试工具

三个一次性的探针，出事的时候用：

```bash
node test/inspect.js            # 导出实际页面状态（DOM 数量、客户端 state）
node test/inspect.js --boss     # 直接跳到 Boss 战
node test/probe.js              # 采样渲染时序（每次 renderCommands 调用）
node test/interact.js           # 单次交互链路探针（点技能 → 待处理指令 → 目标高亮）
```

`probe.js` 是用来抓「正确的渲染之后跟着一次错误的渲染」这类问题的——
单张快照分不出这两种情况，只有时间线能。

---

## 五、可调数值都在哪

| 想改什么 | 改哪 |
|---|---|
| 伤害公式常数、行动条、成长曲线 | `src/core/rules.js` 的 `BALANCE` |
| 角色基础属性 | `src/core/characters.js` |
| 敌人属性与 AI | `src/core/enemies.js` |
| 技能倍率与效果 | `src/core/skills.js` |
| 状态效果强度 | `src/core/status.js` |
| 装备数值 | `src/core/characters.js` 的 `EQUIPMENT` |
| 地图、遭遇表、商店价格 | `src/core/world-data.js` |
| 战斗节奏（动画间隔） | `public/js/battle.js` 的 `BATTLE_PACING` |
| 配色与主题 | `public/css/style.css` 顶部的自定义属性 |

`BALANCE` 里改 `DEF_CONST` 要谨慎——它是第二大旋钮。
先调敌人血量，实在不行再动它。提高它会加快所有战斗，
但也会让防御装备变得没用。

---

## 六、原生窗口外壳

`desktop/Launcher.cs` 让游戏跑在自己的窗口里，而不是浏览器标签页里。

### 为什么是 WebView2，不是原生控件重写

需求是「不要依赖浏览器打开」。把它理解成「重写界面」是错的方向：

- `public/css/style.css` 约 40KB，是这个项目里最值钱的部分之一：
  自定义属性主题、行动条 grid、伤害数字浮起动画、`prefers-reduced-motion` 降级。
  用 WinForms 控件复刻只会更丑、更慢。
- `test/browser.js` 有 17 项真实浏览器全流程检查。换成原生控件等于把这套测试全废掉。
- 一个 WebView2 宿主保留了**唯一的渲染实现**：同一份 HTML/CSS/JS，同一套测试。

所以窗口是壳，界面还是那一份。这也和本机已接受的 LeebertyGXP 做法一致。

### 就绪检测：轮询端口，不解析 stdout

参考实现里是读子进程输出判断启动完成。这里刻意改了：

> 子进程的 stdout 不是服务端承诺过的契约，监听中的 socket 才是。

`src/server.js` 只在自检全部通过之后才 `listen`。所以「TCP 能连上」严格等价于
「自检通过、可以玩了」，而 stdout 的格式随时可能因为改一句 banner 而失效。

附带好处：本地沙箱里带管道 stdio 起子进程会 EPERM，而 `TcpClient` 不受影响。

### 不接管不属于自己的进程

启动时先探一次端口。如果已经有服务在跑（比如上一次 `start.bat --console` 忘了关），
启动器**直接连上去，不启动也不结束任何进程**。只有自己拉起来的 Node 才会在
窗口关闭时被结束。否则「关个窗口顺手杀掉别人的服务」会变成一个很难查的 bug。

### 构建：用 Windows 自带的编译器

`build-desktop.bat` 调 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，
只引用 `System`、`System.Drawing`、`System.Windows.Forms` 和 vendored 的 WebView2 程序集。
没有 .NET SDK、没有 Visual Studio、没有 NuGet 还原、不需要联网。

WebView2 的托管程序集放在 `desktop/webview2-sdk/` 并提交进仓库，
因为 .NET Framework 的加载器是按程序集名从**应用目录**解析的——
把 DLL 放在 exe 旁边是唯一的加载方式，必须随仓库走。
（`desktop/bin/` 是编译产物，在 `.gitignore` 里；`start.bat` 首次运行会自动构建。）

### 失败也要能玩

三道降级，任何一道都能继续：

| 缺失的东西 | 行为 |
|---|---|
| `desktop/bin` 里的 WebView2 程序集 | 退回默认浏览器 + 对话框说明原因 |
| 本机 WebView2 运行时 | 同上 |
| `csc.exe` | `start.bat` 退回纯 Node 控制台模式，打印地址 |

---

## 七、如果继续做

按价值排序：

1. **存档持久化。** 现在会话在内存里，服务器重启就没了。
   `Game.view()` 已经是完整的可序列化状态，加一层 JSON 落盘就行。
2. **更多技能效果类型。** 现在 18 种。召唤物协同攻击、连携技、地形效果都值得加。
3. **装备强化 / 调合系统。** 炼金工房那条线现在只做了「引爆印记」。
   真正的调合（材料 → 道具 → 战斗中使用）需要 `items.js` 长出一套配方系统。
4. **剧情与对话系统。** 现在 Boss 前有几句台词，NPC 有几句对话。
   做成一个带分支的对话图是另一个数据文件的事。
5. **战斗回放。** 事件流 + 种子已经存下来了，做一个回放查看器成本很低。
6. **多语言。** 所有文本都在数据文件里，抽出来就行。

### 不该做的

- **别把引擎搬到浏览器。** 会失去无头测试能力，而且规则会分叉。
- **别为了「性能」缓存属性。** 现在的规模下无所谓，
  而过期的属性缓存是那种只在负载下才暴露的正确性 bug。
- **别绕过自检。** 每一条检查都对应一个真实踩过的坑。
- **别把窗口外壳换成原生控件重写。** 会丢掉唯一的渲染实现和整套浏览器测试；
  外壳的职责只有「起服务、开窗口、收尾」。
