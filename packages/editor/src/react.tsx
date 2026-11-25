/**
 * `<LonghandEditor>`: the React 19 wrapper around {@link createEditorView}.
 *
 * The editor is created on mount and recreated when `projectId`, `documentId`,
 * `transport` or `queue` change. `settings`, `extraPlugins` and `editable` update
 * in place. Callbacks may change freely between renders. The handle is available
 * through `ref` and `onReady`.
 */
import { useEffect, useRef, type CSSProperties, type Ref } from 'react';
import { createEditorView, type CreateEditorOptions, type EditorHandle } from './core';

/** Props of {@link LonghandEditor}. */
export interface LonghandEditorProps extends Omit<CreateEditorOptions, 'mount'> {
  ref?: Ref<EditorHandle | null>;
  className?: string;
  style?: CSSProperties;
  /** Called with the handle after the editor is created (and again after it is recreated). */
  onReady?: (handle: EditorHandle) => void;
}

type Callbacks = Pick<
  CreateEditorOptions,
  'onWordCount' | 'onStatus' | 'onVersion' | 'onError' | 'onViolation' | 'onDraft'
> & { onReady?: (h: EditorHandle) => void };

function setRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T }).current = value;
}

/** The Longhand manuscript editor. */
export function LonghandEditor(props: LonghandEditorProps): React.JSX.Element {
  const { ref, className, style, onReady, ...options } = props;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const callbacks = useRef<Callbacks>({});
  callbacks.current = {
    ...(options.onWordCount ? { onWordCount: options.onWordCount } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    ...(options.onVersion ? { onVersion: options.onVersion } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onViolation ? { onViolation: options.onViolation } : {}),
    ...(options.onDraft ? { onDraft: options.onDraft } : {}),
    ...(onReady ? { onReady } : {}),
  };
  const latest = useRef(options);
  latest.current = options;

  const refRef = useRef(ref);
  refRef.current = ref;

  const { projectId, documentId, transport, queue } = options;
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const o = latest.current;
    const handle = createEditorView({
      ...o,
      mount,
      onWordCount: (c) => callbacks.current.onWordCount?.(c),
      onStatus: (s) => callbacks.current.onStatus?.(s),
      onVersion: (v) => callbacks.current.onVersion?.(v),
      onError: (e) => callbacks.current.onError?.(e),
      onViolation: (v) => callbacks.current.onViolation?.(v),
      onDraft: (d) => callbacks.current.onDraft?.(d),
    });
    handleRef.current = handle;
    setRef(refRef.current, handle);
    callbacks.current.onReady?.(handle);
    return () => {
      handle.destroy();
      if (handleRef.current === handle) {
        handleRef.current = null;
        setRef(refRef.current, null);
      }
    };
  }, [projectId, documentId, transport, queue]);

  const { settings, extraPlugins, editable } = options;
  useEffect(() => {
    if (settings) handleRef.current?.setSettings(settings);
  }, [settings]);
  useEffect(() => {
    if (extraPlugins) handleRef.current?.setExtraPlugins(extraPlugins);
  }, [extraPlugins]);
  useEffect(() => {
    if (editable !== undefined) handleRef.current?.setEditable(editable);
  }, [editable]);

  return <div ref={mountRef} className={className} style={style} />;
}
