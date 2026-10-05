'use strict';

/**
 * Shared UI helpers: DOM building, element lookup, toasts, modals.
 *
 * Everything visual in this project is built with these helpers rather than
 * `innerHTML` string concatenation. Two reasons that matter here:
 *
 *   1. **Safety.** Enemy names, skill names and story text all reach the DOM.
 *      Building nodes means there is no path where content becomes markup, so
 *      a character named `<script>` is impossible rather than merely unlikely.
 *   2. **Refs.** `replaceChildren` + a builder keeps re-renders cheap: the
 *      battle screen rebuilds its unit cards on every event batch, and doing
 *      that with innerHTML would drop the CSS transitions that carry the feel.
 */

/** Shorthand for `document.getElementById`. */
const $ = (id) => document.getElementById(id);

/**
 * Create an element.
 *
 * @param {string} tag           tag name, optionally with `.class` / `#id`
 * @param {object} [attrs]       attributes; `class`, `style`, `dataset` handled
 * @param {Array|string|Node} [children]
 */
function el(tag, attrs, children) {
  let name = tag;
  const classes = [];
  const idMatch = name.match(/#([\w-]+)/);
  if (idMatch) {
    attrs = { id: idMatch[1], ...attrs };
    name = name.replace(/#[\w-]+/, '');
  }
  for (const m of name.matchAll(/\.([\w-]+)/g)) classes.push(m[1]);
  name = name.replace(/\.[\w-]+/g, '') || 'div';

  const node = document.createElement(name);
  if (classes.length) node.className = classes.join(' ');

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') {
        node.className = [node.className, value].filter(Boolean).join(' ');
      } else if (key === 'style' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) {
          // Custom properties must go through setProperty; assigning them via
          // `style[prop]` silently does nothing.
          if (prop.startsWith('--')) node.style.setProperty(prop, val);
          else node.style[prop] = val;
        }
      } else if (key === 'dataset') {
        for (const [d, v] of Object.entries(value)) {
          if (v != null) node.dataset[d] = String(v);
        }
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key === 'html') {
        // Only ever used with strings this module built, never with user data.
        node.innerHTML = value;
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'disabled' || key === 'checked' || key === 'selected') {
        if (value) node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  append(node, children);
  return node;
}

/** Append children of any shape: array, string, number, Node, null. */
function append(parent, children) {
  if (children == null) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  if (children instanceof Node) {
    parent.appendChild(children);
    return parent;
  }
  parent.appendChild(document.createTextNode(String(children)));
  return parent;
}

/** Replace a container's contents in one operation (avoids layout thrash). */
function swap(container, children) {
  if (!container) return container;
  const frag = document.createDocumentFragment();
  append(frag, children);
  container.replaceChildren(frag);
  return container;
}

/** Add a class, remove it after `ms`, restarting the timer if re-added. */
function flash(node, className, ms = 400) {
  if (!node) return;
  node.classList.remove(className);
  // Reading offsetWidth forces a reflow so the animation restarts even when the
  // class is re-added in the same frame.
  void node.offsetWidth;
  node.classList.add(className);
  clearTimeout(node._flashTimer);
  node._flashTimer = setTimeout(() => node.classList.remove(className), ms);
}

// ===========================================================================
// Formatting
// ===========================================================================

const Fmt = {
  num(n) {
    return Math.round(n || 0).toLocaleString('en-US');
  },
  /** Compact form for HP bars, where "12.4k" reads better than "12,438". */
  compact(n) {
    const v = Math.round(n || 0);
    if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  },
  pct(n, digits = 0) {
    return `${((n || 0) * 100).toFixed(digits)}%`;
  },
  element(id) {
    const e = (State.data && State.data.elements && State.data.elements[id]) || null;
    return e || { id, name: id, icon: '?', color: 'var(--text-dim)' };
  },
  /** CSS colour for an element id, safe even before /api/data has loaded. */
  elementColor(id) {
    return `var(--el-${id || 'physical'})`;
  },
};

// ===========================================================================
// Toasts
// ===========================================================================

/**
 * Transient message. Errors linger nearly twice as long as successes because a
 * player who missed a refusal has no other way to learn what went wrong.
 */
function toast(message, kind = 'info', ms) {
  const wrap = $('toast-wrap');
  if (!wrap) return;
  const node = el('div.toast', { text: message, class: kind === 'info' ? null : `is-${kind}` });
  wrap.appendChild(node);
  const life = ms != null ? ms : (kind === 'error' ? 3600 : 2000);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 260);
  }, life);
  // Never let toasts stack past the screen edge.
  while (wrap.children.length > 4) wrap.firstChild.remove();
}

// ===========================================================================
// Modal
// ===========================================================================

const Modal = {
  open(title, content, options = {}) {
    $('modal-title').textContent = title;
    swap($('modal-body'), content);
    $('modal').classList.remove('hidden');
    Modal._onOpen = options.onOpen || null;
    if (Modal._onOpen) Modal._onOpen();
  },
  close() {
    $('modal').classList.add('hidden');
    swap($('modal-body'), null);
    Modal._onOpen = null;
  },
  get isOpen() {
    return !$('modal').classList.contains('hidden');
  },
};

/** A labelled stat cell, used by the party screen and the codex. */
function statCell(label, value) {
  return el('div.stat-cell', null, [
    el('div.stat-cell-val', { text: value }),
    el('div.stat-cell-label', { text: label }),
  ]);
}

/** An element badge: icon + name, tinted by the element's own colour. */
function elementTag(elementId) {
  const e = Fmt.element(elementId);
  return el('span.tag.tag-el', {
    text: `${e.icon} ${e.name}`,
    style: { color: Fmt.elementColor(elementId) },
    title: e.name,
  });
}

/**
 * A status icon with a tooltip carrying the full description.
 * Stacks are shown as a corner badge only when above 1, so a single stack stays
 * visually quiet.
 */
function statusChip(status) {
  const label = [
    status.name,
    status.desc || '',
    status.remaining != null && status.remaining < 90 ? `剩余 ${status.remaining} 回合` : '',
    status.stacks > 1 ? `${status.stacks} 层` : '',
  ].filter(Boolean).join(' · ');
  return el('div.status-chip', {
    text: status.icon || '●',
    dataset: { kind: status.kind },
    title: label,
  }, status.stacks > 1 ? el('span.status-stacks', { text: status.stacks }) : null);
}
