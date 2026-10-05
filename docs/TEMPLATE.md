# 模板使用指南 / Template Guide

这份文档回答一个问题：**想加东西，改哪里？**

全部改动都在数据文件里。只有两种例外需要碰代码，都在文末单独说明。

---

## 目录

1. [加一个新角色](#一加一个新角色)
2. [加一个新角色的立绘](#一之二加一个新角色的立绘)
3. [加一个新技能](#二加一个新技能)
4. [效果类型速查表](#三效果类型速查表)
5. [目标选择器速查表](#四目标选择器速查表)
6. [加一种新状态](#五加一种新状态)
7. [加一个新敌人](#六加一个新敌人)
8. [加一场 Boss 战](#七加一场-boss-战)
9. [加一个地图节点](#八加一个地图节点)
10. [加一件装备 / 道具](#九加一件装备--道具)
11. [调平衡](#十调平衡)
12. [什么时候必须写代码](#十一什么时候必须写代码)

---

## 一、加一个新角色

**文件：`src/core/characters.js`**

```js
defineCharacter({
  id: 'shion',                    // 唯一 id，全小写
  name: '紫苑',
  en: 'Shion',
  title: '寂静的弓手',
  element: 'quantum',             // 决定默认属性和 UI 配色
  role: 'attacker',               // 自由文本，只用于 UI 显示
  rarity: 5,
  color: '#8b7cf6',               // UI 主色
  sprite: 'shion',                // UI 用的标识（当前版本渲染首字）
  lore: '角色简介，会显示在队伍界面。',

  // level 1 的基础属性。成长曲线会自动按等级放大，
  // 所以这里写的是 1 级数值，不是满级数值。
  baseStats: {
    maxHp: 1100, atk: 190, def: 80, spd: 105,
    critRate: 0.10, critDmg: 1.55,
    effectHit: 0.10, effectRes: 0.05,
    maxEnergy: 120, break: 1.0,
  },

  // 技能槽位。basic / skill / ultimate 三个是必需的。
  skills: {
    basic: 'shion_basic',
    skill: 'shion_skill',
    ultimate: 'shion_ult',
    talent: 'shion_talent',       // 可选
  },

  // 需要代码的天赋钩子（可选）。见第十一节。
  hooks: [{ on: 'break', handler: 'shionTalentOnBreak' }],

  // 等级解锁表（可选）
  unlock: { 1: ['shion_talent'] },
});
```

### 别忘了三件事

**1. 加进世界名册**

`src/core/world-data.js`：

```js
roster: ['ayaha', 'rinne', 'rin', 'byakuya', 'elise', 'shion'],
```

**2. 给它一个默认装备方案（可选）**

`src/core/characters.js` 底部的 `DEFAULT_LOADOUT`：

```js
DEFAULT_LOADOUT: {
  shion: { weapon: 'gear_wind_blade', boots: 'gear_swift_boots', accessory: null },
}
```

不写也能用，只是开局不带装备。

**3. 给它一张立绘**

美术是必需项，不是可选项：`test/art.js` 会断言每个可操控角色都有 spec，
缺了会直接失败。见 [加一个新角色的立绘](#加一个新角色的立绘)。

**4. 跑一遍自检**

```bash
npm run selftest
npm run art
```

自检会检查：技能 id 是否存在、每个角色是否有 basic/skill/ultimate 三个槽位、
钩子处理器是否注册过。**打错字会立刻报错**，不会静默失效。

---

## 一之二、加一个新角色的立绘

**文件：`src/art/specs/characters.js`**

立绘是**代码生成的**，不是画好存起来的图片。一个角色只需要一条 spec：

```js
shion: {
  pose: 'ready',                       // stand / ready / cast / hip / guard / reach / cross
  scale: 0.99,                         // 身高，以地面为锚点缩放；不要和已有角色重复
  skin: 'light',                       // porcelain / light / warm / tan / deep
  eye: '#ff9de2',
  hair: { style: 'ayaha', base: '#8a6fd4', shadow: '#5a4694' },
  costume: shionCostume,               // 一个返回 { back, mid, boots, hands } 的函数
  weapon: 'sabre',                     // sabre / spear / orb / staff / satchel，或 null
  gear: { steel: '#e4edf7', grip: '#2b3448' },
},
```

名字、称号、属性、元素**不写在这里**——它们从 `src/core/characters.js` 读，
所以改数据文件里的名字，立绘上的名字跟着变。

### 写 costume 函数

服装用 `src/art/outfits.js` 的共享零件拼。**比例是共享的，剪影是自己的**：

```js
function shionCostume(pose) {
  const coat = '#3a2f5e';
  return {
    // 在身体后面：披风、后摆
    back: cape(pose, { fill: shade(coat, -0.3), spread: 110, length: 460, split: true }),
    // 盖在躯干上：外套、袖子、领子、腰带、护肩
    mid: [
      draw(skirt(pose, { fromY: 450, fromHalf: 78, toY: 700, toHalf: 112,
        points: pointsHem(112, 700, [20, 6, 24]) }), coat),
      draw(garment(pose, { hemY: 500, hemHalf: 96, shoulderHalf: 82, neckDrop: 30,
        hem: pointsHem(96, 500, [12, 3, 14]) }), coat),
      sleeve(pose, 'L', { fill: coat, to: 'wrist', cuff: '#e8cd7c', pad: 10 }),
      sleeve(pose, 'R', { fill: coat, to: 'wrist', cuff: '#e8cd7c', pad: 10 }),
      collarHigh(pose, { fill: '#e8cd7c', height: 70, spread: 36 }),
      belt(pose, { fill: '#4a3524', buckle: '#c8a44a', y: 446, half: 72 }),
    ].join(''),
    // 靴子在衣服**之前**画：长下摆要盖住靴口
    boots: [
      boot(pose, 'L', { fill: '#241f18', topY: 690, cuff: '#8c93a8', sole: '#14110d' }),
      boot(pose, 'R', { fill: '#241f18', topY: 690, cuff: '#8c93a8', sole: '#14110d' }),
    ].join(''),
    // 手套在**手之后**画
    hands: glove(pose, 'L', { fill: '#4a3524', length: 0.4 })
          + glove(pose, 'R', { fill: '#4a3524', length: 0.4 }),
  };
}
```

**所有下摆的点列表都是从左到右写的**（`garment` 和 `skirt` 内部会按需要反转）。
写反了会得到一个蝴蝶结，而且在源码里看不出来。

### 三件必须做的事

1. **姿势和身高不能和已有角色重复。** `test/art.js` 会报错。
   七个姿势、身高 0.95–1.04，就是为了让五个角色站在一起不像克隆人。
2. **顶部留够余量。** 身高是**以地面为锚点**缩放的，所以 1.04 的角色，
   头发在 y = 26 的位置会落到 y = -5——出画布。`test/art.js` 要求顶部余量 ≥ 14 单位。
   `node tools/render-art.js --bounds` 会告诉你**是哪一层**出了画布。
3. **头发和皮肤要有色差。** 差值小于 45 时刘海会和额头糊成一块。
   `node tools/art-sheet.js` 会在 bust 上取样并报出来。

### 看结果

```bash
npm run art          # 21 项结构自检
npm run art:sheet    # 生成 docs/art-sheet.png 并逐张测量像素
npm run art:render   # 把每张 SVG 导到临时目录，可以直接用浏览器打开
```

加敌人见 `src/art/specs/enemies.js`（用 `blob` / `plate` / `spike` / `eye` 四块积木），
加 NPC 见 `src/art/specs/npcs.js`。完整的系统说明在 [`ART.md`](ART.md)。

---

## 二、加一个新技能

**文件：`src/core/skills.js`**

一个技能就是一段声明式的效果列表。引擎按顺序执行。

```js
define({
  id: 'shion_skill',
  name: '虚空箭雨',
  icon: '🏹',
  kind: 'skill',              // basic | skill | ultimate | talent | technique
  element: 'quantum',
  target: 'aoe',              // 见第四节
  toughness: 60,              // 削韧值（总削韧）
  skillPointCost: 1,          // 战技消耗 1 点
  energyGain: 30,             // 回能
  desc: '对全体敌人造成 140% 攻击力的量子伤害，并使其承受伤害提升 20%（2 回合）。',

  effects: [
    { type: 'damage', multiplier: 1.40, element: 'quantum', toughness: 60 },
    { type: 'status', status: 'damage_taken_up', duration: 2, chance: 0.9 },
  ],
});
```

### 效果列表是按顺序执行的

顺序**是设计的一部分**：

```js
// 「先加攻再打」和「先打再加攻」是两个不同的技能
effects: [
  { type: 'status', status: 'atk_up', duration: 3, target: 'self' },
  { type: 'damage', multiplier: 2.0 },        // 会吃到攻up
]
```

```js
effects: [
  { type: 'damage', multiplier: 2.0 },        // 吃不到攻up
  { type: 'status', status: 'atk_up', duration: 3, target: 'self' },
]
```

### 多段攻击

```js
effects: [
  // 打 3 次，每次 70%；只有第一段削韧 20
  { type: 'damage', multiplier: 0.70, hits: 3, element: 'wind', toughness: 20 },
]
```

### 条件增伤

```js
effects: [
  {
    type: 'damage',
    multiplier: 2.4,
    element: 'ice',
    // 目标身上有「冻结」时伤害 ×1.5
    bonusVsStatus: { status: 'freeze', mult: 1.5 },
  },
]
```

### 用技能级字段做全局缩放

```js
define({
  id: 'byakuya_ult',
  // 目标每有一层减益，伤害提升 12%，最多 60%
  scalingPerDebuff: { per: 0.12, cap: 0.60 },
  effects: [{ type: 'damage', multiplier: 4.2, element: 'lightning' }],
});
```

---

## 三、效果类型速查表

| `type` | 关键字段 | 说明 |
|---|---|---|
| `damage` | `multiplier`, `element`, `hits`, `toughness`, `ratio`, `flatBonus`, `bonusVsStatus`, `status`, `statuses` | 伤害。`toughness` 只对第一段生效 |
| `heal` | `ratio`, `flat`, `mode`(`ratio`\|`maxHp`\|`flat`) | 治疗。`ratio` 模式按施术者攻击力算 |
| `shield` | `ratio`, `duration` | 护盾，按施术者攻击力换算成伤害吸收量 |
| `status` | `status`, `duration`, `stacks`, `chance` | 施加状态 |
| `cleanse` | — | 移除目标的全部减益 |
| `dispel` | — | 移除目标的全部增益 |
| `energy` | `amount` | 回能（默认目标为自己） |
| `skillPoint` | `amount` | 正数回复，负数消耗 |
| `delay` | `amount` | 推条。`≤1` 视为比例（0.25 = 25% 行动条），`>1` 视为绝对值 |
| `advance` | `amount` | 拉条，规则同上 |
| `extraTurn` | `count` | 额外行动 |
| `revive` | `hpRatio` | 复活倒下的单位 |
| `summon` | `enemy`, `count` | 召唤敌人 |
| `toughness` | `amount` | 直接削韧（不造成伤害） |
| `breakInstantly` | — | 直接击破 |
| `detonate` | `status`, `ratio` | 引爆状态层数造成伤害（炼金工房风格） |
| `consumeStatus` | `status`, `maxStacks` | 消耗自身状态层数，供后续效果缩放 |
| `script` | `handler` | 调用命名脚本处理器 |

### 效果的通用字段

所有效果都支持：

```js
{
  type: '...',
  target: 'allAllies',     // 覆盖默认目标（见下节）
  chance: 0.8,             // 仅 status：基础命中率
  duration: 2,             // 仅 status/shield
  stacks: 2,               // 仅 status
}
```

---

## 四、目标选择器速查表

`effect.target` 可用值：

| 选择器 | 含义 |
|---|---|
| `primary` | 玩家选中的那个单位 |
| `self` | 施术者 |
| `allEnemies` | 施术者的全部敌人 |
| `allAllies` | 施术者的全部队友 |
| `allAlliesExceptSelf` | 队友（不含自己） |
| `allEnemiesExceptPrimary` | 主目标周围的敌人（用于 blast 波及） |
| `randomEnemy` | 随机敌人。配合 `hits` 就是弹幕 |
| `lowestHpAlly` | 生命比例最低的队友 |
| `marked` | 带指定标记的敌人（技能需声明 `markStatus`） |
| `downed` | 已倒下的单位 |

### 关于 `primary` 的阵营安全

`primary` 的阵营由**技能本身**决定，不由调用方决定：

- 技能有治疗/护盾/复活效果，或 `target` 是 `ally`/`allyAll`/`self` → 解析到**己方**
- 否则 → 解析到**敌方**

如果传入的目标在错误的一侧，会自动回退到第一个合法单位。

> 这条规则是踩坑换来的：早期版本直接返回传入的 uid，导致指向敌人的治疗技能
> 真的给 Boss 回了 13 万血。回归测试在 `test/run-all.js` 的
> 「治疗技能永远不会作用于敌人」。

---

## 五、加一种新状态

**文件：`src/core/status.js`**

```js
STATUSES.poison_heavy = {
  id: 'poison_heavy',
  name: '剧毒',
  icon: '☠',
  kind: 'dot',                       // buff|debuff|dot|hot|control|special
  element: 'wind',
  stackMode: 'stack',                // refresh|stack|strongest|instance
  maxStacks: 5,
  defaultDuration: 3,
  dotRatioMaxHp: 0.05,               // 每回合按目标最大生命 5% 掉血
  desc: '每回合受到最大生命 5% 的持续伤害，最多 5 层',
};
```

### 状态能声明什么

| 字段 | 作用 |
|---|---|
| `statMods` | 属性修改。`atkPct: 0.25` = 攻击力 +25%；`def: 30` = 防御 +30 |
| `damageDealtPct` | 造成的伤害增减 |
| `damageTakenPct` | 受到的伤害增减 |
| `vsBrokenDamagePct` | 只对已击破目标生效的增伤 |
| `toughnessTakenMult` | 削韧倍率。`0.5` = 更难击破，`1.6` = 更易击破 |
| `dotRatio` / `dotRatioMaxHp` | 持续伤害（前者按施法者攻击力，后者按目标最大生命） |
| `healPct` | 每回合回复最大生命的比例 |
| `shield: true` | 是护盾，`value` 是吸收量 |
| `skipsTurn: true` | 跳过行动（冻结/眩晕） |
| `blocksSkill` / `blocksUltimate` | 封印战技 / 终结技 |
| `confuseChance` | 概率攻击自己 |
| `surviveLethal: true` | 致命伤保留 1 血 |
| `autoRevivePct` | 倒下时自动复活并回复该比例生命 |
| `reflectRatio` | 反射伤害比例 |
| `forcesAggro: true` | 强制敌人以自己为目标（嘲讽） |
| `untargetable: true` | 不会被单体技能选中 |
| `delayOnApply` / `delayOnTick` | 施加时 / 每回合推动行动条 |
| `energyPerStack` / `energyOnTurnStart` | 回能 |

### 状态叠加模式

| 模式 | 行为 | 用在 |
|---|---|---|
| `refresh` | 保持最强的一份，刷新持续时间 | 大多数增益/减益 |
| `stack` | 叠层，效果按层数放大 | 灼烧、流血、印记 |
| `strongest` | 只保留最强的一份，弱的重放无效 | 护盾强度类 |
| `instance` | 独立实例共存 | 多层护盾 |

### 持续伤害的两个重要细节

1. **DoT 按施法瞬间的攻击力快照计算。** 之后给施法者加攻不会让已存在的灼烧变强。
   这是轨迹/Persona 的惯例，也让伤害可预期。
2. **DoT 每回合在目标自己回合开始时结算。** 所以第 3 回合上的毒，第 4 回合才第一次跳。

---

## 六、加一个新敌人

**文件：`src/core/enemies.js`**

```js
defineEnemy({
  id: 'frost_wolf',
  name: '霜牙狼',
  title: '雪原的猎手',
  level: 14,
  color: '#63d4ff',
  sprite: 'wolf',
  scale: 1.1,                        // 渲染尺寸倍数

  // ⚠ 这里是「1 级等效值」，不是「14 级的值」。
  // 引擎会按 level 自动套成长曲线。
  baseStats: {
    maxHp: 1400, atk: 120, def: 80, spd: 130,
    critRate: 0.08, critDmg: 1.55,
    effectHit: 0.15, effectRes: 0.05, maxEnergy: 100,
  },

  toughness: 160,
  weaknesses: ['fire', 'lightning'],
  resist: { ice: 0.4 },              // 0.4 = 只吃 40% 伤害；0 = 免疫；负数 = 吸收

  skills: ['enemy_claw', 'enemy_frostbite'],
  ai: {
    policy: 'aggressive',
    skillPreference: { enemy_frostbite: 0.4, enemy_claw: 0.6 },
    targeting: 'lowestHp',
  },

  exp: 120,
  gold: 60,
  intro: '战斗开始时的旁白（可选）',
});
```

### 关于 `baseStats` 的最重要提醒

> **写 1 级等效值。**
>
> 引擎计算实际属性时是：
> `baseStats[k] × (1 + GROWTH[k] × (level − 1))`
>
> 如果你直接写「我希望它在 14 级有 1400 血」，实际会变成两千多。
> 开发时这个坑让 Boss 有了 127,000 血而不是 16,000。
>
> **`test/run-all.js` 里的「敌人 HP 处于设计区间内」会拦住这个错误。**

### AI 描述符字段

| 字段 | 作用 |
|---|---|
| `policy` | `aggressive` / `tactical` / `summoner` / `boss` / `support` / `suicide` |
| `script` | 硬编前几回合：`[{ turn: 1, skill: 'x' }]` |
| `skillPreference` | `{ 技能id: 权重 }`，加权随机 |
| `phases` | `[{ atHpRatio: 0.5, skill: 'x', once: true, phaseTo: 2 }]` |
| `finishers` | `[{ atHpRatio: 0.2, skill: 'x', once: true }]` |
| `summonCap` | 场上最多几个召唤物 |
| `summonTotalCap` | 整场最多召唤几个（**必须写**，否则会刷到天荒地老） |
| `skillCooldowns` | `{ 技能id: 回合数 }`（**自愈类必须写**） |
| `actionsPerTurn` | 一回合行动几次（Boss 建议 2） |
| `ultRequiresStacks` | `{ status: 'doom', min: 3 }` 攒够层数才放大招 |
| `aggressiveBelowHpRatio` | 低于此血量优先输出 |
| `fortifyBelowHpRatio` | 高于此血量才用防御技能 |
| `targeting` | `highestAtk` / `lowestHp` / `random` / `lowestDef` / `mostDebuffs` / `weakestToElement` |
| `selfDestructAfterTurns` | 自爆倒计时 |

### ⚠ 两个必须写的字段

**`skillCooldowns` 里一定要给自愈技能加冷却。**
否则 AI 会一直选它。开发时 Boss 一场仗自愈了 172,525，比全队总伤害还多，
变成永远打不死的 80 回合拉锯。

**`summonTotalCap` 一定要写。**
只限制场上数量的话，Boss 会在一场仗里召唤 24 个杂兵，玩家的伤害全打在杂兵上。

---

## 七、加一场 Boss 战

Boss 就是「`policy: 'boss'` + 阶段定义」的敌人。

```js
defineEnemy({
  id: 'new_boss',
  name: '霜之王座',
  level: 26,
  baseStats: { maxHp: 12000, atk: 280, def: 140, spd: 150, /* … */ },
  toughness: 520,
  weaknesses: ['fire', 'imaginary'],

  skills: ['boss_slash', 'boss_nova', 'boss_mark', 'boss_summon'],

  ai: {
    policy: 'boss',
    script: [
      { turn: 1, skill: 'boss_slash' },
      { turn: 2, skill: 'boss_mark' },
    ],
    phases: [{
      atHpRatio: 0.50,
      skill: 'boss_phase2',        // 这个技能本身只是表演
      once: true,
      phaseFrom: 1,
      phaseTo: 2,
      dialogue: '「那就一起冻住吧。」',
    }],
    finishers: [{ atHpRatio: 0.15, skill: 'boss_lastword', once: true }],
    summonCap: 2,
    summonTotalCap: 4,
    actionsPerTurn: 2,
    skillCooldowns: { boss_mark: 3, boss_nova: 2, boss_summon: 4 },
    ultRequiresStacks: { status: 'doom', min: 3 },
    aggressiveBelowHpRatio: 0.4,
    targeting: 'highestAtk',
  },

  // 阶段定义：换弱点、换抗性、调属性、播台词
  phases: [
    {
      phase: 1, name: '凝霜',
      weaknesses: ['fire', 'imaginary'],
      dialogue: '「冷吗？很快就感觉不到了。」',
    },
    {
      phase: 2, name: '绝对零度',
      weaknesses: ['fire', 'imaginary', 'lightning'],   // 追加雷弱点
      resist: { fire: 0.0, physical: 0.6 },
      statScale: { atk: 1.15, spd: 1.10 },              // 相对基准值，幂等
      dialogue: '「冻住的一切，都不会再痛。」',
    },
  ],
});
```

### 阶段转换做了什么

`bossPhaseChange` 处理器会自动：

1. 切换弱点与抗性
2. 按 `statScale` 调整属性（**幂等**，重复触发不会累加）
3. 韧性上限 ×1.1 并回满
4. 清除 Boss 召唤的所有小怪
5. 播放 `dialogue` 台词

你只需要写数据。

### 关于 `statScale` 的幂等性

系数是「相对基准值」的，不是累积的。写 `atk: 1.15` 就是「比初始值高 15%」，
不管这个阶段被触发几次。

> 早期版本是累积的：Boss 攻击力变成 397 → 456 → 525 → …，
> 因为 AI 的阶段触发和脚本处理器在同一回合都会调用一次。
> 现在用 `scaledPhases` 集合记录已应用的阶段。

---

## 八、加一个地图节点

**文件：`src/core/world-data.js`**

```js
nodes: {
  // …现有节点

  frozen_shrine: {
    id: 'frozen_shrine',
    name: '冰封祠堂',
    type: 'dungeon',                 // town | field | dungeon | boss
    bg: 'cave',                      // 视觉主题
    desc: '一句话场景描述。',
    lore: '首次进入时显示的背景故事（只显示一次）。',

    // 双向连接：两个节点都要写对方
    connections: ['sentinel_gate', 'frost_throne'],

    encounter: {
      rate: 1,
      groups: [
        { weight: 3, enemies: [{ id: 'frost_wolf', count: 2 }], name: '狼群' },
        { weight: 1, enemies: [{ id: 'frost_wolf', count: 1 }, { id: 'rotgrub', count: 3 }], name: '混编' },
      ],
    },

    // 可选：清够几次遭遇后出现精英
    elite: 'abyss_sentinel',
    eliteArrivesAfter: 2,
  },
}
```

### 等级门槛

```js
frost_throne: {
  id: 'frost_throne',
  type: 'boss',
  boss: 'new_boss',
  requiredLevel: 25,          // 队伍平均等级不够就无法前往
  prologue: ['Boss 战前的剧情文本', '一行一页'],
}
```

门槛在**移动时**检查，不是进入时。目的地会显示在地图列表里并标注所需等级——
玩家能看到要去哪、需要练到几级，而不是撞上一堵看不见的墙。

### 城镇服务

```js
haven_town: {
  type: 'town',
  services: ['inn', 'shop', 'smithy', 'party'],
  npcs: [
    {
      id: 'innkeeper',
      name: '旅店老板娘',
      portrait: 'elise',
      dialogue: ['第一句台词', '第二句台词'],
      hint: '这句话会显示在 NPC 卡片上',
    },
  ],
}
```

### 检查连通性

`npm run selftest` 会验证：

- 所有节点都从起点可达（否则报「不可达节点」）
- 所有连接都是双向的（单向连接会报错）
- 遭遇表里的敌人都存在
- 商店里的装备都存在

---

## 九、加一件装备 / 道具

### 装备

**文件：`src/core/characters.js`**

```js
defineEquipment({
  id: 'gear_frost_bow',
  name: '霜牙长弓',
  slot: 'weapon',          // weapon | boots | accessory
  rarity: 4,
  atkPct: 0.24,            // 以 Pct 结尾 = 百分比加成
  critRate: 0.06,          // 不带 Pct = 固定值加成
  desc: '攻击力 +24%，暴击率 +6%。',
});
```

支持的所有属性键：

```
maxHp / maxHpPct    atk / atkPct      def / defPct
spd / spdPct        critRate          critDmg
effectHit           effectRes         break
maxEnergy
```

加入商店：

```js
// world-data.js
shop: {
  stock: [
    { item: 'gear_frost_bow', price: 620 },
  ],
}
```

### 道具

**文件：`src/core/items.js`**

道具**就是**一个 `kind: 'item'` 的技能，所以效果语法完全一样：

```js
frost_grenade: {
  id: 'frost_grenade',
  name: '霜冻手雷',
  icon: '❄',
  kind: 'item',
  element: 'ice',
  target: 'aoe',
  rarity: 4,
  price: 280,
  desc: '对全体敌人造成 180% 攻击力的冰属性伤害，并降低其速度。',
  effects: [
    { type: 'damage', multiplier: 1.80, element: 'ice', toughness: 50 },
    { type: 'status', status: 'spd_down', duration: 2, chance: 0.8 },
  ],
}
```

加入初始背包：

```js
STARTING_INVENTORY: [
  { item: 'frost_grenade', count: 3 },
]
```

---

## 十、调平衡

### 全局数值

**文件：`src/core/rules.js`** 的 `BALANCE` 对象。

最常改的几个：

```js
ACTION_VALUE: 10000,          // 行动条总长度（一般不用改）
DEF_CONST: 400,               // 防御常数。越大 → 防御越不重要 → 战斗越快
LEVEL_STEP: 0.02,             // 每级等级差的影响
LEVEL_BAND: [0.5, 2.0],       // 等级差影响的上下限
DAMAGE_VARIANCE: 0.08,        // 伤害浮动 ±8%
MAX_SKILL_POINTS: 5,
START_SKILL_POINTS: 3,
GROWTH: { maxHp: 0.085, atk: 0.072, def: 0.062, spd: 0.012 },
```

> **改 `DEF_CONST` 要谨慎。** 它是「第二大旋钮」——先调敌人血量，
> 实在不行再动它。提高它会加快所有战斗，但也会让防御装备变得没用。

### 用平衡性测试验证

```bash
npm run balance              # 默认每场 60 次采样
node test/balance.js --runs 200 --verbose
```

输出会给出每场遭遇的胜率和 **95% 置信区间**：

```
● Boss：灰烬之王
   胜率  ████████████████░░░░ 79%  (95% 置信区间 69–86%)
   回合  26.6 平均 / 25.3 胜时   存活 1.9/4   击破 3.4   召唤 3.3
   ✓ 胜率 79%  (期望 25–95%)
   ✓ 胜时回合 25.3  (期望 ≥ 8)
   ✓ 平均回合 26.6  (期望 ≤ 80)
```

**为什么要看置信区间**：60 次采样下，「50%」的真实值可能在 37%–63% 之间。
直接按百分比调数值就是在追噪声。测试用区间来判断是否达标。

### 设计意图

期望值写在 `test/balance.js` 的 `ENCOUNTERS` 数组里：

```js
{
  id: 'boss_ashen_king',
  expect: {
    winRate: [0.25, 0.95],    // 满配队伍应当能赢，但不该是稳赢
    maxRounds: 80,
    minRounds: 8,             // 不该 3 回合结束
  },
  note: '两阶段 + 召唤 + 蓄力终结技，满配队伍应当能赢但会掉人',
}
```

改完数值跑一遍，看哪些期望不满足了。

### 战斗长度的快速估算法

在推荐等级下，一名角色的一次行动大约造成 **640 点伤害**，
一「回合」约等于 4 次我方行动，所以：

```
期望回合数 ≈ 敌人有效 HP / 2560
```

Boss 想要 15 回合左右，有效 HP 就该在 38,000 附近。

---

## 十一、什么时候必须写代码

数据能表达 95% 的东西。剩下 5% 是**命名脚本处理器**，
住在 `src/battle/scripts.js`。

### 1. 天赋钩子

角色定义里的 `hooks` 声明「什么时候调用哪个处理器」：

```js
// characters.js
hooks: [{ on: 'break', handler: 'shionTalentOnBreak' }],
```

```js
// scripts.js
define('shionTalentOnBreak', ({ battle, actor, target }) => {
  // actor = 触发者, target = 被击破的敌人
  battle.advanceActionValue(actor, Math.round(BALANCE.ACTION_VALUE * 0.15), 'talent:shion');
  battle.applyStatus(actor, actor, { status: 'crit_up', duration: 2 }, { force: true });
});
```

**可用的钩子事件：**

| 事件 | 参数 | 触发时机 |
|---|---|---|
| `break` | `target`, `element` | 该角色击破敌人时 |
| `broken` | `breaker` | 该单位被击破时 |
| `damageDealt` | `target`, `amount`, `skill`, `effect` | 每次造成伤害后 |
| `statusApplied` | `target`, `status`, `instance` | 施加状态后 |
| `statusReceived` | `source`, `status` | 被施加状态时 |
| `delayApplied` | `amount`, `cause` | 被推条时 |
| `turnStart` | — | 自己回合开始时 |
| `turnEnd` | — | 自己回合结束时 |
| `ultimateReady` | — | 能量充满时 |
| `down` | `killer` | 倒下时 |
| `delayed` | `amount`, `cause` | 被推条时（通用） |

### 2. 技能的 script 效果

技能的 `effects` 里可以插入 `{ type: 'script', handler: 'x' }`：

```js
// skills.js
effects: [
  { type: 'script', handler: 'shionUltScaling' },   // 先算缩放
  { type: 'damage', multiplier: 3.0, element: 'quantum' },
]
```

```js
// scripts.js
define('shionUltScaling', ({ battle, actor, skill, ctx }) => {
  const debuffs = ctx.primaryTarget.statuses.filter(s => {
    const k = getStatus(s.id).kind;
    return k === 'debuff' || k === 'dot' || k === 'control';
  }).length;
  // 写到 ctx 上，同一次技能的所有 damage 效果都会吃到
  ctx.pendingFlatBonus = Math.round(actor.resolveStats().atk * 3.0 * Math.min(0.6, debuffs * 0.12));
});
```

### 3. 需要延后执行的逻辑

如果脚本要在**伤害结算之后**才做事（比如「击破后追加推条」），
把它推进 `ctx.postDamage` 队列：

```js
define('ultBreakDelay', ({ battle, actor, ctx }) => {
  ctx.postDamage = ctx.postDamage || [];
  ctx.postDamage.push(() => {
    const target = ctx.primaryTarget;
    if (!target || !target.alive || !target.broken) return;
    battle.pushActionValue(target, Math.round(BALANCE.ACTION_VALUE * 0.30), 'skill:ult');
  });
});
```

引擎在技能所有效果执行完后会统一 flush 这个队列。

### 4. 全新的效果类型

只有在需要一种**现有 18 种效果都表达不了**的机制时才做：

1. 在 `src/core/skills.js` 的 `VALID_EFFECTS` 里加上类型名
2. 在 `src/battle/resolve.js` 的 `applyEffect` 的 `switch` 里加一个 case

加完记得在 `docs/ARCHITECTURE.md` 里记一笔为什么需要它。

---

## 十二、加完之后检查什么

```bash
npm run selftest        # 会检查所有引用完整性
npm run balance         # 会检查平衡性期望
```

`selftest` 覆盖的检查：

- 技能 id、状态 id、脚本处理器是否存在
- 角色是否有完整的 basic/skill/ultimate 槽位
- 敌人的技能表、AI 脚本引用是否有效
- 地图连通性（可达性、双向连接）
- 商店商品、遭遇组合法性
- 面板属性与战斗内属性是否一致
- 等级成长是否只应用一次
- 每次指令是否都把事件交回客户端
- 治疗/伤害技能的阵营是否正确

**加东西的时候如果自检报错，说明引用打错了——不要绕过它。**
每一条检查都对应一个真实踩过的坑。
