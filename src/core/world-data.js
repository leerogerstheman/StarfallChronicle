'use strict';

/**
 * The world: a small, hand-authored map graph with encounters, shops and story
 * beats. This is the "town / exploration" layer — deliberately thin, because
 * the point of the template is the battle engine, but real enough that the demo
 * has a loop: walk → fight → level → equip → walk further.
 *
 * Everything is data. `src/world/` only interprets it.
 *
 * The node graph is linear with branches, which is the honest shape of a JRPG
 * prologue. Node types:
 *   town     safe hub, has services
 *   field    random encounters on entry (or none, if `safe`)
 *   dungeon  encounter chain, ends in an elite or boss
 *   boss     terminal node, no random encounters
 */

const WORLD = {
  id: 'starfall_prologue',
  name: '星陨纪年 · 序章',
  subtitle: '被焚毁的旧都',
  startNode: 'haven_town',
  /** Party size the demo supports; the engine itself has no cap. */
  partySize: 4,
  /** Full roster, so the player can swap between nodes. */
  roster: ['ayaha', 'rinne', 'rin', 'byakuya', 'elise'],

  nodes: {
    haven_town: {
      id: 'haven_town',
      name: '避风港 · 旅人街',
      type: 'town',
      safe: true,
      bg: 'town',
      desc:
        '最后一座还亮着灯的小镇。空气里混着面包和铁锈的味道。',
      services: ['inn', 'shop', 'smithy', 'party'],
      connections: ['whisper_woods'],
      lore:
        '旧都焚毁那年，逃出来的人在这里搭起棚子。十年过去，棚子变成了街。',
      npcs: [
        {
          id: 'innkeeper',
          name: '旅店老板娘',
          portrait: 'elise',
          dialogue: [
            '住一晚 30 金。热水管够，故事另算。',
            '往北的林子最近不太平，虫子成灾。要我说，绕路。',
          ],
          hint: '旅店可以恢复全队生命并保存进度。',
        },
        {
          id: 'quartermaster',
          name: '军需官',
          portrait: 'byakuya',
          dialogue: [
            '装备是活下来的第一件事，第二件是别死。',
            '你手上那把剑……风属性的？林子里的虫子怕火也怕风。',
          ],
          hint: '商店可以购买武器与饰品，也可以更换队伍装备。',
        },
      ],
    },

    whisper_woods: {
      id: 'whisper_woods',
      name: '低语林',
      type: 'field',
      bg: 'forest',
      desc: '树冠遮住了大部分天光，脚下是厚厚的腐叶。',
      connections: ['haven_town', 'grub_hollow'],
      encounter: {
        /** Weighted enemy groups; 1 = always fires on first entry. */
        rate: 1,
        groups: [
          { weight: 3, enemies: [{ id: 'rotgrub', count: 2 }, { id: 'larva', count: 2 }], name: '虫群' },
          { weight: 2, enemies: [{ id: 'rotgrub', count: 3 }], name: '食腐者们' },
          { weight: 1, enemies: [{ id: 'rotgrub', count: 2 }, { id: 'grub_matriarch', count: 1 }], name: '虫母的巢' },
        ],
      },
      lore: '林子会吃声音。喊出来没人应，所以镇民管它叫低语林。',
    },

    grub_hollow: {
      id: 'grub_hollow',
      name: '虫巢深处',
      type: 'dungeon',
      bg: 'cave',
      desc: '腐叶堆成的小山，中央是一颗还在搏动的琥珀色卵。',
      connections: ['whisper_woods', 'sentinel_gate'],
      encounter: {
        rate: 1,
        groups: [
          { weight: 2, enemies: [{ id: 'rotgrub', count: 2 }, { id: 'larva', count: 3 }], name: '虫巢守卫' },
          { weight: 2, enemies: [{ id: 'rotgrub', count: 1 }, { id: 'grub_matriarch', count: 1 }, { id: 'larva', count: 2 }], name: '虫母的巢' },
        ],
      },
      /** The mandatory fight in this node is the elite. */
      elite: 'abyss_sentinel',
      eliteArrivesAfter: 2,
      lore:
        '琥珀色的卵是虫母的心。它不在别处——它就长在虫母身上，只是被啃空了。',
    },

    sentinel_gate: {
      id: 'sentinel_gate',
      name: '旧都 · 焚门',
      type: 'dungeon',
      bg: 'ruins',
      desc: '半塌的城门上还挂着烧熔的家徽。门后是灰。',
      connections: ['grub_hollow', 'throne_of_ash'],
      encounter: {
        rate: 1,
        groups: [
          { weight: 2, enemies: [{ id: 'ash_husk', count: 2 }], name: '游荡的残骸' },
          { weight: 2, enemies: [{ id: 'ash_husk', count: 1 }, { id: 'rotgrub', count: 2 }], name: '灰烬里的活物' },
          { weight: 1, enemies: [{ id: 'abyss_sentinel', count: 1 }], name: '另一个哨兵' },
        ],
      },
      lore:
        '旧都的名字被从所有地图上刮掉了。城里的人也是。',
    },

    throne_of_ash: {
      id: 'throne_of_ash',
      name: '灰烬王座',
      type: 'boss',
      bg: 'throne',
      desc: '王座是烧熔的兵器堆成的。上面坐着的东西，正在慢慢呼吸。',
      connections: ['sentinel_gate'],
      boss: 'ashen_king',
      requiredLevel: 10,
      lore:
        '瓦尔特斯是旧都的最后一任王。他没能救下城，于是决定和城一起烧掉。',
      /** Story text shown before the fight, one page at a time. */
      prologue: [
        '你说的对，这里什么都没有了。',
        '——所以，请你也留下。',
      ],
    },
  },

  /**
   * Field checkpoints: entering a node with `rest` lets the party heal once.
   * Kept as data so a designer can place them without touching code.
   */
  checkpoints: ['grub_hollow'],

  shop: {
    id: 'haven_shop',
    name: '旅人街 · 军需处',
    greeting: '钱货两清，概不赊账。',
    stock: [
      // Consumables use the price from `core/items.js` verbatim — one source of
      // truth for item pricing; equipment keeps its entries here.
      { item: 'heal_potion', price: 60 },
      { item: 'greater_potion', price: 180 },
      { item: 'remedy', price: 150 },
      { item: 'energy_drink', price: 200 },
      { item: 'smoke_bomb', price: 140 },
      { item: 'bomb', price: 120 },
      { item: 'ice_crystal', price: 260 },
      { item: 'alchemy_flask', price: 320 },
      { item: 'revival_flask', price: 320 },
      { item: 'gear_swift_boots', price: 240 },
      { item: 'gear_guard_ring', price: 260 },
      { item: 'gear_crit_lens', price: 420 },
      { item: 'gear_break_gauntlet', price: 380 },
      { item: 'gear_energy_core', price: 400 },
      { item: 'gear_vital_pendant', price: 300 },
      { item: 'gear_wind_blade', price: 520 },
      { item: 'gear_alchemy_kit', price: 540 },
      { item: 'gear_frost_tome', price: 560 },
      { item: 'gear_thunder_lance', price: 580 },
      { item: 'gear_holy_staff', price: 500 },
    ],
  },

  inn: {
    id: 'haven_inn',
    name: '旅人街 · 暖炉亭',
    cost: 30,
    greeting: '热水已经烧上了。',
    /** Full heal plus a small permanent buff for the next battle only. */
    bonus: 'brave_order',
  },
};

function getNode(id) {
  const n = WORLD.nodes[id];
  if (!n) throw new Error(`Unknown world node: ${id}`);
  return n;
}

/** Node ids reachable from `id`. */
function neighbors(id) {
  return getNode(id).connections.slice();
}

/**
 * Breadth-first reachability from the start, used by the self-test to prove
 * every authored node is actually visitable (a classic content bug: an
 * encounter you can never reach).
 */
function reachableFrom(start) {
  const seen = new Set();
  const queue = [start || WORLD.startNode];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of getNode(id).connections) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Reverse check: nodes nothing connects to (orphans). */
function unreachableNodes() {
  const seen = reachableFrom(WORLD.startNode);
  return Object.keys(WORLD.nodes).filter((id) => !seen.has(id));
}

module.exports = { WORLD, getNode, neighbors, reachableFrom, unreachableNodes };
