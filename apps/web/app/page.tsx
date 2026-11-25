'use client';
import dynamic from 'next/dynamic';
import { AuthGate } from '../src/ui/AuthGate';

// Client only: the packages use browser storage, IndexedDB and WebCrypto.
const ProjectsHome = dynamic(() => import('../src/home/ProjectsHome').then((m) => m.ProjectsHome), {
  ssr: false,
});

export default function Home() {
  return (
    <AuthGate>
      <ProjectsHome />
    </AuthGate>
  );
}
