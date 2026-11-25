'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { AuthGate } from '../../../src/ui/AuthGate';

const Workspace = dynamic(
  () => import('../../../src/workspace/Workspace').then((m) => m.Workspace),
  { ssr: false },
);

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AuthGate>
      <Workspace projectId={decodeURIComponent(projectId)} />
    </AuthGate>
  );
}
