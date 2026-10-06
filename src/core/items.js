'use strict';

/**
 * Consumables.
 *
 * Kept deliberately small. In an Atelier-flavoured game items are a whole
 * crafting system; here they exist to prove that the effect vocabulary in
 * `core/skills.js` is general enough to describe a usable item without a
 * separate code path — an item *is* a skill with `kind: 'item'`, which is why
 * `Battle.useItem` just calls `executeSkill`.
 *
 * `target` uses the same selectors as skills.
 */

const ITEMS = {
  heal_potion: {
    id: 'heal_potion',
    name: '治疗药水',
    icon: '🧴',
    kind: 'item',
    element: 'imaginary',
    target: 'ally',
    rarity: 2,
    price: 60,
    desc: '为我方单体回复 800 点生命。',
    effects: [
      { type: 'heal', mode: 'flat', healFlat: 800 },
    ],
  },
  greater_potion: {
    id: 'greater_potion',
    name: '高级治疗药水',
    icon: '🍶',
    kind: 'item',
    element: 'imaginary',
    target: 'ally',
    rarity: 3,
    price: 180,
    desc: '为我方单体回复 40% 最大生命。',
    effects: [
      { type: 'heal', mode: 'maxHp', healRatio: 0.40 },
    ],
  },
  remedy: {
    id: 'remedy',
    name: '万能药',
    icon: '💊',
    kind: 'item',
    element: 'imaginary',
    target: 'ally',
    rarity: 3,
    price: 150,
    desc: '解除我方单体全部减益，并回复 300 点生命。',
    effects: [
      { type: 'cleanse' },
      { type: 'heal', mode: 'flat', healFlat: 300 },
    ],
  },
  bomb: {
    id: 'bomb',
    name: '爆裂弹',
    icon: '💣',
    kind: 'item',
    element: 'fire',
    target: 'aoe',
    rarity: 3,
    price: 120,
    toughness: 40,
    desc: '对全体敌人造成 150% 攻击力的火属性伤害。',
    effects: [
      { type: 'damage', multiplier: 1.50, element: 'fire', toughness: 40 },
    ],
  },
  ice_crystal: {
    id: 'ice_crystal',
    name: '冰晶碎片',
    icon: '🧊',
    kind: 'item',
    element: 'ice',
    target: 'single',
    rarity: 4,
    price: 260,
    toughness: 60,
    desc: '对单体造成 200% 攻击力的冰属性伤害，并有 70% 概率冻结 1 回合。',
    effects: [
      { type: 'damage', multiplier: 2.00, element: 'ice', toughness: 60 },
      { type: 'status', status: 'freeze', duration: 1, chance: 0.70 },
    ],
  },
  alchemy_flask: {
    id: 'alchemy_flask',
    name: '炼金溶剂',
    icon: '⚗',
    kind: 'item',
    element: 'fire',
    target: 'single',
    rarity: 4,
    price: 320,
    desc: '附加 3 层「炼金印记」并引爆：每层造成 45% 攻击力的火属性伤害。',
    effects: [
      { type: 'status', status: 'brand', stacks: 3, duration: 3, chance: 1.0 },
      { type: 'detonate', status: 'brand', ratio: 0.45 },
    ],
  },
  energy_drink: {
    id: 'energy_drink',
    name: '充能饮料',
    icon: '🥤',
    kind: 'item',
    element: 'imaginary',
    target: 'ally',
    rarity: 3,
    price: 200,
    desc: '为我方单体回复 40 点能量。',
    effects: [
      { type: 'energy', amount: 40 },
    ],
  },
  revival_flask: {
    id: 'revival_flask',
    name: '回生药剂',
    icon: '🕯',
    kind: 'item',
    element: 'imaginary',
    // 'downed' is a real skill selector (see `VALID_TARGETS`); the item *is* a
    // skill, so targeting a fallen ally reuses the same rule with no new code.
    target: 'downed',
    rarity: 4,
    price: 320,
    desc: '复活一名倒下的队友，并回复其 50% 最大生命。全队每场限用。',
    effects: [
      // `target: 'downed'` is load-bearing: the `primary` selector only accepts
      // *living* targets, so without this the flask would silently re-target a
      // living ally and the revive would no-op past its `target.alive` guard.
      { type: 'revive', hpRatio: 0.5, target: 'downed' },
    ],
  },
  smoke_bomb: {
    id: 'smoke_bomb',
    name: '烟雾弹',
    icon: '💨',
    kind: 'item',
    element: 'wind',
    target: 'self',
    rarity: 3,
    price: 140,
    desc: '自身获得 1 回合「隐匿」，不会被单体技能选中。',
    effects: [
      { type: 'status', status: 'stealth', duration: 1, chance: 1.0 },
    ],
  },
};

/** Starting inventory for a new game. */
const STARTING_INVENTORY = [
  { item: 'heal_potion', count: 5 },
  { item: 'bomb', count: 3 },
  { item: 'remedy', count: 2 },
  { item: 'energy_drink', count: 2 },
];

function getItem(id) {
  return ITEMS[id] || null;
}

function listItems() {
  return Object.keys(ITEMS).map((id) => ITEMS[id]);
}

/** Items that can be used in battle (all of them, for now). */
function battleItems() {
  return listItems().filter((i) => i.kind === 'item');
}

module.exports = { ITEMS, STARTING_INVENTORY, getItem, listItems, battleItems };
