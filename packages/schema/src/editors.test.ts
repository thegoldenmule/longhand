import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical';
import { LENSES, TEXT_LIMITS } from './domain';
import {
  EDITOR_MAX_QUESTIONS,
  EditorProfileInputSchema,
  EditorProfileSchema,
  FeedbackEditorSchema,
  STARTER_EDITORS,
  feedbackEditorOf,
} from './editors';
import { FeedbackRequestedSchema } from './events';

const profile = {
  id: 'ed-1',
  name: 'Theo',
  role: 'Line editor',
  brief: 'A blunt line editor who hates adverbs.',
  lenses: ['word-choice', 'clarity'],
  intensity: 'standard',
  questions: ['Which words would you cut?'],
} as const;

describe('EditorProfileSchema', () => {
  it('accepts a profile', () => {
    expect(EditorProfileSchema.parse(profile)).toEqual(profile);
  });

  it('needs at least one lens and no duplicates', () => {
    expect(EditorProfileSchema.safeParse({ ...profile, lenses: [] }).success).toBe(false);
    expect(
      EditorProfileSchema.safeParse({ ...profile, lenses: ['clarity', 'clarity'] }).success,
    ).toBe(false);
    expect(EditorProfileSchema.safeParse({ ...profile, lenses: ['nonsense'] }).success).toBe(false);
  });

  it('bounds the name, brief and questions', () => {
    const bad = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(TEXT_LIMITS.editorNameMaxChars + 1) },
      { brief: 'x'.repeat(TEXT_LIMITS.editorBriefMaxChars + 1) },
      { questions: [''] },
      { questions: ['  '] },
      { questions: ['x'.repeat(TEXT_LIMITS.editorQuestionMaxChars + 1)] },
      { questions: Array.from({ length: EDITOR_MAX_QUESTIONS + 1 }, (_, i) => `Q${i}?`) },
      { questions: ['Same?', 'Same?'] },
      { intensity: 'heavy' },
    ];
    for (const b of bad)
      expect(EditorProfileSchema.safeParse({ ...profile, ...b }).success, JSON.stringify(b)).toBe(
        false,
      );
    expect(EditorProfileSchema.safeParse({ ...profile, brief: '', questions: [] }).success).toBe(
      true,
    );
  });

  it('input is the profile without its id', () => {
    const { id: _id, ...input } = profile;
    expect(EditorProfileInputSchema.parse(input)).toEqual(input);
  });
});

describe('FeedbackRequested.editor', () => {
  const base = {
    requestId: 'req1',
    scope: { kind: 'document', documentId: 'doc1' },
    lenses: ['word-choice', 'clarity'],
    intensity: 'standard',
    ask: null,
  } as const;

  it('is optional, so payloads without it are unchanged', () => {
    const parsed = FeedbackRequestedSchema.parse(base);
    expect('editor' in parsed).toBe(false);
    expect(canonicalize(parsed)).toBe(canonicalize(base));
  });

  it('records the editor id, name, role and brief', () => {
    const editor = feedbackEditorOf(EditorProfileSchema.parse(profile));
    expect(editor).toEqual({ id: 'ed-1', name: 'Theo', role: 'Line editor', brief: profile.brief });
    expect(FeedbackRequestedSchema.parse({ ...base, editor }).editor).toEqual(editor);
    expect(FeedbackEditorSchema.safeParse({ ...editor, name: '' }).success).toBe(false);
    expect(FeedbackRequestedSchema.safeParse({ ...base, editor: { name: 'Theo' } }).success).toBe(
      false,
    );
  });
});

describe('starter editors', () => {
  it('are valid, distinct, and cover the lenses the e2e mock reviewer uses', () => {
    expect(STARTER_EDITORS.length).toBeGreaterThanOrEqual(3);
    expect(STARTER_EDITORS.length).toBeLessThanOrEqual(4);
    for (const s of STARTER_EDITORS) {
      expect(EditorProfileInputSchema.safeParse(s).success, s.name).toBe(true);
      expect(s.questions.length).toBeGreaterThanOrEqual(2);
      expect(s.questions.length).toBeLessThanOrEqual(3);
      expect(s.lenses, s.name).toEqual(LENSES.filter((l) => s.lenses.includes(l)));
    }
    expect(new Set(STARTER_EDITORS.map((s) => s.name)).size).toBe(STARTER_EDITORS.length);
    const lenses = new Set(STARTER_EDITORS.flatMap((s) => s.lenses));
    expect(lenses.has('structure')).toBe(true);
    expect(lenses.has('word-choice')).toBe(true);
  });
});

describe('editor roles', () => {
  it('reads a profile saved without a role as no role', () => {
    const { role: _role, ...old } = profile;
    expect(EditorProfileSchema.parse(old).role).toBe('');
  });

  it('caps the role and records it on a request only when set', () => {
    expect(EditorProfileSchema.safeParse({ ...profile, role: 'x'.repeat(41) }).success).toBe(false);
    expect(feedbackEditorOf(EditorProfileSchema.parse(profile)).role).toBe('Line editor');
    expect('role' in feedbackEditorOf(EditorProfileSchema.parse({ ...profile, role: '  ' }))).toBe(
      false,
    );
  });

  it('gives every starter a role, and no brief uses a semicolon', () => {
    for (const s of STARTER_EDITORS) {
      expect(s.role.length).toBeGreaterThan(0);
      expect(s.brief).not.toContain(';');
    }
  });
});
