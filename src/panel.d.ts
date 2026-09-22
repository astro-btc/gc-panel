export {};

declare global {
  interface Window {
    panel?: {
      fetchPublic: (request: string | { url: string; method?: 'GET' | 'POST'; body?: string }) => Promise<{ status: number; text: string }>;
      credentialStatus: () => Promise<{ saved: boolean; keyHint: string }>;
      saveCredentials: (apiKey: string, apiSecret: string) => Promise<{ saved: boolean; keyHint: string }>;
      clearCredentials: () => Promise<{ saved: boolean; keyHint: string }>;
      gateCall: (action: string, payload?: unknown) => Promise<{ ok: boolean; data?: unknown; message?: string }>;
    };
  }
}
