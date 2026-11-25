/**
 * React bindings: `useAnnotations` creates and wires one controller;
 * `useAnnotationsSnapshot` subscribes a component to it.
 */
import type { EditorHandle } from '@longhand/editor';
import type { ProjectState } from '@longhand/schema';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  AnnotationsController,
  type AnnotationsControllerOptions,
  type AnnotationsSnapshot,
} from '../controller';

/** Options for {@link useAnnotations}. */
export interface UseAnnotationsOptions extends Omit<
  AnnotationsControllerOptions,
  'editor' | 'state'
> {
  /** The editor handle (from `onReady`), or null until it exists. */
  editor: EditorHandle | null;
  /** The latest folded `ProjectState` from the ledger stream. */
  state: ProjectState | null;
}

/**
 * Creates an {@link AnnotationsController} for the component's lifetime and keeps
 * it in sync with the editor handle, the project state and the callbacks.
 */
export function useAnnotations(options: UseAnnotationsOptions): AnnotationsController {
  const { editor, state, ...rest } = options;
  const [controller] = useState(() => new AnnotationsController(rest));
  useEffect(() => {
    controller.connect();
    return () => controller.disconnect();
  }, [controller]);
  useEffect(() => {
    controller.setOptions(rest);
  });
  useEffect(() => {
    controller.attach(editor);
  }, [controller, editor]);
  useEffect(() => {
    controller.setState(state);
  }, [controller, state]);
  return controller;
}

/** Subscribes to a controller's snapshot. */
export function useAnnotationsSnapshot(controller: AnnotationsController): AnnotationsSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
