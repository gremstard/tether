import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from 'firebase/auth';

/**
 * Auth wiring for the sign-in screen.
 *
 * Google sign-in uses signInWithPopup rather than a redirect: Electron loads the
 * renderer from a file:// origin, and redirect-based flows have no origin to
 * come back to. The popup opens a real browser window against the Firebase
 * authDomain, which does work.
 */
export function initAuth(app, { onSignedIn, onSignedOut }) {
  const auth = getAuth(app);
  onAuthStateChanged(auth, (user) => (user ? onSignedIn(user) : onSignedOut()));
  return auth;
}

export async function emailSignIn(auth, email, password, { createIfMissing }) {
  try {
    return await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    const missing =
      err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential';
    if (createIfMissing && missing) {
      return createUserWithEmailAndPassword(auth, email, password);
    }
    throw err;
  }
}

export function googleSignIn(auth) {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export { signOut };
