'use strict';

/**
 * Application entry point: boot, screen routing, hotkeys, and the story/result
 * modals.
 *
 * The screen router is a tiny state machine over `State.view.mode`, which is the
 * server's own notion of where the player is. That means the browser can never
 * show the battle UI when the server thinks the party is in town — the single
 * most common source of "my clicks do nothing" bugs in a client-server game.
 */

const SCREENS = ['screen-world', 'screen-battle', 'screen-result'];

const Main = {
  ready: false,

  // =======================================================================
  // Boot
  // =======================================================================

  async boot() {
    const status = $('boot-status');
    try {
      status.textContent = '正在加载游戏数据…';
      State.data = await Api.data();

      status.textContent = '检查服务器状态…';
      await Api.health();

      status.textContent = '就绪';
      $('boot').classList.add('hidden');
      $('title').classList.remove('hidden');
      this.bindTitle();
      this.bindGlobal();
      this.ready = true;
    } catch (err) {
      status.textContent = `启动失败：${err.message}`;
      status.style.color = 'var(--danger)';
      toast(err.message, 'error', 8000);
    }
  },

  bindTitle() {
    const slider = $('start-level');
    const out = $('start-level-out');
    slider.addEventListener('input', () => { out.textContent = slider.value; });

    for (const btn of document.querySelectorAll('#title [data-action]')) {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'new-game') this.newGame(parseInt(slider.value, 10));
        else if (action === 'show-help') this.openHelp();
      });
    }
  },

  async newGame(level) {
    try {
      const res = await Api.newSession({ level });
      State.sessionId = res.view.sessionId;
      State.view = res.view;
      State.purchased = [];
      $('title').classList.add('hidden');
      $('app').classList.remove('hidden');
      this.route();
      toast(`开始新游戏 · 队伍等级 ${level}`, 'good');
    } catch (err) {
      toast(`无法开始游戏：${err.message}`, 'error');
    }
  },

  // =======================================================================
  // Routing
  // =======================================================================

  /** Show the screen the server's mode implies, and render it. */
  route() {
    const view = State.view;
    if (!view) return;
    const mode = view.mode;

    if (mode === 'battle') {
      this.showScreen('screen-battle');
      BattleUI.render(view.battle || view);
      BattleUI.renderUltAlert(view.battle || view);
      return;
    }

    if (mode === 'game_over' || mode === 'victory') {
      this.showResult(view.lastResult, mode);
      return;
    }

    this.showScreen('screen-world');
    WorldUI.render(view);
  },

  showScreen(id) {
    for (const screen of SCREENS) {
      $(screen).classList.toggle('hidden', screen !== id);
    }
  },

  showBattle() {
    this.showScreen('screen-battle');
    BattleUI.reset();
  },

  // =======================================================================
  // Battle driving
  // =======================================================================

  /**
   * Ask the server to advance until it needs input.
   *
   * `busy` guards against the player clicking twice during the animation; the
   * server would refuse the second command anyway, but a toast saying "not your
   * turn" for a legitimate double-click is bad feedback.
   */
  async stepBattle() {
    if (!State.sessionId) return;
    Runtime.busy = true;
    try {
      const res = await Api.step(State.sessionId);
      State.view = res.view;
      await BattleUI.consume(res.result);
    } catch (err) {
      toast(err.message, 'error');
      await this.refresh();
    } finally {
      Runtime.busy = false;
      if (State.view && State.view.mode === 'battle') {
        BattleUI.updateCommands();
      }
    }
  },
  /** Pull authoritative state and re-render. Used after any refusal. */
  async refresh() {
    if (!State.sessionId) return;
    try {
      const res = await Api.state(State.sessionId);
      State.view = res.view;
      this.route();
    } catch (err) {
      // A missing session means the server restarted; send them to the title.
      if (err.reason === 'noSession') {
        toast('服务器已重启，会话失效。请重新开始。', 'error', 6000);
        $('app').classList.add('hidden');
        $('title').classList.remove('hidden');
        State.sessionId = null;
      }
    }
  },

  // =======================================================================
  // Story
  // =======================================================================

  /**
   * Boss prologue text. One page at a time, dismissed with a click, then the
   * fight starts — the standard JRPG "the villain says a line, then combat".
   */
  showStory(story) {
    const lines = story.text || [];
    let index = 0;
    const body = el('div', {
      style: { textAlign: 'center', padding: '20px 0', minHeight: '140px', display: 'grid', placeItems: 'center' },
    });

    const render = () => {
      swap(body, el('p', {
        text: lines[index],
        style: { fontSize: '19px', lineHeight: '1.9', maxWidth: '46ch', animation: 'fade-up .4s ease-out both' },
      }));
    };
    render();

    const advance = async () => {
      index++;
      if (index < lines.length) {
        render();
        return;
      }
      Modal.close();
      await this.continueStory();
    };

    Modal.open(story.title, el('div', null, [
      body,
      el('div.row', { style: { justifyContent: 'center', marginTop: '10px' } }, [
        el('button.btn.btn-primary', { onclick: advance },
          index < lines.length - 1 ? '继续 →' : '⚔ 开战'),
      ]),
      el('p.muted', {
        text: lines.length > 1 ? `（${index + 1} / ${lines.length}）` : '',
        style: { textAlign: 'center', marginTop: '12px', fontSize: '11px' },
      }),
    ]));
  },

  async continueStory() {
    try {
      const res = await Api.continueStory(State.sessionId);
      State.view = res.view;
      const result = res.result || {};
      if (result.entry === 'encounter') {
        BattleUI.reset();
        this.showBattle();
        if (State.view.battle) {
          BattleUI.render(State.view.battle);
        }
        await this.stepBattle();
        return;
      }
      this.route();
    } catch (err) {
      toast(err.message, 'error');
      await this.refresh();
    }
  },

  // =======================================================================
  // Result
  // =======================================================================

  showResult(result, mode) {
    if (!result) {
      // `acknowledge` already ran; fall back to whatever the view says.
      this.route();
      return;
    }
    this.showScreen('screen-result');
    const won = result.won;
    const isFinal = won && result.isBoss;

    const rows = (result.partyAfter || []).map((m) => {
      const fallen = (result.fallen || []).some((f) => f.charId === m.charId);
      const isMvp = result.mvp && result.mvp.id === m.charId;
      return el('div.result-row', { class: fallen ? 'is-down' : null }, [
        el('div.row', null, [
          el('span', { text: m.name }),
          isMvp ? el('span.result-mvp', { text: '★ MVP' }) : null,
          fallen ? el('span.tag', { text: '倒下', style: { color: 'var(--danger)' } }) : null,
        ]),
        el('span.mono', {
          text: fallen ? '—' : `Lv${m.level} · ${Fmt.compact(m.hp)} HP`,
          style: { fontSize: '11px', color: 'var(--text-faint)' },
        }),
      ]);
    });

    const levelUpBox = (result.levelUps && result.levelUps.length)
      ? el('div.levelup-box', null, [
        el('div.levelup-line', { text: '⬆ 等级提升！' }),
        ...result.levelUps.map((lv) => el('div', null, [
          el('div.levelup-line', { text: `${lv.name} → Lv ${lv.level}` }),
          el('div.levelup-deltas', {
            text: `生命 +${lv.deltas.maxHp}  攻击 +${lv.deltas.atk}  防御 +${lv.deltas.def}  速度 +${lv.deltas.spd}`,
          }),
        ])),
      ])
      : null;

    const card = el('div.result-card', null, [
      el('div.result-title', {
        class: won ? 'is-win' : 'is-lose',
        text: isFinal ? '制 压 完 成' : won ? '胜 利' : '全 灭',
      }),
      el('div.result-sub', {
        text: isFinal ? 'STARFALL CHRONICLE · CLEARED' : won ? 'VICTORY' : 'DEFEAT',
      }),

      el('div.result-stats', null, [
        el('div.result-stat', null, [
          el('div.result-stat-val', { text: `+${Fmt.num(result.exp)}` }),
          el('div.result-stat-label', { text: '经验 / EXP' }),
        ]),
        el('div.result-stat', null, [
          el('div.result-stat-val', { text: `+${Fmt.num(result.gold)}` }),
          el('div.result-stat-label', { text: '金币 / GOLD' }),
        ]),
        el('div.result-stat', null, [
          el('div.result-stat-val', { text: String(result.rounds) }),
          el('div.result-stat-label', { text: '回合 / ROUNDS' }),
        ]),
      ]),

      isFinal ? el('p', {
        text: '灰烬之王倒下了。旧都的风里第一次没有焦味。',
        style: { color: 'var(--gold)', marginBottom: '18px', fontStyle: 'italic' },
      }) : null,

      levelUpBox,

      el('div.result-party', null, rows),

      el('div.row', { style: { justifyContent: 'center', gap: '10px' } }, [
        el('button.btn.btn-primary', {
          onclick: async () => {
            try {
              const res = await Api.acknowledge(State.sessionId);
              State.view = res.view;
              this.route();
              if (State.view.mode === 'town') toast('回到避风港，全员恢复。', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, won ? '继续冒险' : '重整旗鼓'),
      ]),
    ]);

    swap($('result-card'), card);
  },

  // =======================================================================
  // Help
  // =======================================================================

  openHelp() {
    Modal.open('玩法说明 / HOW TO PLAY', el('div', null, [
      el('div.help-section', null, [
        el('h3', { text: '战斗流程（参考《崩坏：星穹铁道》）' }),
        el('ul', null, [
          el('li', { text: '顶部「行动顺序」是你需要盯的地方。速度越高，行动越频繁。' }),
          el('li', { text: '普攻回复 1 点战技点，战技消耗 1 点。战技点全队共享，上限 5。' }),
          el('li', { text: '每名敌人有「韧性条」。用它的弱点属性攻击才能高效削韧，韧性归零即「击破」。' }),
          el('li', { text: '击破会：造成额外伤害、把敌人的行动推后、并让它失去增益。这是本作最主要的节奏手段。' }),
          el('li', { text: '能量满时，右下角会弹出终结技提示。按 Q 或点击提示，可以在我方回合之外插入终结技——不消耗回合。' }),
          el('li', { text: '防御可以减伤 40%。逃跑有 70% 成功率，Boss 战无法逃跑。' }),
        ]),
      ]),
      el('div.help-section', null, [
        el('h3', { text: '属性与弱点' }),
        el('p', {
          text: '属性共 7 种：物理 / 火 / 冰 / 雷 / 风 / 量子 / 虚数。敌人卡片下方的图标就是它的弱点，'
            + '高亮表示你的队伍里有这个属性。打非弱点属性也能削韧，但效率只有一半。',
        }),
      ]),
      el('div.help-section', null, [
        el('h3', { text: '队伍与角色' }),
        el('table.help-table', null, [
          el('tr', null, [el('th', { text: '角色' }), el('th', { text: '定位' }), el('th', { text: '玩法' })]),
          el('tr', null, [el('td', { text: '苍叶' }), el('td', { text: '风 · 击破手' }),
            el('td', { text: '三段连斩高削韧，击破后自己行动提前，越打越快' })]),
          el('tr', null, [el('td', { text: '御巫铃' }), el('td', { text: '火 · 减益' }),
            el('td', { text: '叠灼烧与炼金印记，每次命中都会引爆印记追加伤害' })]),
          el('tr', null, [el('td', { text: '神代凛' }), el('td', { text: '冰 · 控制' }),
            el('td', { text: '群体冻结与减速；冻结会返还能量，能连发终结技' })]),
          el('tr', null, [el('td', { text: '白鸦' }), el('td', { text: '雷 · 节奏' }),
            el('td', { text: '大幅推条与自身加速；终结技按目标身上的减益层数增伤' })]),
          el('tr', null, [el('td', { text: '艾莉丝' }), el('td', { text: '虚数 · 辅助' }),
            el('td', { text: '治疗、解debuff、护盾、全队增伤，残血队友自动获得「不屈」' })]),
        ]),
      ]),
      el('div.help-section', null, [
        el('h3', { text: '快捷键' }),
        el('p', null, [
          el('kbd', { text: '1' }), ' 普攻   ',
          el('kbd', { text: '2' }), ' 战技   ',
          el('kbd', { text: '3' }), ' 终结技   ',
          el('kbd', { text: 'Q' }), ' 插入终结技   ',
          el('kbd', { text: 'Space' }), ' 推进 / 继续   ',
          el('kbd', { text: 'Esc' }), ' 取消选择 / 关闭窗口',
        ]),
      ]),
      el('div.help-section', null, [
        el('h3', { text: '进度提示' }),
        el('p', {
          text: '队伍平均等级达到 10 才能进入「灰烬王座」。Boss 有二阶段：'
            + '生命降到 50% 时会换弱点（追加风属性）、清除小怪并强化自身，同时释放蓄力的全屏「烬灭新星」。'
            + '在它攒够 3 层「劫火印记」之前想办法击破它，是新星伤害最低的时候。',
        }),
      ]),
    ]));
  },

  // =======================================================================
  // Global bindings
  // =======================================================================

  bindGlobal() {
    // Modal close
    for (const node of document.querySelectorAll('[data-action="close-modal"]')) {
      node.addEventListener('click', () => Modal.close());
    }
    for (const node of document.querySelectorAll('[data-action="cancel-target"]')) {
      node.addEventListener('click', () => BattleUI.cancelTarget());
    }
    for (const node of document.querySelectorAll('[data-nav="help"]')) {
      node.addEventListener('click', () => this.openHelp());
    }

    // Hotkeys. Bound on document so they work regardless of focus, which
    // matters because the player clicks unit cards and buttons constantly.
    document.addEventListener('keydown', (ev) => {
      // Never steal keys from a real input.
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (ev.key === 'Escape') {
        if (State.pendingCommand) { BattleUI.cancelTarget(); return; }
        if (Modal.isOpen) { Modal.close(); return; }
        return;
      }

      if (!State.sessionId || !State.view) return;
      const inBattle = State.view.mode === 'battle';

      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        if (Modal.isOpen) return;
        if (!inBattle) {
          // Space on the world screen enters the node, which is the most
          // common action there.
          WorldUI.enterNode('explore');
        }
        return;
      }

      if (!inBattle || Runtime.busy) return;
      const actor = State.activeActor;
      if (!actor) return;

      if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
        ev.preventDefault();
        const want = { 1: 'basic', 2: 'skill', 3: 'ultimate' }[ev.key];
        const skill = (actor.skills || []).find((s) => s.kind === want);
        if (!skill) { toast('该角色没有这个技能'); return; }
        if (!skill.usable || !skill.affordable || !skill.charged) {
          toast(want === 'skill' ? '战技点不足' : want === 'ultimate' ? '能量尚未充满' : '当前无法使用', 'error');
          return;
        }
        BattleUI.chooseSkill(skill);
        return;
      }

      if (ev.key === 'q' || ev.key === 'Q') {
        ev.preventDefault();
        const view = State.view.battle || State.view;
        const charged = (view.allies || []).find((a) => a.alive && a.ultimateReady);
        if (!charged) { toast('目前没有充能完毕的终结技', 'error'); return; }
        const ult = (charged.skills || []).find((s) => s.kind === 'ultimate');
        if (ult) BattleUI.chooseUltimate(charged, ult);
      }
    });
  },
};

// ===========================================================================
// Start
// ===========================================================================

window.addEventListener('DOMContentLoaded', () => {
  Main.boot();
});

// A reload mid-battle is recoverable: the session lives on the server, so try
// to reattach rather than forcing a new game.
window.addEventListener('beforeunload', () => {
  // Nothing to persist client-side; the server holds the session.
});
