import appletFirebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

export interface PublicFirebaseConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  messagingSenderId: string;
}

function readEnv(key: string): string {
  // Works safely in both Vite browser bundles and Node server
  const viteEnv =
    typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ? (import.meta as unknown as { env: Record<string, string | undefined> }).env
      : undefined;
  if (viteEnv && typeof viteEnv[key] === 'string' && viteEnv[key]!.trim()) {
    return viteEnv[key]!.trim();
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env[key] === 'string' && process.env[key]!.trim()) {
    return process.env[key]!.trim();
  }
  return '';
}

export function getPublicFirebaseConfig(): PublicFirebaseConfig {
  const cfg: PublicFirebaseConfig = {
    projectId: readEnv('VITE_FIREBASE_PROJECT_ID') || readEnv('FIREBASE_PROJECT_ID') || appletFirebaseConfig.projectId,
    appId: readEnv('VITE_FIREBASE_APP_ID') || readEnv('FIREBASE_APP_ID') || appletFirebaseConfig.appId,
    apiKey: readEnv('VITE_FIREBASE_API_KEY') || readEnv('FIREBASE_API_KEY') || appletFirebaseConfig.apiKey,
    authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN') || readEnv('FIREBASE_AUTH_DOMAIN') || appletFirebaseConfig.authDomain,
    firestoreDatabaseId:
      readEnv('VITE_FIREBASE_DATABASE_ID') ||
      readEnv('FIREBASE_DATABASE_ID') ||
      appletFirebaseConfig.firestoreDatabaseId ||
      '(default)',
    storageBucket:
      readEnv('VITE_FIREBASE_STORAGE_BUCKET') ||
      readEnv('FIREBASE_STORAGE_BUCKET') ||
      appletFirebaseConfig.storageBucket,
    messagingSenderId:
      readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID') ||
      readEnv('FIREBASE_MESSAGING_SENDER_ID') ||
      appletFirebaseConfig.messagingSenderId,
  };

  const missing: string[] = [];
  if (!cfg.projectId) missing.push('projectId');
  if (!cfg.apiKey) missing.push('apiKey');
  if (!cfg.authDomain) missing.push('authDomain');
  if (!cfg.appId) missing.push('appId');
  if (!cfg.firestoreDatabaseId) missing.push('firestoreDatabaseId');
  if (missing.length > 0) {
    throw new Error(`Invalid Firebase public configuration; missing: ${missing.join(', ')}`);
  }
  return cfg;
}
