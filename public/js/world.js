'use strict';

/**
 * World, town, party, shop and codex screens.
 *
 * All of these are "read the view the server sent and draw it". The only local
 * decisions are cosmetic: which button to emphasise, how to phrase a locked
 * destination. Anything that changes game state goes through `Api` and the
 * response's `view` replaces the local one wholesale.
 */

const WorldUI = {
  render(view) {
    this.renderTopbar(view);
    this.renderScene(view);
    this.renderParty(view);
    this.renderTravel(view);
    this.renderProgress(view);
  },

  renderTopbar(view) {
    $('topbar-place').textContent = view.node ? view.node.name : '—';
    $('topbar-gold').textContent = Fmt.num(view.gold);
    const alive = (view.party ? view.party.members : []).filter((m) => m.active);
    $('topbar-party').textContent = alive
      .map((m) => `${m.name} ${m.down ? '✝' : Math.round((m.hp / m.maxHp) * 100) + '%'}`)
      .join(' · ') || '—';
  },

  renderScene(view) {
    const node = view.node;
    $('scene-bg').dataset.bg = node.bg || 'town';
    $('scene-type').textContent = {
      town: '城镇 / TOWN',
      field: '野外 / FIELD',
      dungeon: '迷宫 / DUNGEON',
      boss: '决战 / BOSS',
    }[node.type] || node.type;
    $('scene-name').textContent = node.name;
    $('scene-desc').textContent = node.desc;

    // Lore only appears on a first visit, so a second pass through a zone is
    // not slowed down by text the player already read.
    const loreBox = $('lore-box');
    if (node.lore) {
      $('lore-text').textContent = node.lore;
      loreBox.classList.remove('hidden');
    } else {
      loreBox.classList.add('hidden');
    }

    // --- Actions ---------------------------------------------------------
    const actions = [];
    const inTown = node.type === 'town';

    if (node.hasBoss) {
      actions.push(el('button.btn.btn-primary', {
        onclick: () => this.enterNode('boss'),
        title: '挑战本区域的 Boss',
      }, '⚔ 挑战 Boss'));
    }
    if (node.hasElite) {
      actions.push(el('button.btn.btn-primary', {
        onclick: () => this.enterNode('elite'),
      }, '◈ 迎战精英'));
    }
    if (node.hasEncounter) {
      actions.push(el('button.btn', {
        onclick: () => this.enterNode('explore'),
      }, '🔍 探索（触发遭遇）'));
    }
    if (!node.hasEncounter && !node.hasBoss && !node.hasElite && !inTown) {
      actions.push(el('button.btn', {
        disabled: true,
        title: '这里已经没有新的遭遇了',
      }, '这里暂时安全'));
    }

    if (inTown) {
      for (const service of node.services) {
        if (service === 'inn') {
          actions.push(el('button.btn', { onclick: () => this.rest() }, '🛏 旅店休息（30 金）'));
        }
        if (service === 'shop') {
          actions.push(el('button.btn', { onclick: () => this.openShop() }, '🏪 军需处'));
        }
        if (service === 'smithy') {
          actions.push(el('button.btn', { onclick: () => this.openParty() }, '⚙ 整备队伍'));
        }
        if (service === 'party') {
          actions.push(el('button.btn.btn-ghost', { onclick: () => this.openParty() }, '👥 队伍编成'));
        }
      }
      if (view.restBonus) {
        actions.push(el('span.tag', {
          text: `已获得「${view.restBonus}」：下一场战斗生效`,
          style: { color: 'var(--gold)', borderColor: 'var(--gold)' },
        }));
      }
    }

    swap($('scene-actions'), actions);

    // --- NPCs ------------------------------------------------------------
    swap($('npc-row'), (node.npcs || []).map((npc) => {
      const def = this.findNpc(node.id, npc.id);
      const face = Art.image('npc', npc.id, {
        className: 'npc-face', view: 'bust', plain: true, alt: npc.name,
      });
      return el('div.npc-card', {
        onclick: () => this.talkTo(npc, def),
        title: '点击交谈',
      }, [
        el('div.npc-avatar', { class: face ? 'has-art' : null },
          [face || npc.name.slice(0, 1)]),
        el('div', null, [
          el('div.npc-name', { text: npc.name }),
          el('div.npc-hint', { text: def ? def.hint : '交谈' }),
        ]),
      ]);
    }));
  },

  findNpc(nodeId, npcId) {
    const data = State.data;
    if (!data || !data.world) return null;
    const node = (data.world.nodes || []).find((n) => n.id === nodeId);
    if (!node || !node.npcs) return null;
    return node.npcs.find((n) => n.id === npcId) || null;
  },

  renderParty(view) {
    swap($('party-strip'), (view.party.members || [])
      .filter((m) => m.active)
      .map((m) => {
        const ratio = Math.max(0, m.hp / m.maxHp);
        const face = Art.image('character', m.charId, {
          className: 'party-face',
          view: 'bust',
          plain: true,
          expression: m.down || ratio <= 0.3 ? 'hurt' : 'neutral',
          alt: m.name,
        });
        return el('div.party-card', { class: m.down ? 'party-down' : null }, [
          el('div.party-avatar', { class: face ? 'has-art' : null, style: { color: m.color } },
            [face || m.name.slice(0, 1)]),
          el('div.party-meta', null, [
            el('div.party-line', null, [
              el('span.party-name', { text: m.name }),
              el('span.party-lv', { text: `Lv${m.level}` }),
            ]),
            el('div.bar.bar-hp.small', { class: ratio <= 0.3 ? 'is-low' : ratio <= 0.6 ? 'is-mid' : '' }, [
              el('div.bar-fill', { style: { width: `${ratio * 100}%` } }),
            ]),
            el('div.party-hp-text', {
              text: m.down ? '已倒下' : `${Fmt.compact(m.hp)} / ${Fmt.compact(m.maxHp)}`,
            }),
          ]),
          elementTag(m.element),
        ]);
      }));
  },

  renderTravel(view) {
    swap($('travel-list'), (view.node.connections || []).map((c) => {
      const locked = c.locked;
      return el('button.travel-item', {
        disabled: !!locked,
        title: locked ? `需要平均等级 ${locked.required}（当前 ${locked.current}）` : `前往 ${c.name}`,
        onclick: () => this.travel(c.id),
      }, [
        el('div', null, [
          el('div.travel-name', { text: c.name }),
          c.visited ? null : el('div.npc-hint', { text: '未探索' }),
        ]),
        el('div.travel-tags', null, [
          locked ? el('span.tag', { text: `需 Lv${locked.required}`, style: { color: 'var(--danger)' } }) : null,
          el('span.tag', {
            text: { town: '城镇', field: '野外', dungeon: '迷宫', boss: '决战' }[c.type] || c.type,
          }),
        ]),
      ]);
    }));
  },

  renderProgress(view) {
    const p = view.progress || {};
    const lines = [
      ['已探索节点', `${(p.visited || []).length} / ${p.totalNodes}`],
      ['Boss 讨伐', p.bossDefeated ? '已完成' : '未完成'],
      ['序章', p.cleared ? '通关' : '进行中'],
      ['队伍平均等级', String(Math.round((view.party.members || []).filter((m) => m.active)
        .reduce((s, m) => s + m.level, 0) / Math.max(1, (view.party.members || []).filter((m) => m.active).length)))],
    ];
    swap($('progress-box'), lines.map(([label, value]) =>
      el('div.progress-line', null, [el('span', { text: label }), el('b', { text: value })])));
  },

  // =======================================================================
  // Actions
  // =======================================================================

  async travel(to) {
    try {
      const res = await Api.travel(State.sessionId, to);
      State.view = res.view;
      this.render(State.view);
      const entry = res.result && res.result.entry;
      if (res.result && res.result.firstVisit) {
        toast(`抵达 ${entry.name}`, 'good');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /**
   * Enter the current node. `mode` is a UI hint only — the server decides what
   * actually happens, and may well answer with a story beat instead of a fight.
   */
  async enterNode(mode) {
    try {
      const res = await Api.enter(State.sessionId);
      State.view = res.view;
      const result = res.result || {};

      if (result.entry === 'blocked') {
        toast(result.message || '无法进入。', 'error');
        this.render(State.view);
        return;
      }
      if (result.entry === 'story') {
        // Boss prologue: show the text, then start the fight when dismissed.
        Main.showStory(result.story);
        return;
      }
      if (result.entry === 'encounter') {
        BattleUI.reset();
        Main.showBattle();
        await BattleUI.consume({ state: State.view.battle, waiting: true });
        // `step()` to get the first actor on the clock.
        await Main.stepBattle();
        return;
      }
      this.render(State.view);
      toast('这里暂时没有遭遇。');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async rest() {
    try {
      const res = await Api.rest(State.sessionId);
      State.view = res.view;
      this.render(State.view);
      toast(`休息完毕，全员恢复。「${res.result.bonusName}」将在下一场战斗生效。`, 'good');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  // =======================================================================
  // Party screen
  // =======================================================================

  openParty() {
    const view = State.view;
    const build = () => el('div', null, [
      el('p.muted', {
        text: `选择出战成员（最多 ${view.party.maxSize} 人，当前 ${view.party.active.length} 人）。战斗中的生命值会保留，倒下需要休息。`,
        style: { marginBottom: '16px', fontSize: '12px' },
      }),
      el('div.party-grid', null, (view.party.members || []).map((m) => this.memberCard(m, build))),
      el('div.row', { style: { marginTop: '18px', gap: '10px' } }, [
        el('button.btn.btn-primary', { onclick: () => this.openShop() }, '前往军需处购买装备'),
        el('button.btn.btn-ghost', { onclick: () => this.openCodex() }, '查看技能图鉴'),
      ]),
    ]);
    Modal.open('队伍编成 / PARTY', build());
  },

  memberCard(m, rebuild) {
    const stats = m.stats || {};
    const skills = (m.skills || []).filter((s) => s.kind !== 'talent' || true);

    const toggle = el('button.btn.btn-small', {
      class: m.active ? 'btn-danger' : 'btn-primary',
      disabled: !m.active && State.view.party.active.length >= State.view.party.maxSize,
      title: m.active ? '移出出战队伍' : '加入出战队伍',
      onclick: async () => {
        const current = State.view.party.active.slice();
        const next = m.active ? current.filter((id) => id !== m.charId) : [...current, m.charId];
        try {
          const res = await Api.setParty(State.sessionId, next);
          State.view = res.view;
          this.render(State.view);
          rebuild();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, m.active ? '移出' : '编入');

    // Equipment picker: only items the player owns, per slot.
    const owned = this.ownedForSlot(m);

    const face = Art.image('character', m.charId, {
      className: 'member-face',
      view: 'bust',
      plain: true,
      expression: m.down ? 'hurt' : 'neutral',
      alt: m.name,
    });

    // The standing art gets its own column. This is the one screen in the game
    // with room for a full-body drawing, and the party screen is exactly where
    // a player goes to look at their characters.
    const standing = Art.image('character', m.charId, {
      className: 'member-standing',
      view: 'full',
      alt: `${m.name} 立绘`,
    });

    return el('div.member-card', { class: m.active ? 'is-active' : null }, [
      el('div.member-art', { class: standing ? 'has-art' : null }, [
        standing || el('div.member-art-empty', { text: m.name.slice(0, 1) }),
      ]),
      el('div.member-body', null, [
      el('div.member-head', null, [
        el('div.member-avatar', { class: face ? 'has-art' : null, style: { color: m.color } },
          [face || m.name.slice(0, 1)]),
        el('div', { style: { flex: '1', minWidth: '0' } }, [
          el('div.member-name', { text: m.name }),
          el('div.member-title', { text: m.title }),
          el('div.member-tags', null, [
            elementTag(m.element),
            el('span.tag', { text: m.role }),
            el('span.tag', { text: `Lv ${m.level}` }),
            m.down ? el('span.tag', { text: '倒下', style: { color: 'var(--danger)' } }) : null,
          ]),
        ]),
        toggle,
      ]),

      el('div.stat-grid', null, [
        statCell('生命', Fmt.compact(stats.maxHp)),
        statCell('攻击', Math.round(stats.atk)),
        statCell('防御', Math.round(stats.def)),
        statCell('速度', Math.round(stats.spd)),
        statCell('暴击', Fmt.pct(stats.critRate)),
        statCell('爆伤', Fmt.pct(stats.critDmg - 1)),
      ]),

      el('div.bar.bar-hp.small', { style: { marginBottom: '10px' } }, [
        el('div.bar-fill', {
          style: { width: `${Math.max(0, (m.hp / m.maxHp) * 100)}%` },
        }),
      ]),

      el('div.skill-list', null, skills.map((s) => el('div.skill-item', {
        title: `${s.name}\n${s.desc}`,
      }, [
        el('span.skill-item-icon', { text: s.icon }),
        el('div', null, [
          el('div.skill-item-name', null, [
            s.name, ' ',
            el('span.tag', { text: { basic: '普攻', skill: '战技', ultimate: '终结技', talent: '天赋' }[s.kind] || s.kind }),
          ]),
          el('div.skill-item-desc', { text: s.desc }),
        ]),
      ]))),

      el('div.equip-row', null, ['weapon', 'boots', 'accessory'].map((slot) => {
        const slotLabel = { weapon: '武器', boots: '鞋子', accessory: '饰品' }[slot];
        const current = m.equipment[slot];
        const options = owned[slot] || [];
        return el('div.equip-slot', null, [
          el('span.equip-slot-name', { text: slotLabel }),
          el('select', {
            style: {
              background: 'var(--bg-input)', color: 'var(--text)',
              border: '1px solid var(--line)', borderRadius: '4px',
              padding: '2px 6px', fontSize: '11px', maxWidth: '150px',
            },
            onchange: async (ev) => {
              const value = ev.target.value;
              if (!value) return;
              try {
                const res = await Api.equip(State.sessionId, m.charId, value);
                State.view = res.view;
                this.render(State.view);
                rebuild();
                toast(`${m.name} 装备了 ${res.result.sheet ? value : value}`, 'good', 1200);
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, [
            el('option', { value: '', text: '— 空 —', selected: !current }),
            ...options.map((item) => el('option', {
              value: item.id,
              text: item.name,
              selected: current === item.id,
            })),
          ]),
        ]);
      })),
      ]),
    ]);
  },

  /** Equipment the player owns that fits each slot, for the picker. */
  ownedForSlot(member) {
    const data = State.data || {};
    const all = data.equipment || [];
    const result = { weapon: [], boots: [], accessory: [] };
    // The demo hands out the default loadout, so those are always available;
    // anything else must have been bought.
    const purchased = new Set(State.purchased || []);
    for (const item of all) {
      const isDefault = Object.values(member.equipment || {}).includes(item.id);
      const isBought = purchased.has(item.id) || (State.view && State.view.gold !== undefined && State.owns !== false && false);
      // Owned = currently equipped by anyone, bought this session, or a default.
      const equippedAnywhere = (State.view.party.members || []).some(
        (other) => Object.values(other.equipment || {}).includes(item.id),
      );
      if (isDefault || equippedAnywhere || isBought) {
        const slot = item.slot || 'accessory';
        if (result[slot]) result[slot].push(item);
      }
    }
    // De-duplicate by id.
    for (const slot of Object.keys(result)) {
      const seen = new Set();
      result[slot] = result[slot].filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
    }
    return result;
  },

  // =======================================================================
  // Shop
  // =======================================================================

  openShop() {
    const shop = (State.data.world && State.data.world.shop) || { stock: [], greeting: '' };
    const build = () => {
      const gold = State.view.gold;
      return el('div', null, [
        el('p.muted', { text: shop.greeting, style: { marginBottom: '16px', fontSize: '12px' } }),
        el('div.shop-grid', null, shop.stock.map((entry) => {
          const item = (State.data.equipment || []).find((e) => e.id === entry.item);
          if (!item) return null;
          const affordable = gold >= entry.price;
          const equipLines = Object.entries(item)
            .filter(([k]) => !['id', 'name', 'slot', 'rarity', 'desc'].includes(k))
            .map(([k, v]) => `${STAT_LABELS[k] || k} ${typeof v === 'number' && v < 1 ? Fmt.pct(v) : Math.round(v)}`);
          return el('div.shop-item', null, [
            el('div.row-between', null, [
              el('div.shop-item-name', { text: item.name }),
              el('span.tag', { text: { weapon: '武器', boots: '鞋子', accessory: '饰品' }[item.slot] || item.slot }),
            ]),
            el('div.shop-item-desc', { text: item.desc }),
            el('div.muted', { text: equipLines.join(' · '), style: { fontSize: '11px' } }),
            el('div.shop-item-foot', null, [
              el('span.price', { text: `◎ ${entry.price}` }),
              el('button.btn.btn-small', {
                class: affordable ? 'btn-primary' : null,
                disabled: !affordable,
                onclick: async () => {
                  try {
                    const res = await Api.buy(State.sessionId, entry.item);
                    State.view = res.view;
                    State.purchased = State.purchased || [];
                    State.purchased.push(entry.item);
                    WorldUI.render(State.view);
                    rebuild();
                    toast(`购入 ${item.name}`, 'good', 1400);
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                },
              }, affordable ? '购买' : '金币不足'),
            ]),
          ]);
        })),
        el('p.muted', {
          text: '购买的装备会立即加入可用列表，可在「整备队伍」中给角色换上。',
          style: { marginTop: '16px', fontSize: '11px' },
        }),
      ]);
    };
    Modal.open('军需处 / QUARTERMASTER', build());
  },

  // =======================================================================
  // Codex
  // =======================================================================

  openCodex() {
    const data = State.data || {};
    const tabs = el('div.row', { style: { marginBottom: '16px', gap: '8px', flexWrap: 'wrap' } });
    const content = el('div');

    const show = (kind) => {
      swap(tabs, [
        tabButton('技能', kind === 'skills', () => show('skills')),
        tabButton('状态效果', kind === 'statuses', () => show('statuses')),
        tabButton('敌人', kind === 'enemies', () => show('enemies')),
        tabButton('装备', kind === 'equipment', () => show('equipment')),
      ]);
      if (kind === 'skills') {
        swap(content, el('table.help-table', null, [
          el('tr', null, [el('th', { text: '' }), el('th', { text: '名称' }), el('th', { text: '类型' }),
            el('th', { text: '属性' }), el('th', { text: '削韧' }), el('th', { text: '说明' })]),
          ...(data.skills || []).filter((s) => s.kind !== 'talent').map((s) => el('tr', null, [
            el('td', { text: s.icon }),
            el('td', { text: s.name }),
            el('td', { text: { basic: '普攻', skill: '战技', ultimate: '终结技', technique: '秘技' }[s.kind] || s.kind }),
            el('td', { text: Fmt.element(s.element).name }),
            el('td', { text: s.toughness ? String(s.toughness) : '—' }),
            el('td', { text: s.desc }),
          ])),
        ]));
      } else if (kind === 'statuses') {
        swap(content, el('table.help-table', null, [
          el('tr', null, [el('th', { text: '' }), el('th', { text: '名称' }), el('th', { text: '类别' }), el('th', { text: '说明' })]),
          ...(data.statuses || []).map((s) => el('tr', null, [
            el('td', { text: s.icon }),
            el('td', { text: s.name }),
            el('td', { text: { buff: '增益', debuff: '减益', dot: '持续伤害', hot: '持续回复', control: '控制', special: '特殊' }[s.kind] || s.kind }),
            el('td', { text: s.desc }),
          ])),
        ]));
      } else if (kind === 'enemies') {
        swap(content, el('table.help-table', null, [
          el('tr', null, [el('th', { text: '名称' }), el('th', { text: '等级' }), el('th', { text: '弱点' }),
            el('th', { text: '韧性' }), el('th', { text: '抵抗' })]),
          ...(data.enemies || []).map((e) => el('tr', null, [
            el('td', { text: e.name }),
            el('td', { text: `Lv ${e.level}` }),
            el('td', { text: (e.weaknesses || []).map((w) => Fmt.element(w).icon).join(' ') || '—' }),
            el('td', { text: e.toughness ? String(e.toughness) : '—' }),
            el('td', {
              text: Object.entries(e.resist || {})
                .map(([k, v]) => `${Fmt.element(k).icon}${v <= 0 ? '免疫' : Fmt.pct(v)}`).join(' ') || '—',
            }),
          ])),
        ]));
      } else {
        swap(content, el('table.help-table', null, [
          el('tr', null, [el('th', { text: '名称' }), el('th', { text: '部位' }), el('th', { text: '效果' })]),
          ...(data.equipment || []).map((e) => el('tr', null, [
            el('td', { text: e.name }),
            el('td', { text: { weapon: '武器', boots: '鞋子', accessory: '饰品' }[e.slot] || e.slot }),
            el('td', { text: e.desc }),
          ])),
        ]));
      }
    };

    const tabButton = (label, active, onclick) =>
      el('button.btn.btn-small', { class: active ? 'btn-primary' : 'btn-ghost', onclick }, label);

    show('skills');
    Modal.open('图鉴 / CODEX', el('div', null, [tabs, content]));
  },

  // =======================================================================
  // NPC dialogue
  // =======================================================================

  talkTo(npc, def) {
    if (!def) return;
    const lines = def.dialogue || [];
    swap($('modal-body'), el('div', null, [
      el('p', { text: def.hint || '', style: { color: 'var(--gold)', fontSize: '12px', marginBottom: '14px' } }),
      ...lines.map((line) => el('p', {
        text: `「${line}」`,
        style: { marginBottom: '10px', lineHeight: '1.8' },
      })),
    ]));
    $('modal-title').textContent = npc.name;
    $('modal').classList.remove('hidden');
  },
};

/** Human labels for equipment stat keys, used by the shop. */
const STAT_LABELS = {
  atk: '攻击', atkPct: '攻击%', def: '防御', defPct: '防御%',
  maxHp: '生命', maxHpPct: '生命%', spd: '速度', spdPct: '速度%',
  critRate: '暴击率', critDmg: '暴击伤害', effectHit: '效果命中', effectRes: '效果抵抗',
  break: '削韧', maxEnergy: '能量上限',
};
