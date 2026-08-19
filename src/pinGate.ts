import { verifyPin } from './library';

const STORAGE_KEY = 'ai-capella-access-granted';

/**
 * Blocks the page behind a full-screen PIN prompt until a correct PIN is entered (or was
 * previously entered on this device/browser). This is a soft UI gate, not real access control:
 * Firestore rules only require anonymous auth, so a technically determined visitor could read
 * the app's code and bypass this. Reasonable for keeping casual link-sharers out of a choir's
 * sheet-music library; not appropriate for anything actually sensitive.
 */
export function ensureAccess(): Promise<void> {
  if (localStorage.getItem(STORAGE_KEY) === '1') return Promise.resolve();

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'pin-gate';
    overlay.innerHTML = `
      <form id="pin-gate-form">
        <h1>AI-Capella</h1>
        <p>Enter the choir access PIN to continue.</p>
        <input id="pin-gate-input" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" autofocus />
        <button type="submit">Continue</button>
        <div id="pin-gate-error"></div>
      </form>
    `;
    document.body.appendChild(overlay);

    const form = overlay.querySelector<HTMLFormElement>('#pin-gate-form')!;
    const input = overlay.querySelector<HTMLInputElement>('#pin-gate-input')!;
    const errorEl = overlay.querySelector<HTMLDivElement>('#pin-gate-error')!;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value.trim();
      if (!pin) return;
      errorEl.textContent = '';
      form.querySelector('button')!.disabled = true;
      try {
        const ok = await verifyPin(pin);
        if (ok) {
          localStorage.setItem(STORAGE_KEY, '1');
          overlay.remove();
          resolve();
        } else {
          errorEl.textContent = 'Incorrect PIN.';
          input.select();
        }
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Could not verify PIN.';
      } finally {
        form.querySelector('button')!.disabled = false;
      }
    });
  });
}
