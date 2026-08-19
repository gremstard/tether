import {
  getAuth,
  connectAuthEmulator,
  setPersistence,
  indexedDBLocalPersistence,
  browserLocalPersistence,
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
/** Point auth at an emulator. Test-only; see main/index.js. */
export function useEmulator(app, url) {
  connectAuthEmulator(getAuth(app), url, { disableWarnings: true });
}

export function initAuth(app, { onSignedIn, onSignedOut }) {
  const auth = getAuth(app);

  // Say explicitly that the session should outlive the process, rather than
  // relying on the SDK's default. IndexedDB first, since it is the more durable
  // of the two; localStorage is the fallback if it is unavailable.
  //
  // Either way this is keyed to the page's origin, which is why the renderer is
  // served from a fixed port (see main/server.js).
  setPersistence(auth, indexedDBLocalPersistence)
    .catch(() => setPersistence(auth, browserLocalPersistence))
    .catch((err) => window.tether.log(`could not set auth persistence: ${err.message}`))
    .finally(() => {
      onAuthStateChanged(auth, (user) => (user ? onSignedIn(user) : onSignedOut()));
    });

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
