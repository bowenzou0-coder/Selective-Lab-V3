import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { getPublicFirebaseConfig } from '../shared/firebaseConfig';

const firebaseConfig = getPublicFirebaseConfig();

const app = initializeApp({
  projectId: firebaseConfig.projectId,
  appId: firebaseConfig.appId,
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  storageBucket: firebaseConfig.storageBucket,
  messagingSenderId: firebaseConfig.messagingSenderId,
});

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });

const authEmulatorHost = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST as string | undefined;
if (authEmulatorHost && !(auth as unknown as { emulatorConfig?: unknown }).emulatorConfig) {
  const url = authEmulatorHost.startsWith('http')
    ? authEmulatorHost
    : `http://${authEmulatorHost}`;
  connectAuthEmulator(auth, url, { disableWarnings: true });
}

const firestoreEmulatorHost = import.meta.env.VITE_FIRESTORE_EMULATOR_HOST as string | undefined;
if (firestoreEmulatorHost) {
  const [host, portStr] = firestoreEmulatorHost.replace(/^https?:\/\//, '').split(':');
  const port = Number(portStr) || 8080;
  try {
    connectFirestoreEmulator(db, host, port);
  } catch {
    // already connected
  }
}
