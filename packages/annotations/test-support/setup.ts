// jsdom has no layout: the editor's typewriter scrolling calls window.scrollTo, which
// jsdom reports as "not implemented" on every keystroke. Make it a quiet no-op.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
