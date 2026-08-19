import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
} from 'firebase/auth';

/**
 * Auth wiring for the sign-in screen.
 *
 * Google sign-in deliberately does NOT use signInWithPopup. Google refuses OAuth
 * inside embedded browser windows — an in-app popup is met with "This browser or
 * app may not be secure". The main process runs the flow in the user's real
 * browser instead (see main/google-auth.js) and hands back an ID token, which is
 * exchanged for a Firebase session here.
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

export async function googleSignIn(auth) {
  const { idToken, accessToken } = await window.tether.googleSignIn();
  return signInWithCredential(auth, GoogleAuthProvider.credential(idToken, accessToken));
}

export { signOut };
