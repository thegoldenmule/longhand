'use client';
/** Shows children once signed in; in Cognito mode offers the Hosted UI sign-in. */
import { useEffect, useState, type ReactNode } from 'react';
import { isSignedIn, signIn } from '../auth/session';
import { runtimeConfig } from '../config';

export function AuthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => setOk(isSignedIn()), []);
  if (ok === null) return null;
  if (ok) return <>{children}</>;
  const cognito = runtimeConfig().cognito;
  return (
    <main className="lh-center-page">
      <div className="lh-signin">
        <p className="lh-wordmark">Longhand</p>
        <p className="lh-muted">Sign in to open your projects.</p>
        <button
          type="button"
          className="lh-button lh-button-primary"
          onClick={() => void signIn()}
          disabled={!cognito?.domain || !cognito.clientId}
        >
          Sign in
        </button>
        {(!cognito?.domain || !cognito.clientId) && (
          <p className="lh-error">Cognito is not configured (COGNITO_DOMAIN, COGNITO_CLIENT_ID).</p>
        )}
      </div>
    </main>
  );
}
