'use strict';

/**
 * Battle presentation.
 *
 * The server owns the battle; this file's whole job is to turn an event batch
 * into something that reads like a fight. Three things make that work:
 *
 *   1. **Event-driven animation.** The server returns the exact events since the
 *      last call, in order. This module replays them one at a time with a short
 *      delay, so a three-hit skill shows three separate numbers instead of one
 *      aggregated pile.
 *   2. **Optimistic-but-correct state.** After the animation finishes, the view
 *      is re-rendered from the server's authoritative state. Animations may lag
 *      or be skipped (`prefers-reduced-motion`, a slow tab) and the numbers still
 *      end up right.
 *   3. **No rules.** Every legality question ("can this unit afford the skill?")
 *      comes from the view the server sent. This file never decides anything.
 */

/** Milliseconds between replayed events. Tuned to feel snappy, not sluggish. */
const BATTLE_PACING = {
  perEvent: 190,
  beforeCast: 120,
  afterBatch: 160,
  reducedMotion: 10,
};

function pace(key) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduced ? BATTLE_PACING.reducedMotion : BATTLE_PACING[key];
}

const BattleUI = {
  /** uid -> DOM node, rebuilt each render so animation classes can be re-added. */
  unitNodes: new Map(),
  /** Queue of pending float animations, so they do not all land at once. */
  _floatQueue: [],

  // =======================================================================
  // Rendering
  // =======================================================================

  render(view) {
    // Accept either shape: the game view (battle under `.battle`) or a bare
    // battle view. Resolving here means every renderer below can assume the
    // latter, which is the shape it actually needs.
    const battle = (view && view.battle) ? view.battle : view;
    if (!battle) return;
    this.renderTimeline(battle);
    this.renderField(battle);
    this.renderSkillPoints(battle);
    this.renderCommands(battle);
  },

  /**
   * The turn order timeline.
   *
   * The first entry is the unit about to act; everything after is the forecast.
   * Broken and down units are dimmed because they cost the party nothing to
   * ignore, which is exactly the information the player needs.
   */
  renderTimeline(view) {
    const track = $('timeline-track');
    const order = view.order || [];
    const actorUid = State.activeActor ? State.activeActor.uid : null;

    const items = order.map((entry, index) => {
      const isCurrent = index === 0 && entry.uid === actorUid;
      const sprite = this.spriteFor(entry.id, entry.side, view);
      return el('div.tl-item', {
        class: [
          entry.side === 'enemy' ? 'side-enemy' : 'side-ally',
          isCurrent ? 'is-current' : null,
          entry.broken ? 'is-broken' : null,
        ].filter(Boolean).join(' '),
        title: `${entry.name}${entry.broken ? '（已击破）' : ''}`,
      }, [
        el('span.tl-index', { text: index + 1 }),
        el('div.tl-icon', { text: sprite.icon, style: { color: sprite.color } }),
        el('div.tl-name', { text: entry.name }),
      ]);
    });

    swap(track, items);
  },

  /** Both sides, plus the floating layer stays untouched between renders. */
  renderField(view) {
    // Accept either shape. `showTargetPrompt` and `cancelTarget` call this
    // directly with whatever they have to hand, and an earlier version passed
    // the *game* view here — whose `enemies` is undefined — which silently
    // replaced both sides with nothing. That is why clicking a skill made every
    // enemy disappear and left the player unable to pick a target.
    const battle = (view && view.battle) ? view.battle : view;
    if (!battle) return;

    this.unitNodes.clear();
    swap($('side-enemy'), (battle.enemies || []).map((u) => this.unitCard(u, battle, true)));
    swap($('side-ally'), (battle.allies || []).map((u) => this.unitCard(u, battle, false)));

    // Highlight whichever ally is choosing, so the eye lands on the right card.
    if (State.activeActor) {
      const node = this.unitNodes.get(State.activeActor.uid);
      if (node) node.classList.add('is-active');
    }
  },

  /**
   * One unit card.
   *
   * Layout, top to bottom: portrait, name + level, weakness pips, HP bar,
   * toughness bar (enemies), energy readout (allies), status chips. That order
   * is the order a player scans in: identity → what beats it → how alive it is →
   * what is on it.
   */
  unitCard(unit, view, isEnemy) {
    const sprite = this.spriteFor(unit.id, unit.side, view);
    const hpRatio = Math.max(0, Math.min(1, unit.hpRatio || 0));
    const lowClass = hpRatio <= 0.25 ? 'is-low' : hpRatio <= 0.5 ? 'is-mid' : '';

    const targetable = this.isTargetable(unit);

    const card = el('div.unit', {
      class: [
        isEnemy ? 'is-enemy' : 'is-ally',
        unit.alive ? null : 'is-down',
        unit.broken ? 'is-broken' : null,
        targetable ? 'is-targetable' : null,
      ].filter(Boolean).join(' '),
      dataset: { uid: unit.uid, side: unit.side },
      title: this.unitTooltip(unit, view),
      onclick: targetable ? (ev) => this.onUnitClick(unit, ev) : null,
    }, [
      el('div.unit-portrait', { style: { color: sprite.color } }, [
        sprite.icon,
        el('span.unit-el', { text: sprite.elementIcon, title: sprite.elementName }),
      ]),
      el('div.unit-name', { text: unit.name }),
      el('div.unit-lv', {
        text: unit.down ? '已倒下' : `Lv ${unit.level}`,
      }),

      // Weakness pips. A pip lights up if the *current party* can exploit it,
      // which turns "which enemy do I hit with whom" into a glance.
      isEnemy ? this.weaknessRow(unit, view) : null,

      el('div.bar.bar-hp', { class: lowClass }, [
        el('div.bar-fill', { style: { width: `${hpRatio * 100}%` } }),
        unit.shield > 0
          ? el('div.unit-shield', { style: { width: `${Math.min(100, (unit.shield / Math.max(1, unit.maxHp)) * 100)}%` } })
          : null,
      ]),
      el('div.battle-hpnum.mono', {
        text: `${Fmt.compact(unit.hp)} / ${Fmt.compact(unit.maxHp)}`,
        style: { fontSize: '10px', color: 'var(--text-faint)', marginTop: '3px' },
      }),

      isEnemy && unit.toughnessMax > 0
        ? el('div.bar-tough', { class: unit.broken ? 'is-broken' : null }, [
          el('div.bar-fill', { style: { width: `${(unit.toughness / Math.max(1, unit.toughnessMax)) * 100}%` } }),
        ])
        : null,

      !isEnemy
        ? el('div.energy-label', {
          class: unit.ultimateReady ? 'is-ready' : null,
          title: unit.ultimateReady ? '终结技已就绪：可随时插入' : '能量',
        }, [
          el('span', { text: unit.ultimateReady ? '⚡ 终结技就绪' : '能量' }),
          el('span', { text: `${Math.round(unit.energy)}/${Math.round(unit.maxEnergy)}` }),
        ])
        : null,

      (unit.statuses || []).length
        ? el('div.status-row', null, unit.statuses.filter((s) => !s.hidden).map(statusChip))
        : el('div.status-row'),
    ]);

    this.unitNodes.set(unit.uid, card);
    return card;
  },

  /** Weakness pips; covered pips are the ones the party can actually hit. */
  weaknessRow(unit, view) {
    const partyElements = new Set(
      (view.allies || []).flatMap((a) => (a.skills || []).map((s) => s.element)),
    );
    const all = (State.data && State.data.elements) ? Object.keys(State.data.elements) : [];
    const relevant = all.filter((id) =>
      (unit.weaknesses || []).includes(id) || (unit.resist && unit.resist[id] != null));
    // Show at least the party's own elements so the player can see a mismatch.
    const shown = relevant.length ? relevant : [...partyElements];

    return el('div.weakness-row', null, shown.map((elementId) => {
      const isWeak = (unit.weaknesses || []).includes(elementId);
      const covered = partyElements.has(elementId);
      const e = Fmt.element(elementId);
      return el('div.weak-pip', {
        class: [isWeak ? 'is-weak' : null, covered ? 'is-covered' : null].filter(Boolean).join(' '),
        text: e.icon,
        style: { color: isWeak ? Fmt.elementColor(elementId) : 'var(--text-faint)' },
        title: isWeak
          ? `弱点：${e.name}${covered ? '（队伍可以命中）' : '（队伍目前没有该属性）'}`
          : `${e.name}${unit.resist && unit.resist[elementId] != null ? '（被抵抗）' : ''}`,
      });
    }));
  },

  /** The sp pips, with the cost of the pending skill flashed. */
  renderSkillPoints(view) {
    const cost = State.pendingCost || 0;
    const pips = [];
    for (let i = 0; i < view.maxSkillPoints; i++) {
      const filled = i < view.skillPoints;
      // The pips that *would* be spent are the last `cost` filled ones.
      const spending = cost > 0 && i >= view.skillPoints - cost && i < view.skillPoints;
      pips.push(el('div.sp-pip', {
        class: [filled ? 'is-full' : null, spending ? 'is-spending' : null].filter(Boolean).join(' '),
      }));
    }
    swap($('sp-pips'), pips);
  },

  /**
   * The command buttons for the acting character.
   *
   * Two DOM rules worth stating, because both were bugs:
   *
   *   1. **Update the actor card in place.** `#actor-card`, `#actor-name` and
   *      `#actor-hp` are static elements in the HTML. Replacing the card's
   *      children (or the card itself) deletes those ids on the first render,
   *      so any code holding a reference to them — a test, a future animation —
   *      silently starts getting `null`. Only the *values* change here.
   *   2. **Buttons are rebuilt wholesale.** They are recreated every render
   *      because their disabled state derives from the current resources, and
   *      diffing them would be more code than it saves.
   */
  renderCommands(view) {
    const actor = State.activeActor && view.allies
      ? view.allies.find((a) => a.uid === State.activeActor.uid && a.alive)
      : null;

    if (!actor) {
      // Idle state: keep the card in place, blank it, and say why.
      const card = $('actor-card');
      if (card) card.classList.add('hidden');
      swap($('command-buttons'), el('div.muted', { text: '等待中…', style: { fontSize: '12px' } }));
      return;
    }

    const sprite = this.spriteFor(actor.id, 'ally', view);
    const card = $('actor-card');
    if (card) card.classList.remove('hidden');

    const avatar = $('actor-avatar');
    if (avatar) {
      avatar.textContent = sprite.icon;
      avatar.style.color = sprite.color;
    }
    const nameEl = $('actor-name');
    if (nameEl) nameEl.textContent = actor.name;
    const hpEl = $('actor-hp');
    if (hpEl) hpEl.style.width = `${Math.max(0, Math.min(1, actor.hpRatio || 0)) * 100}%`;

    const buttons = (actor.skills || [])
      .filter((s) => s.kind === 'basic' || s.kind === 'skill' || s.kind === 'ultimate')
      .map((s) => {
        // Legality comes straight from the server's view. `usable` already folds
        // in control statuses; `affordable` and `charged` are the resource gates.
        const disabled = !s.usable || !s.affordable || !s.charged || Runtime.busy;
        const costLabel = s.kind === 'skill' ? '1 战技点'
          : s.kind === 'ultimate' ? '能量满'
            : '回复 1 战技点';
        return el('button.cmd-btn', {
          class: [
            s.kind === 'ultimate' ? 'is-ultimate' : null,
            s.kind === 'ultimate' && s.charged ? 'is-charged' : null,
          ].filter(Boolean).join(' '),
          disabled,
          title: `${s.name}\n${s.desc}\n${costLabel}`,
          dataset: { skill: s.id, kind: s.kind },
          onclick: () => this.chooseSkill(s),
          onmouseenter: () => {
            State.pendingCost = s.kind === 'skill' ? (s.cost || 1) : 0;
            this.renderSkillPoints(view);
          },
          onmouseleave: () => {
            State.pendingCost = 0;
            this.renderSkillPoints(view);
          },
        }, [
          el('span.cmd-icon', { text: s.icon }),
          el('span.cmd-name', { text: s.name }),
          el('span.cmd-cost', { text: costLabel }),
        ]);
      });

    buttons.push(el('button.cmd-btn', {
      disabled: Runtime.busy,
      title: '防御：本回合受到的伤害 -40%，并获得少量能量。',
      onclick: () => this.submit({ type: 'defend' }),
    }, [
      el('span.cmd-icon', { text: '🛡' }),
      el('span.cmd-name', { text: '防御' }),
      el('span.cmd-cost', { text: '减伤 40%' }),
    ]));

    if (view.canFlee) {
      buttons.push(el('button.cmd-btn', {
        disabled: Runtime.busy,
        title: `逃跑：${Math.round((State.data && State.data.balance ? 0.7 : 0.7) * 100)}% 成功率。Boss 战无法逃跑。`,
        onclick: () => this.submit({ type: 'flee' }),
      }, [
        el('span.cmd-icon', { text: '🏃' }),
        el('span.cmd-name', { text: '逃跑' }),
        el('span.cmd-cost', { text: '70%' }),
      ]));
    }

    swap($('command-buttons'), buttons);
  },

  // =======================================================================
  // Targeting
  // =======================================================================

  /** Is `unit` a legal click target for the command awaiting a target? */
  isTargetable(unit) {
    const pending = State.pendingCommand;
    if (!pending || !unit.alive) return false;
    // The server's skill data says which side is legal; reuse it rather than
    // re-deriving, so the UI can never offer an illegal click.
    return pending.side === unit.side;
  },

  /** Begin choosing a skill: either submit immediately or wait for a target. */
  chooseSkill(skill) {
    if (Runtime.busy) return;
    const actor = State.activeActor;
    if (!actor) return;

    if (skill.kind === 'ultimate') {
      // Ultimates are queued rather than executed; that is the whole point of
      // the mechanic, so the UI must not treat them like a normal action.
      this.chooseUltimate(actor, skill);
      return;
    }

    const side = this.targetSideFor(skill);
    if (!side) {
      this.submit({ type: 'basic', skill: skill.id });
      return;
    }
    State.pendingCommand = { type: skill.kind === 'basic' ? 'basic' : 'skill', skillId: skill.id, side };
    this.showTargetPrompt(skill, side);
  },

  /** Ultimates can be fired by *any* charged ally, not just the acting one. */
  chooseUltimate(actor, skill) {
    const side = this.targetSideFor(skill, true) || 'enemy';
    State.pendingCommand = {
      type: 'ultimate',
      skillId: skill.id,
      side,
      unitId: actor.uid,
      queued: true,
    };
    this.showTargetPrompt(skill, side, true);
  },

  /**
   * Which side a skill targets. Beneficial skills hit allies; everything else
   * hits enemies. Mirrors `isBeneficialSelector` on the server — the duplication
   * is deliberate and narrow, because the client needs it to draw the prompt
   * *before* sending anything, and the server independently validates.
   */
  targetSideFor(skill, isUltimate) {
    if (skill.target === 'self' || skill.target === 'none') return null;
    if (skill.target === 'ally' || skill.target === 'allyAll') return 'ally';
    if (skill.target === 'aoe' || skill.target === 'blast' || skill.target === 'bounce') return 'enemy';
    if (skill.target === 'single') return 'enemy';
    return isUltimate ? 'enemy' : 'enemy';
  },

  showTargetPrompt(skill, side, isUltimate) {
    const overlay = $('target-overlay');
    const label = skill.target === 'aoe' ? '全体'
      : skill.target === 'blast' ? '主目标（波及相邻）'
        : side === 'ally' ? '选择队友' : '选择敌人';
    $('target-hint').textContent = `${skill.name} · ${label}（Esc 取消）`;
    overlay.classList.remove('hidden');
    State.pendingCost = skill.cost || 0;
    if (State.view) {
      this.renderField(State.view);
      this.renderSkillPoints(State.view);
    }
  },

  cancelTarget() {
    State.pendingCommand = null;
    State.pendingCost = 0;
    $('target-overlay').classList.add('hidden');
    if (State.view) {
      this.renderField(State.view);
      this.renderSkillPoints(State.view);
    }
  },

  onUnitClick(unit) {
    const pending = State.pendingCommand;
    if (!pending) return;

    // AoE skills do not need a specific target, but they do need *a* target so
    // the engine can compute blast neighbours and the bounce order.
    const cmd = {
      type: pending.type,
      skill: pending.skillId,
      target: unit.uid,
    };
    if (pending.type === 'ultimate') cmd.unit = pending.unitId;
    else cmd.unit = State.activeActor ? State.activeActor.uid : undefined;

    $('target-overlay').classList.add('hidden');
    State.pendingCommand = null;
    State.pendingCost = 0;
    this.submit(cmd);
  },

  // =======================================================================
  // Submitting
  // =======================================================================

  async submit(cmd) {
    if (Runtime.busy) return;
    Runtime.busy = true;
    try {
      const type = cmd.type;
      const payload = {
        session: State.sessionId,
        type,
        skill: cmd.skill,
        target: cmd.target,
        unit: cmd.unit,
      };
      const res = await Api.command(State.sessionId, payload);
      State.view = res.view;
      await this.consume(res.result);
    } catch (err) {
      toast(err.message, 'error');
      // Re-sync: the refusal may mean this client's view is stale.
      await Main.refresh();
    } finally {
      Runtime.busy = false;
      if (State.view && State.view.mode === 'battle') {
        this.updateCommands();
      }
    }
  },

  /** Fire a charged ultimate from the alert bar or a hotkey. */
  async fireUltimate(unitId, skillId, targetId) {
    if (Runtime.busy) return;
    Runtime.busy = true;
    try {
      const res = await Api.ultimate(State.sessionId, unitId, skillId, targetId);
      State.view = res.view;
      await this.consume(res.result);
    } catch (err) {
      toast(err.message, 'error');
      await Main.refresh();
    } finally {
      Runtime.busy = false;
      if (State.view && State.view.mode === 'battle') this.updateCommands();
    }
  },

  /**
   * Refresh the command panel from the current battle state.
   *
   * Called after every settle. Reads the battle view explicitly rather than
   * assuming `State.view` is one, and bails out when the fight is over so the
   * result screen is not overwritten by a stale command panel.
   */
  updateCommands() {
    const battle = this.battleView();
    if (!battle || !State.view || State.view.mode !== 'battle') return;
    this.renderCommands(battle);
    this.renderUltAlert(battle);
  },

  // =======================================================================
  // Event replay — the animation layer
  // =======================================================================

  /**
   * Play a batch of events one at a time, then settle on the final state.
   *
   * The loop is intentionally serial: `await` each animation before starting the
   * next one. Parallelising would make a 3-hit skill look like one big hit and
   * destroy the readability of the break sequence.
   *
   * --- The two "views" and why this is careful about them ---
   *
   * The server sends two different objects that both happen to have `mode` and
   * `allies` fields:
   *
   *   `view`          the *game* view: { mode, node, party, battle, ... }, where
   *                   the battle lives under `view.battle`
   *   `result.state`  the *battle* view: { mode: 'battle', allies, enemies, ... }
   *
   * An earlier version merged `result.state` into `State.view` with
   * `Object.assign`, which put `allies`/`enemies` at the top level and left
   * `view.battle` stale. Every renderer reads `view.battle`, so the field drew
   * the old turn's HP and the command panel's actor lookup returned null — the
   * battle looked frozen while the server was actually progressing fine.
   *
   * The fix is to keep `State.view` as the *game* view at all times and write the
   * battle state into `view.battle`. One shape, one place.
   */
  async consume(result) {
    if (!result) return;

    if (result.events && result.events.length) {
      await this.playEvents(result.events);
    }

    if (result.finished) {
      State.lastEvents = [];
      Main.showResult(result.result);
      return;
    }

    // Settle: fold the authoritative battle state into the game view's `battle`
    // slot, preserving everything else the game view carries.
    if (result.state) {
      State.view = State.view || {};
      State.view.battle = result.state;
      if (!State.view.mode || State.view.mode === 'battle') State.view.mode = 'battle';
    }
    if (result.actor) State.activeActor = result.actor;

    this.render(State.view.battle || State.view);
    this.renderUltAlert(State.view.battle || State.view);
  },

  /** Replay an event array with pacing, applying visual effects as we go. */
  async playEvents(events) {
    for (const event of events) {
      const delay = this.applyEvent(event);
      await sleep(delay);
    }
    await sleep(pace('afterBatch'));
  },

  /**
   * Apply one event's visual effect and return how long to wait afterwards.
   *
   * Returning the delay from the same function that mutates the DOM is what
   * keeps the two in sync: there is no separate "timing table" to drift out of
   * date when a new event kind is added.
   */
  applyEvent(event) {
    const kind = event.kind;

    switch (kind) {
      case 'skill.cast': {
        this.log(`${event.name} → ${event.skillName}`, 'hl-info');
        this.animateActor(event.uid, 'is-attacking');
        // A defensive stance or a boss's phase change gets the full-screen flash;
        // an ordinary action does not, so ordinary turns stay readable.
        if (event.skillKind === 'ultimate' || event.forFree) this.flashScreen();
        // The skill-point pip is about to be spent. `renderSkillPoints` accepts
        // either view shape, so passing the current one is safe either way.
        State.pendingCost = event.skillKind === 'skill' ? 1 : 0;
        if (State.view) this.renderSkillPoints(State.view);
        return pace('beforeCast');
      }

      case 'skill.failed':
        this.log(`${event.uid} 无法行动（${event.reason}）`, 'hl-info');
        return 90;

      case 'combat.damage': {
        const target = this.unitNodes.get(event.targetId);
        const source = this.unitNodes.get(event.sourceId);
        const isCrit = !!event.crit;
        const isWeak = !!event.weakness;

        if (event.shielded) {
          this.float(event.targetId, `🛡 ${event.shieldAbsorbed}`, 'shield');
          flash(target, 'is-hurt', 260);
          return 110;
        }

        if (event.isDot) {
          this.float(event.targetId, `${event.amount}`, 'dmg-ally');
          flash(target, 'is-hurt', 260);
          this.log(`${this.nameOf(event.targetId)} 受到 ${event.amount} 点持续伤害`, 'hl-damage');
          return 150;
        }

        const cls = isCrit ? 'crit' : (isWeak ? 'weak' : (event.targetId === source ? 'dmg-ally' : 'dmg-enemy'));
        // Multiple numbers from one skill need to fan out, or a 3-hit combo
        // stacks three numbers on the same pixel.
        this.float(event.targetId, `${event.amount}${isCrit ? '!' : ''}`, cls, this._hitIndex++);
        flash(target, 'is-hurt', 300);
        if (isCrit) this.log(`暴击 ${event.amount}！`, 'hl-damage');
        else if (isWeak) this.log(`弱点命中 ${event.amount}`, 'hl-damage');
        else this.log(`${this.nameOf(event.sourceId)} → ${this.nameOf(event.targetId)} ${event.amount}`, 'hl-damage');
        return isCrit ? 220 : 150;
      }

      case 'combat.crit':
        // Already surfaced by the damage event's own `crit` flag; keep the
        // timing consistent without double-logging.
        return 0;

      case 'combat.weakness':
        return 0;

      case 'combat.toughness': {
        // The toughness bar is updated by the next full render; the flash here
        // is what makes the chip visible in the moment.
        this.log(`韧性 -${event.amount}（${event.toughness}/${event.toughnessMax}）`, 'hl-info');
        return 80;
      }

      case 'combat.break': {
        this.log(`⚡ 击破 ${event.name}！韧性归零，行动被推后`, 'hl-break');
        this.float(event.targetId, 'BREAK!', 'break');
        flash(this.unitNodes.get(event.targetId), 'is-broken', 900);
        this.shakeScreen();
        return 420;
      }

      case 'combat.breakRecover':
        this.log(`${event.name} 恢复了韧性`);
        return 90;

      case 'combat.heal':
        this.float(event.targetId, `+${event.amount}`, 'heal');
        this.log(`${this.nameOf(event.targetId)} 回复 ${event.amount}`, 'hl-heal');
        return 150;

      case 'status.applied':
        this.log(`${this.nameOf(event.uid)} 获得「${event.name}」${event.stacks > 1 ? ` ×${event.stacks}` : ''}`);
        return 70;

      case 'status.resisted':
        this.log(`${this.nameOf(event.uid)} 抵抗了「${event.name}」`, 'hl-info');
        return 70;

      case 'status.tick': {
        if (event.amount) {
          this.float(event.uid, `${event.amount}`, 'dmg-ally');
          this.log(`${event.name || event.status} 造成 ${event.amount}`, 'hl-damage');
          return 150;
        }
        if (event.message) {
          this.log(event.message, 'hl-info');
          return 120;
        }
        return 60;
      }

      case 'status.expired':
        return 40;

      case 'resource.skillPoint': {
        const sign = event.amount > 0 ? '+' : '';
        this.log(`战技点 ${sign}${event.amount}（${event.total}）`, 'hl-info');
        return 90;
      }

      case 'resource.energy':
        return 30;

      case 'ultimate.ready':
        this.log(`⚡ ${event.name} 的终结技已就绪！`, 'hl-break');
        toast(`${event.name} 的终结技已就绪 — 随时可以插入`, 'good', 1500);
        flash(this.unitNodes.get(event.uid), 'is-active', 700);
        return 260;

      case 'ultimate.cast':
        this.log(`✦ ${event.name} 释放终结技！`, 'hl-break');
        this.flashScreen();
        this.shakeScreen();
        return 320;

      case 'unit.down': {
        this.log(`${event.name} 倒下了`, 'hl-down');
        flash(this.unitNodes.get(event.uid), 'is-down', 800);
        return 300;
      }

      case 'unit.revived':
        this.log(`${event.name} 复活了（${event.hp} HP）`, 'hl-heal');
        return 300;

      case 'unit.summoned': {
        this.log(`${event.name} 出现！`, 'hl-info');
        return 260;
      }

      case 'order.delay':
        this.log(`${event.name} 行动被推后 ${event.amount}`, 'hl-info');
        return 90;

      case 'order.advance':
        this.log(`${event.name} 行动提前 ${event.amount}`);
        return 70;

      case 'order.extraTurn':
        this.log(`${event.name} 获得额外行动！`, 'hl-break');
        return 240;

      case 'enemy.phase': {
        this.log(`【阶段转换】${event.name} → ${event.phaseName}`, 'hl-break');
        if (event.dialogue) this.dialogue(event.name, event.dialogue);
        this.flashScreen();
        this.shakeScreen();
        return 900;
      }

      case 'narrative.dialogue':
        this.dialogue(event.speaker, event.text);
        return 600;

      case 'narrative.warning':
        this.log(`⚠ ${event.message}`, 'hl-break');
        return 260;

      case 'narrative.info':
        this.log(event.message || '', 'hl-info');
        return event.kind === 'ultimateInterrupt' ? 320 : 100;

      case 'battle.start':
        this.log(`战斗开始：${event.name}`, 'hl-info');
        return 120;

      default:
        // An unknown event must never stall the replay.
        return 0;
    }
  },

  // =======================================================================
  // Visual effects
  // =======================================================================

  /**
   * Spawn a floating number over a unit.
   *
   * Positions are randomised inside the unit card's box and fanned horizontally
   * by `spread`, so a multi-hit skill produces a readable column of numbers
   * instead of one illegible blob.
   */
  float(uid, text, className, spread = 0) {
    const node = this.unitNodes.get(uid);
    const layer = $('float-layer');
    if (!layer) return;
    if (!node) {
      // The unit may not be on screen yet (a summon mid-batch). Fall back to a
      // centred position so the number is still shown.
      const fallback = el('div.float-num', {
        text, class: className,
        style: { left: '50%', top: '45%' },
      });
      layer.appendChild(fallback);
      setTimeout(() => fallback.remove(), 1200);
      return;
    }
    const field = $('battle-field').getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const jitterX = ((spread % 5) - 2) * 17 + (Math.random() * 16 - 8);
    const jitterY = (Math.random() * 18 - 9);

    const fx = el('div.float-num', {
      text,
      class: className,
      style: {
        left: `${box.left - field.left + box.width / 2 + jitterX}px`,
        top: `${box.top - field.top + box.height * 0.42 + jitterY}px`,
      },
    });
    layer.appendChild(fx);
    setTimeout(() => fx.remove(), 1200);
  },

  /** Re-trigger an animation class on a unit card. */
  animateActor(uid, className) {
    const node = this.unitNodes.get(uid);
    if (node) flash(node, className, 480);
  },

  /** Full-screen flash, used for ultimates and phase changes. */
  flashScreen() {
    const layer = $('float-layer');
    if (!layer) return;
    const f = el('div', {
      style: {
        position: 'absolute', inset: '0',
        background: 'radial-gradient(ellipse at center, rgba(255,255,255,.22), transparent 70%)',
        pointerEvents: 'none',
        animation: 'hurt-flash .35s ease-out forwards',
        zIndex: '40',
      },
    });
    layer.appendChild(f);
    setTimeout(() => f.remove(), 400);
  },

  shakeScreen() {
    const field = $('battle-field');
    if (!field) return;
    field.style.animation = 'none';
    void field.offsetWidth;
    field.style.animation = 'broken-shake .38s ease-out';
    setTimeout(() => { field.style.animation = ''; }, 420);
  },

  /** A dialogue box for boss lines, shown over the field briefly. */
  dialogue(speaker, text) {
    const layer = $('float-layer');
    if (!layer) return;
    const box = el('div', {
      style: {
        position: 'absolute',
        left: '50%',
        bottom: '12%',
        transform: 'translateX(-50%)',
        maxWidth: '72%',
        padding: '12px 24px',
        background: 'rgba(10,8,12,.94)',
        border: '1px solid rgba(255,107,74,.55)',
        borderRadius: '8px',
        textAlign: 'center',
        zIndex: '45',
        animation: 'fade-up .3s ease-out both',
      },
    }, [
      el('div', {
        text: speaker,
        style: { fontSize: '11px', letterSpacing: '.2em', color: 'var(--enemy)', marginBottom: '5px' },
      }),
      el('div', { text, style: { fontSize: '15px', lineHeight: '1.6' } }),
    ]);
    layer.appendChild(box);
    setTimeout(() => {
      box.style.transition = 'opacity .3s';
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 320);
    }, 1700);
  },

  /** Append a line to the battle log, keeping only the last few. */
  log(text, cls) {
    if (!text) return;
    const line = el('div.log-line', { text, class: cls || null });
    const box = $('battle-log');
    box.appendChild(line);
    while (box.children.length > 4) box.firstChild.remove();
  },

  clearLog() {
    swap($('battle-log'), null);
  },

  // =======================================================================
  // Helpers
  // =======================================================================

  /**
   * The ultimate-interrupt prompt.
   *
   * This bar is the most HSR-flavoured piece of UI in the project: it appears
   * the instant *any* ally's gauge fills, and clicking it fires that ultimate
   * without waiting for their turn. Only the first charged ally is offered, so
   * the button has unambiguous meaning.
   */
  renderUltAlert(view) {
    const alert = $('ult-alert');
    const charged = (view.allies || []).filter((a) => a.alive && a.ultimateReady);
    if (!charged.length) {
      alert.classList.add('hidden');
      return;
    }
    const hero = charged[0];
    const sprite = this.spriteFor(hero.id, 'ally', view);
    $('ult-alert-text').textContent = `${hero.name} 终结技就绪（${charged.length} 人）`;
    alert.classList.remove('hidden');
    alert.onclick = () => {
      const ult = (hero.skills || []).find((s) => s.kind === 'ultimate');
      if (!ult) return;
      this.chooseUltimate(hero, ult);
    };
  },

  /** Look up a unit's display identity from static data, with a fallback. */
  spriteFor(id, side, view) {
    const data = State.data || {};
    const chars = data.characters || [];
    const enemies = data.enemies || [];
    const baseId = String(id).split('_').slice(0, -1).join('_') || id;

    const char = chars.find((c) => c.id === id) || chars.find((c) => c.id === baseId);
    if (char) {
      return {
        icon: char.name.slice(0, 1),
        color: char.color || Fmt.elementColor(char.element),
        elementIcon: Fmt.element(char.element).icon,
        elementName: Fmt.element(char.element).name,
      };
    }
    const enemy = enemies.find((e) => e.id === id) || enemies.find((e) => e.id === baseId);
    if (enemy) {
      return {
        icon: enemy.name.slice(0, 1),
        color: enemy.color || 'var(--enemy)',
        elementIcon: '☠',
        elementName: '敌方',
      };
    }
    return {
      icon: '?',
      color: side === 'enemy' ? 'var(--enemy)' : 'var(--ally)',
      elementIcon: '·',
      elementName: '',
    };
  },

  /**
   * Turn a unit uid into its display name, for log lines.
   *
   * Reads through `battleView()` rather than `State.view` because the two are
   * different shapes; see the note on `consume`.
   */
  nameOf(uid) {
    if (!uid) return '?';
    const battle = this.battleView();
    if (!battle) return uid;
    const found = [...(battle.allies || []), ...(battle.enemies || [])].find((u) => u.uid === uid);
    return found ? found.name : uid;
  },

  /**
   * The current *battle* view, whichever shape `State.view` is in.
   *
   * `State.view` is normally the game view (with `.battle`), but during boot and
   * in a few tests it can be a bare battle view. Resolving it in one place means
   * no renderer has to know which it got.
   */
  battleView() {
    const v = State.view;
    if (!v) return null;
    if (v.battle) return v.battle;
    return Array.isArray(v.enemies) ? v : null;
  },

  /** Rich tooltip for a unit card. */
  unitTooltip(unit, view) {
    const lines = [unit.name, `Lv ${unit.level}`, `HP ${Math.round(unit.hp)} / ${Math.round(unit.maxHp)}`];
    if (unit.toughnessMax > 0) {
      lines.push(`韧性 ${unit.toughness} / ${unit.toughnessMax}${unit.broken ? '（已击破）' : ''}`);
    }
    if (unit.weaknesses && unit.weaknesses.length) {
      lines.push(`弱点：${unit.weaknesses.map((w) => Fmt.element(w).name).join('、')}`);
    }
    if (unit.statuses && unit.statuses.length) {
      lines.push('', ...unit.statuses.map((s) => `${s.icon} ${s.name}${s.stacks > 1 ? ` ×${s.stacks}` : ''}`));
    }
    return lines.join('\n');
  },

  /** Reset per-battle visual state. */
  reset() {
    this.unitNodes.clear();
    this._hitIndex = 0;
    this.clearLog();
    State.activeActor = null;
    State.pendingCommand = null;
    State.pendingCost = 0;
    $('target-overlay').classList.add('hidden');
    $('ult-alert').classList.add('hidden');
    // Clear the command panel so a new fight never briefly shows the previous
    // fight's actor.
    const card = $('actor-card');
    if (card) card.classList.add('hidden');
    const nameEl = $('actor-name');
    if (nameEl) nameEl.textContent = '—';
    swap($('command-buttons'), el('div.muted', { text: '准备中…', style: { fontSize: '12px' } }));
  },
};

BattleUI._hitIndex = 0;

/** Promise-based sleep; the animation loop's only timing primitive. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
