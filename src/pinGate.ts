import { verifyPin } from './library';
import { animateRibbons } from './artwork';
import { t } from './i18n';

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
      <canvas class="ribbons" aria-hidden="true"></canvas>
      <form id="pin-gate-form" class="pin-card">
        <p class="wordmark">AI-Capella</p>
        <h1></h1>
        <p class="pin-hint"></p>
        <input id="pin-gate-input" class="field pin-input" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" autofocus />
        <button type="submit" class="btn primary wide"></button>
        <p id="pin-gate-error" role="alert"></p>
      </form>
    `;
    overlay.querySelector('h1')!.textContent = t('pinTitle');
    overlay.querySelector('.pin-hint')!.textContent = t('pinHint');
    overlay.querySelector('button')!.textContent = t('pinContinue');
    document.body.appendChild(overlay);
    const stopRibbons = animateRibbons(overlay.querySelector<HTMLCanvasElement>('.ribbons')!, (w, h) => ({
      voices: 6,
      x0: -0.08 * w,
      x1: 1.08 * w,
      cy: h * 0.22,
      gap: Math.min(16, h * 0.02),
      amp: Math.min(30, h * 0.035),
    }));

    const form = overlay.querySelector<HTMLFormElement>('#pin-gate-form')!;
    const input = overlay.querySelector<HTMLInputElement>('#pin-gate-input')!;
    const errorEl = overlay.querySelector<HTMLParagraphElement>('#pin-gate-error')!;
    const submitBtn = form.querySelector('button')!;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value.trim();
      if (!pin) return;
      errorEl.textContent = '';
      submitBtn.disabled = true;
      try {
        if (await verifyPin(pin)) {
          localStorage.setItem(STORAGE_KEY, '1');
          stopRibbons();
          overlay.remove();
          resolve();
        } else {
          errorEl.textContent = t('pinWrong');
          input.select();
        }
      } catch (err) {
        errorEl.textContent = t('pinFailed', { msg: err instanceof Error ? err.message : String(err) });
      } finally {
        submitBtn.disabled = false;
      }
    });
  });
}
