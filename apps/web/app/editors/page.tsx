'use client';
import dynamic from 'next/dynamic';
import { AuthGate } from '../../src/ui/AuthGate';

// Client only, like the rest of the app.
const EditorsPage = dynamic(
  () => import('../../src/editors/EditorsPage').then((m) => m.EditorsPage),
  { ssr: false },
);

export default function Editors() {
  return (
    <AuthGate>
      <EditorsPage />
    </AuthGate>
  );
}
