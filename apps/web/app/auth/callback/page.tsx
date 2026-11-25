'use client';
/** Cognito Hosted UI redirect target: exchanges the code (PKCE) and goes back. */
import { useEffect, useState } from 'react';
import { completeSignIn } from '../../../src/auth/session';

export default function AuthCallback() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    completeSignIn(location.search).then(
      (to) => location.replace(to),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  return (
    <main className="lh-center-page">
      <div className="lh-signin">
        <p className="lh-wordmark">Longhand</p>
        {error ? (
          <>
            <p className="lh-error" role="alert">
              {error}
            </p>
            <a className="lh-button" href="/">
              Try again
            </a>
          </>
        ) : (
          <p className="lh-muted">Signing you in…</p>
        )}
      </div>
    </main>
  );
}
