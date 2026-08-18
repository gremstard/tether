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

export function emailSignIn(auth, email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/**
 * Sign-up is explicit rather than "sign in, and create the account if missing".
 * Signing up now claims a username as a separate step, and silently creating an
 * account on a mistyped password would strand a user with no handle.
 */
export function emailSignUp(auth, email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function googleSignIn(auth) {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export { signOut };
