// Vitest setup: jsdom lacks DragEvent, so testing-library falls back to a plain Event
// and drops clientX/clientY. A MouseEvent subclass keeps the pointer coordinates.
if (typeof window !== 'undefined' && !('DragEvent' in window)) {
  class DragEventPolyfill extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  Object.defineProperty(window, 'DragEvent', { value: DragEventPolyfill, configurable: true });
}
