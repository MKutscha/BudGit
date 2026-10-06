import { registerSW } from 'virtual:pwa-register';
import { installBlurOnHide, requestPersist } from './webshell';

export function boot() {
  const update = registerSW({
    onNeedRefresh() {
      window.dispatchEvent(new CustomEvent('budgit:update', { detail: () => void update(true) }));
    },
  });
  installBlurOnHide();
  void requestPersist();
}
