import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  User,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  doc,
  setDoc,
  getDoc,
  collection,
  onSnapshot,
  deleteDoc,
  query,
} from 'firebase/firestore';
import { auth, db } from './config.ts';
import { handleFirestoreError, OperationType } from './errors.ts';

export interface WatchlistRecord {
  id: string;
  userId: string;
  symbol: string;
  note?: string;
  addedAt: string;
}

export interface TradeAnnotationRecord {
  id: string;
  userId: string;
  symbol: string;
  positionId?: string;
  content: string;
  createdAt: string;
}

export interface UserPreferencesRecord {
  userId: string;
  soundAlerts?: boolean;
  autoRefreshInterval?: number;
  pinnedSymbols?: string;
  updatedAt?: string;
}

interface FirebaseContextType {
  user: User | null;
  isAuthReady: boolean;
  watchlist: WatchlistRecord[];
  annotations: TradeAnnotationRecord[];
  preferences: UserPreferencesRecord | null;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  toggleWatchlist: (symbol: string, note?: string) => Promise<void>;
  addAnnotation: (symbol: string, content: string, positionId?: string) => Promise<void>;
  deleteAnnotation: (id: string) => Promise<void>;
  updatePreferences: (prefs: Partial<UserPreferencesRecord>) => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextType | undefined>(undefined);

export const FirebaseProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [watchlist, setWatchlist] = useState<WatchlistRecord[]>([]);
  const [annotations, setAnnotations] = useState<TradeAnnotationRecord[]>([]);
  const [preferences, setPreferences] = useState<UserPreferencesRecord | null>(null);

  // Monitor Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async currentUser => {
      setUser(currentUser);
      setIsAuthReady(true);

      if (currentUser) {
        // Sync user profile document
        const userDocPath = `users/${currentUser.uid}`;
        try {
          const userDocRef = doc(db, 'users', currentUser.uid);
          const existing = await getDoc(userDocRef);
          const nowIso = new Date().toISOString();

          if (!existing.exists()) {
            await setDoc(userDocRef, {
              userId: currentUser.uid,
              email: currentUser.email || '',
              displayName: currentUser.displayName || '',
              photoURL: currentUser.photoURL || '',
              createdAt: nowIso,
              updatedAt: nowIso,
            });
          } else {
            await setDoc(
              userDocRef,
              {
                userId: currentUser.uid,
                email: currentUser.email || '',
                displayName: currentUser.displayName || '',
                photoURL: currentUser.photoURL || '',
                updatedAt: nowIso,
              },
              { merge: true }
            );
          }
        } catch (err) {
          console.error('Error syncing user profile:', err);
        }
      } else {
        setWatchlist([]);
        setAnnotations([]);
        setPreferences(null);
      }
    });

    return () => unsubscribe();
  }, []);

  // Listen to User Watchlist in Firestore
  useEffect(() => {
    if (!user) {
      setWatchlist([]);
      return;
    }

    const path = `users/${user.uid}/watchlist`;
    const q = query(collection(db, 'users', user.uid, 'watchlist'));
    const unsubscribe = onSnapshot(
      q,
      snapshot => {
        const items: WatchlistRecord[] = [];
        snapshot.forEach(docSnap => {
          items.push(docSnap.data() as WatchlistRecord);
        });
        setWatchlist(items);
      },
      error => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Listen to User Annotations in Firestore
  useEffect(() => {
    if (!user) {
      setAnnotations([]);
      return;
    }

    const path = `users/${user.uid}/annotations`;
    const q = query(collection(db, 'users', user.uid, 'annotations'));
    const unsubscribe = onSnapshot(
      q,
      snapshot => {
        const items: TradeAnnotationRecord[] = [];
        snapshot.forEach(docSnap => {
          items.push(docSnap.data() as TradeAnnotationRecord);
        });
        setAnnotations(items);
      },
      error => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Listen to User Preferences in Firestore
  useEffect(() => {
    if (!user) {
      setPreferences(null);
      return;
    }

    const path = `users/${user.uid}/preferences/general`;
    const unsubscribe = onSnapshot(
      doc(db, 'users', user.uid, 'preferences', 'general'),
      docSnap => {
        if (docSnap.exists()) {
          setPreferences(docSnap.data() as UserPreferencesRecord);
        }
      },
      error => {
        handleFirestoreError(error, OperationType.GET, path);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Sign In with Google
  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        // User closed the popup window, normal flow
        return;
      }
      if (err.code === 'auth/popup-blocked') {
        console.warn('Google Sign-in popup was blocked by browser. Please allow popups.');
        throw err;
      }
      console.warn('Google Sign-in popup notice:', err?.code || err);
      throw err;
    }
  };

  // Sign Out
  const signOutUser = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Sign-out failed:', err);
    }
  };

  // Toggle Watchlist item
  const toggleWatchlist = async (symbol: string, note?: string) => {
    if (!user) {
      await signInWithGoogle();
      return;
    }

    const cleanSymbol = symbol.toUpperCase().trim();
    const existing = watchlist.find(w => w.symbol === cleanSymbol);
    const path = `users/${user.uid}/watchlist/${cleanSymbol}`;

    try {
      if (existing) {
        await deleteDoc(doc(db, 'users', user.uid, 'watchlist', cleanSymbol));
      } else {
        const record: WatchlistRecord = {
          id: cleanSymbol,
          userId: user.uid,
          symbol: cleanSymbol,
          note: note || '',
          addedAt: new Date().toISOString(),
        };
        await setDoc(doc(db, 'users', user.uid, 'watchlist', cleanSymbol), record);
      }
    } catch (err) {
      handleFirestoreError(err, existing ? OperationType.DELETE : OperationType.CREATE, path);
    }
  };

  // Add Annotation
  const addAnnotation = async (symbol: string, content: string, positionId?: string) => {
    if (!user) {
      await signInWithGoogle();
      return;
    }

    const id = `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const path = `users/${user.uid}/annotations/${id}`;
    const record: TradeAnnotationRecord = {
      id,
      userId: user.uid,
      symbol: symbol.toUpperCase(),
      content: content.trim(),
      createdAt: new Date().toISOString(),
    };
    if (positionId) {
      record.positionId = positionId;
    }

    try {
      await setDoc(doc(db, 'users', user.uid, 'annotations', id), record);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  // Delete Annotation
  const deleteAnnotation = async (id: string) => {
    if (!user) return;
    const path = `users/${user.uid}/annotations/${id}`;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'annotations', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  // Update Preferences
  const updatePreferences = async (newPrefs: Partial<UserPreferencesRecord>) => {
    if (!user) return;
    const path = `users/${user.uid}/preferences/general`;
    try {
      const data: UserPreferencesRecord = {
        userId: user.uid,
        ...preferences,
        ...newPrefs,
        updatedAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'users', user.uid, 'preferences', 'general'), data, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  return (
    <FirebaseContext.Provider
      value={{
        user,
        isAuthReady,
        watchlist,
        annotations,
        preferences,
        signInWithGoogle,
        signOutUser,
        toggleWatchlist,
        addAnnotation,
        deleteAnnotation,
        updatePreferences,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
};

export const useFirebase = (): FirebaseContextType => {
  const context = useContext(FirebaseContext);
  if (!context) {
    throw new Error('useFirebase must be used within a FirebaseProvider');
  }
  return context;
};
