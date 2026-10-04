import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import rawConfig from '../../firebase-applet-config.json';

// Use current window location host for first-party auth domain to bypass third-party cookie restrictions in iframes
const isBrowser = typeof window !== 'undefined';
const hostAuthDomain = isBrowser && window.location.host ? window.location.host : rawConfig.authDomain;

export const firebaseConfig = {
  ...rawConfig,
  authDomain: hostAuthDomain,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// CRITICAL: The app will break without specifying firestoreDatabaseId
// In browser environments (iframes/proxies), initialize with experimentalForceLongPolling to eliminate 10s WebChannel stream buffering timeouts
function createFirestoreInstance() {
  if (isBrowser) {
    try {
      return initializeFirestore(
        app,
        {
          experimentalForceLongPolling: true,
        },
        firebaseConfig.firestoreDatabaseId
      );
    } catch {
      return getFirestore(app, firebaseConfig.firestoreDatabaseId);
    }
  }
  return getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db = createFirestoreInstance();
export const auth = getAuth(app);

// CRITICAL CONSTRAINT: Test connection on initial boot
export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      // Retry once after brief interval before reporting
      try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (retryError) {
        if (retryError instanceof Error && retryError.message.includes('the client is offline')) {
          console.error('Please check your Firebase configuration.');
        }
      }
    }
  }
}

testConnection().catch(() => {});
