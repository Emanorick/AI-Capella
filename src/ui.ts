import { icon, type IconName } from './icons';
import { t } from './i18n';

// Small overlay toolkit: one open overlay at a time (menu, popover, sheet or dialog), closed by
// Escape, a click on the scrim/outside, or its own buttons. Focus moves into the overlay and back
// to whatever opened it.

let closeCurrent: (() => void) | null = null;

export function closeOverlay() {
  closeCurrent?.();
}

export function isNarrow(): boolean {
  return window.matchMedia('(max-width: 899px)').matches;
}

function mount(root: HTMLElement, opener: Element | null, onClose?: () => void): () => void {
  closeOverlay();
  root.querySelector<HTMLElement>('.overlay-panel')?.setAttribute('tabindex', '-1');
  document.body.appendChild(root);
  const previousFocus = (opener as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    root.classList.add('closing');
    const finish = () => root.remove();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else setTimeout(finish, 160);
    if (closeCurrent === close) closeCurrent = null;
    previousFocus?.focus?.({ preventScroll: true });
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const onOutside = (e: PointerEvent) => {
    const panel = root.querySelector('.overlay-panel');
    if (panel && !panel.contains(e.target as Node) && !(opener && opener.contains(e.target as Node))) close();
  };
  document.addEventListener('keydown', onKey, true);
  // Deferred so the click that opened the overlay doesn't immediately count as an outside click.
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  closeCurrent = close;
  requestAnimationFrame(() => {
    root.classList.add('open');
    // An explicit autofocus target (dialog input or confirm button), else the first menu item,
    // else the panel itself -- so keyboard users land inside the overlay without a random control
    // (like a tempo button) being focused on a phone.
    const focusTarget = root.querySelector<HTMLElement>('[autofocus]') ?? root.querySelector<HTMLElement>('.menu-item') ?? root.querySelector<HTMLElement>('.overlay-panel');
    focusTarget?.focus({ preventScroll: true });
  });
  return close;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

/** A dropdown menu anchored to `anchor` (a bottom sheet on narrow screens). */
export function openMenu(anchor: HTMLElement, items: MenuItem[], title?: string) {
  const list = document.createElement('div');
  list.className = 'menu-list';
  list.setAttribute('role', 'menu');
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item' + (item.danger ? ' danger' : '');
    btn.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked));
    btn.innerHTML = item.icon ? icon(item.icon) : '<span class="ic"></span>';
    const label = document.createElement('span');
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.checked) btn.insertAdjacentHTML('beforeend', '<span class="menu-check" aria-hidden="true">✓</span>');
    btn.addEventListener('click', () => {
      closeOverlay();
      item.onSelect();
    });
    list.appendChild(btn);
  }
  if (isNarrow()) openSheet(title ?? '', list, anchor);
  else openPopover(anchor, list, 'end');
}

/** A floating panel next to `anchor`, kept inside the viewport. */
export function openPopover(anchor: HTMLElement, content: HTMLElement, align: 'start' | 'center' | 'end' = 'center') {
  const root = document.createElement('div');
  root.className = 'overlay popover-root';
  const panel = document.createElement('div');
  panel.className = 'overlay-panel popover';
  panel.appendChild(content);
  root.appendChild(panel);
  const close = mount(root, anchor);
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    let left = align === 'start' ? a.left : align === 'end' ? a.right - p.width : a.left + a.width / 2 - p.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - p.width - 8, left));
    const below = a.bottom + 8;
    const top = below + p.height > window.innerHeight - 8 ? a.top - p.height - 8 : below;
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(8, top)}px`;
  };
  place();
  requestAnimationFrame(place);
  return close;
}

/** A bottom sheet with a grabber and title -- the phone's home for secondary controls. */
export function openSheet(title: string, content: HTMLElement, opener?: Element | null, onClose?: () => void) {
  const root = document.createElement('div');
  root.className = 'overlay sheet-root';
  const panel = document.createElement('div');
  panel.className = 'overlay-panel sheet';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = `<span class="sheet-grab" aria-hidden="true"></span>`;
  if (title) {
    const h = document.createElement('h2');
    h.textContent = title;
    head.appendChild(h);
    panel.setAttribute('aria-label', title);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn overlay-close';
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.innerHTML = icon('close');
  head.appendChild(closeBtn);
  panel.append(head, content);
  root.appendChild(panel);
  const close = mount(root, opener ?? null, onClose);
  closeBtn.addEventListener('click', close);
  return close;
}

interface DialogOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  input?: { value: string; label: string };
}

function dialog(o: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'overlay dialog-root';
    const panel = document.createElement('form');
    panel.className = 'overlay-panel dialog';
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.textContent = o.title;
    panel.appendChild(h);
    if (o.body) {
      const p = document.createElement('p');
      p.textContent = o.body;
      panel.appendChild(p);
    }
    let input: HTMLInputElement | null = null;
    if (o.input) {
      input = document.createElement('input');
      input.className = 'field';
      input.value = o.input.value;
      input.setAttribute('aria-label', o.input.label);
      input.autofocus = true;
      panel.appendChild(input);
    }
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = t('cancel');
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'btn ' + (o.danger ? 'danger' : 'primary');
    ok.textContent = o.confirmLabel;
    if (!o.input) ok.autofocus = true;
    actions.append(cancel, ok);
    panel.appendChild(actions);
    root.appendChild(panel);
    let result: string | null = null;
    const close = mount(root, null, () => resolve(result));
    cancel.addEventListener('click', close);
    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      result = input ? input.value.trim() : 'ok';
      close();
    });
    requestAnimationFrame(() => input?.select());
  });
}

export async function confirmDialog(o: Omit<DialogOptions, 'input'>): Promise<boolean> {
  return (await dialog(o)) === 'ok';
}

export async function promptDialog(title: string, value: string, confirmLabel: string): Promise<string | null> {
  const result = await dialog({ title, confirmLabel, input: { value, label: title } });
  return result && result !== value ? result : null;
}

let toastTimer: number | null = null;
/** A short status line at the bottom of the screen -- replaces the old 12px status text. */
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle('error', kind === 'error');
  el.classList.add('show');
  if (toastTimer != null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 6500 : 3200);
}
