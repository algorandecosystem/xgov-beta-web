import {
  type SupportedWallet,
  type WalletAccount,
  WalletId,
  WalletManager,
} from "@txnlab/use-wallet-react";
import {
  LiquidAuthClient,
  ICON as LiquidIcon,
} from "@algorandecosystem/liquid-auth-use-wallet-client";
import type { Transaction } from "algosdk";
import algosdk from "algosdk";
import * as cbor from "cbor";
import { fromBase64Url } from "@algorandfoundation/provider";

function ensureProcessNextTick() {
  const proc = (globalThis as any).process ?? {};
  if (typeof proc.nextTick !== "function") {
    proc.nextTick = (cb: (...args: any[]) => void, ...args: any[]) => {
      Promise.resolve().then(() => cb(...args));
    };
  }
  if (!proc.env) {
    proc.env = {};
  }
  (globalThis as any).process = proc;
}

// Simple test function to verify signing works
export async function testSimpleSign(client: LiquidAuthClient, wallet: string): Promise<void> {
  console.log("[Liquid Auth Test] =======================================");
  console.log("[Liquid Auth Test] Starting basic byte signing test");
  console.log("[Liquid Auth Test] Wallet:", wallet);

  // Fetch real suggested params from algod
  console.log("[Liquid Auth Test] Fetching suggested params...");
  const algodClient = new algosdk.Algodv2(
    "", // no token for testnet
    "https://testnet-api.algonode.cloud",
    443
  );
  const suggestedParams = await algodClient.getTransactionParams().do();
  console.log("[Liquid Auth Test] Got suggested params" + suggestedParams);

  // Create the simplest possible transaction - 0 amount payment to self
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: wallet,
    receiver: wallet,
    amount: 0,
    note: new TextEncoder().encode("TEST"),
    suggestedParams,
  });

  console.log("[Liquid Auth Test] Transaction bytes to sign:", txn.toByte().length, "bytes");
  console.log("[Liquid Auth Test] Transaction ID:", txn.txID());

  // Get the data channel for direct logging
  const dc = (client as any).dataChannel;
  console.log("[Liquid Auth Test] Data channel state:", dc?.readyState);

  // Set up message listener BEFORE sending (non-invasive)
  if (dc) {
    console.log("[Liquid Auth Test] Attaching debug listener (10s)...");
    console.log("[Liquid Auth Test] DataChannel state:", {
      readyState: dc.readyState,
      bufferedAmount: dc.bufferedAmount,
      id: dc.id,
    });
    const debugListener = (e: MessageEvent) => {
      console.log("[Liquid Auth Test] 📨 MESSAGE RECEIVED!");
      console.log("[Liquid Auth Test] Raw data (first 100 chars):", e.data?.substring?.(0, 100) || e.data);
    };
    dc.addEventListener("message", debugListener);
    setTimeout(() => dc.removeEventListener("message", debugListener), 10000);
  }

  console.log("[Liquid Auth Test] Sending to mobile app...");

  try {
    const results = await client.signTransactions([txn], wallet);
    console.log("[Liquid Auth Test] ✅ SUCCESS! Got results:", results.length);

    if (results[0]) {
      console.log("[Liquid Auth Test] ✅ First signature length:", results[0].length, "bytes");
      console.log("[Liquid Auth Test] ✅ TEST PASSED - Response received!");
    } else {
      console.log("[Liquid Auth Test] ❌ First result is null/undefined");
    }
  } catch (error) {
    console.error("[Liquid Auth Test] ❌ ERROR during sign:", error);
    throw error;
  }

  console.log("[Liquid Auth Test] =======================================");
}

const liquidOrigin = import.meta.env.PUBLIC_LIQUID_AUTH_ORIGIN;
const liquidRtcUsername = import.meta.env.PUBLIC_LIQUID_RTC_USERNAME;
const liquidRtcCredential = import.meta.env.PUBLIC_LIQUID_RTC_CREDENTIAL;

// Singleton provider instance to persist across navigation
let liquidProviderInstance: ReturnType<typeof createLiquidProvider> | null = null;
// eslint-disable-next-line import/no-mutable-exports
export let liquidClientInstance: LiquidAuthClient | null = null;

function createLiquidProvider() {
  // Ensure process.nextTick is available for CBOR decoding
  ensureProcessNextTick();

  // Reuse existing client if available
  if (!liquidClientInstance) {
    liquidClientInstance = new LiquidAuthClient({
      origin: liquidOrigin,
      RTC_config_username: liquidRtcUsername,
      RTC_config_credential: liquidRtcCredential,
    });

    // FIX: Override RTC config to match mobile app TURN servers
    (liquidClientInstance as any).RTC_CONFIGURATION = {
      iceServers: [
        {
          urls: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302",
          ]
        },
        {
          urls: [
            "turn:global.turn.nodely.network:80?transport=tcp",
            "turns:global.turn.nodely.network:443?transport=tcp",
            "turn:eu.turn.nodely.io:80?transport=tcp",
            "turns:eu.turn.nodely.io:443?transport=tcp",
            "turn:us.turn.nodely.io:80?transport=tcp",
            "turns:us.turn.nodely.io:443?transport=tcp",
          ],
          username: "liquid-auth",
          credential: "sqmcP4MiTKMT4TGEDSk9jgHY"
        }
      ]
    };
    
    console.log("[Liquid Auth] Created new client instance with matching TURN servers");
  } else {
    console.log("[Liquid Auth] Reusing existing client instance");
  }

  const client = liquidClientInstance;

  let connectedWallet: string | null = null;

  async function checkSession(): Promise<{ user?: { wallet: string } } | null> {
    try {
      console.log("[Liquid Auth] Fetching session from:", `${liquidOrigin}/auth/session`);
      const response = await fetch(`${liquidOrigin}/auth/session`, {
        method: "GET",
        // No credentials needed - WebRTC maintains session state
        headers: {
          "Content-Type": "application/json",
        },
      });

      console.log("[Liquid Auth] Session response status:", response.status);

      if (response.ok) {
        const data = await response.json();
        console.log("[Liquid Auth] Session data:", data);
        return data;
      }

      console.log("[Liquid Auth] Session check failed with status:", response.status);
      return null;
    } catch (error) {
      console.log("[Liquid Auth] Session check error:", error);
      return null;
    }
  }

  // Track last activity timestamp for connection health
  // Initialize to current time, with safeguard against invalid values
  let lastActivity = Math.max(Date.now(), 1000000000000); // Ensure reasonable timestamp

  function getSafeLastActivity(): number {
    // Guard against corrupted or uninitialized lastActivity
    if (!lastActivity || lastActivity < 1000000000000 || lastActivity > Date.now() + 60000) {
      lastActivity = Date.now();
    }
    return lastActivity;
  }

  function logConnectionState(context: string) {
    const dc = (client as any).dataChannel;
    const safeLastActivity = getSafeLastActivity();
    const elapsed = Date.now() - safeLastActivity;
    console.log(`[Liquid Auth] ${context}:`, {
      connectedWallet,
      dataChannelReadyState: dc?.readyState,
      dataChannelExists: !!dc,
      elapsedMs: elapsed,
      lastActivity: safeLastActivity,
      healthy: elapsed < 300000 && dc?.readyState === "open",
    });
  }

  async function ensureConnection(): Promise<string> {
    logConnectionState("Checking connection");
    
    const dc = (client as any).dataChannel;
    const safeLastActivity = getSafeLastActivity();
    const elapsed = Date.now() - safeLastActivity;
    
    if (connectedWallet && dc?.readyState === "open" && elapsed < 300000) {
      console.log("[Liquid Auth] Using existing connection for wallet:", connectedWallet);
      return connectedWallet;
    }
    
    console.log("[Liquid Auth] Connection unhealthy - not reconnecting per request");
    console.log("  - Reason:", !connectedWallet ? "No wallet" : dc?.readyState !== "open" ? "Data channel closed" : "Timeout exceeded");
    throw new Error("Liquid Auth: WebRTC connection unhealthy");
  }

  async function logIceStats(): Promise<void> {
    try {
      const peerConnection = (client as any)?.client?.peerClient as RTCPeerConnection | undefined;
      if (!peerConnection) {
        console.log("[Liquid Auth] ICE stats: no peer connection available");
        return;
      }

      const stats = await peerConnection.getStats();
      let candidatePair: any;
      let inbound: any;
      let outbound: any;

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
          candidatePair = report;
        }
        if (report.type === "inbound-rtp" || report.type === "inbound-rtp" ) {
          inbound = report;
        }
        if (report.type === "outbound-rtp" || report.type === "outbound-rtp") {
          outbound = report;
        }
      });

      console.log("[Liquid Auth] ICE stats:", {
        connectionState: peerConnection.connectionState,
        iceConnectionState: peerConnection.iceConnectionState,
        iceGatheringState: peerConnection.iceGatheringState,
        selectedCandidatePair: candidatePair
          ? {
              localCandidateId: candidatePair.localCandidateId,
              remoteCandidateId: candidatePair.remoteCandidateId,
              currentRoundTripTime: candidatePair.currentRoundTripTime,
              totalRoundTripTime: candidatePair.totalRoundTripTime,
              availableOutgoingBitrate: candidatePair.availableOutgoingBitrate,
              bytesSent: candidatePair.bytesSent,
              bytesReceived: candidatePair.bytesReceived,
              state: candidatePair.state,
            }
          : null,
        inbound,
        outbound,
      });
    } catch (error) {
      console.log("[Liquid Auth] ICE stats error:", error);
    }
  }

  return {
    async connect(): Promise<WalletAccount[]> {
      const walletAddress = await client.connect();
      if (!walletAddress) {
        throw new Error("Liquid Auth: no wallet address returned from connect");
      }
      connectedWallet = walletAddress;
      return [
        {
          name: "Liquid Auth",
          address: walletAddress,
        },
      ];
    },
    async disconnect(): Promise<void> {
      connectedWallet = null;
      lastActivity = 0; // Reset activity timer
      try {
        await client.disconnect();
      } catch (error) {
        // CORS error on logout is expected due to server misconfiguration
        // The session is cleared client-side anyway
        console.log("[Liquid Auth] Logout request failed (CORS), but session cleared locally");
      }
    },
    async resumeSession(): Promise<WalletAccount[] | void> {
      console.log("[Liquid Auth] Attempting to resume session...");

      // First try HTTP session endpoint (now with fixed CORS)
      const session = await checkSession();
      if (session?.user?.wallet) {
        console.log("[Liquid Auth] Resumed session from HTTP:", session.user.wallet);
        connectedWallet = session.user.wallet;
        return [
          {
            name: "Liquid Auth",
            address: session.user.wallet,
          },
        ];
      }

      // Fall back to WebRTC connection state
      const dc = (client as any).dataChannel;
      if (dc?.readyState === "open" && connectedWallet) {
        console.log("[Liquid Auth] Resumed session from WebRTC:", connectedWallet);
        return [
          {
            name: "Liquid Auth",
            address: connectedWallet,
          },
        ];
      }

      console.log("[Liquid Auth] No session to resume");
      return;
    },
    // transactionSigner for Falcon wallet compatibility
    transactionSigner: async (
      txnGroup: Transaction[],
      indexesToSign?: number[],
    ): Promise<Uint8Array[]> => {
      let wallet = await ensureConnection();
      console.log("[Liquid Auth] Signing transactions with wallet:", wallet);

      // Wrap signing with timeout - mobile app may be asleep
      const signWithTimeout = async (): Promise<Uint8Array[]> => {
        console.log("[Liquid Auth] Sending sign request to mobile app...");

        return new Promise((resolve, reject) => {
          const dc = (client as any).dataChannel;
          let responseReceived = false;
          
          const messageHandler = (e: MessageEvent) => {
            if (responseReceived) return;
            
            console.log("[Liquid Auth] Raw message received:", e.data?.substring(0, 200));
            
            try {
              const decoded = cbor.decodeFirstSync(fromBase64Url(e.data));
              console.log("[Liquid Auth] Decoded message:", decoded);
              
              // Check if this is a sign_transactions response
              if (decoded?.reference === "arc0027:sign_transactions:response") {
                responseReceived = true;
                
                if (decoded.error) {
                  console.error("[Liquid Auth] Sign error from app:", decoded.error);
                  reject(new Error(`Sign error: ${decoded.error}`));
                  return;
                }
                
                // Extract signed transactions from result.stxns
                const stxns = decoded.result?.stxns || [];
                console.log("[Liquid Auth] Extracted", stxns.length, "signed transactions from response");
                console.log("[Liquid Auth] txnGroup has", txnGroup.length, "original transactions");
                
                // The mobile app returns just signatures (64 bytes each)
                // We need to reconstruct full signed transactions
                const results = stxns.map((stxn: string, i: number) => {
                  const signatureBytes = fromBase64Url(stxn);
                  console.log(`[Liquid Auth] Signature ${i}: ${signatureBytes.length} bytes`);
                  
                  // If it's a full signed transaction already (large), use it directly
                  if (signatureBytes.length > 200) {
                    console.log(`[Liquid Auth] Transaction ${i} is already fully signed (${signatureBytes.length} bytes)`);
                    return signatureBytes;
                  }
                  
                  // Otherwise, reconstruct the signed transaction from signature + original txn
                  const originalTxn = txnGroup[i];
                  console.log(`[Liquid Auth] Reconstructing signed transaction ${i} from ${signatureBytes.length}-byte signature`);
                  
                  // Build the signed transaction object
                  const signedTxnObj = {
                    sig: signatureBytes,
                    txn: algosdk.decodeObj(originalTxn.toByte()),
                  };
                  
                  // Encode to msgpack
                  const signedTxnBytes = algosdk.encodeObj(signedTxnObj);
                  console.log(`[Liquid Auth] Reconstructed transaction ${i}: ${signedTxnBytes.length} bytes`);
                  return signedTxnBytes;
                });
                resolve(results);
              }
            } catch (err) {
              console.log("[Liquid Auth] Unable to decode message (likely not CBOR)");
            }
          };
          
          if (dc) {
            console.log("[Liquid Auth] Attaching message handler...");
            dc.addEventListener("message", messageHandler);
          }
          
          // Send the sign request
          ensureProcessNextTick();
          client.signTransactions(txnGroup, wallet, indexesToSign).catch((err: any) => {
            // Ignore errors from the client library - we'll handle via message handler
            console.log("[Liquid Auth] Client sign error (ignored):", err?.message);
          });
          
          // 5 minute timeout
          setTimeout(() => {
            if (!responseReceived) {
              if (dc) dc.removeEventListener("message", messageHandler);
              reject(new Error("Signing timeout - mobile app response took too long"));
            }
          }, 300000);
        });
      };

      try {
        const results = await signWithTimeout();
        lastActivity = Date.now();
        return results;
      } catch (error) {
        console.log("[Liquid Auth] Signing timed out (5 min) - no response from mobile app yet.");
        console.log("[Liquid Auth] A late response was seen previously; try waiting longer or retry manually.");
        throw error;
      }
    },
    async signTransactions<T extends Transaction[] | Uint8Array[]>(
      txnGroup: T | T[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> {
      let wallet = await ensureConnection();
      console.log("[Liquid Auth] Signing transactions with wallet:", wallet);

      // Wrap signing with timeout - mobile app may be asleep
      const signWithTimeout = async (): Promise<(Uint8Array | null)[]> => {
        ensureProcessNextTick();
        const signPromise = client.signTransactions(txnGroup as any, wallet, indexesToSign);
const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error("Signing timeout - mobile app asleep")), 300000)
        );
        return await Promise.race([signPromise, timeoutPromise]);
      };

      try {
        const results = await signWithTimeout();
        lastActivity = Date.now();
        return results;
      } catch (error) {
        console.log("[Liquid Auth] Signing timed out (5 min) - no response from mobile app yet.");
        throw error;
      }
    },
  };
}

let walletProviders: SupportedWallet[] = [
  WalletId.PERA,
  WalletId.DEFLY,
  { id: WalletId.LUTE, options: { siteName: "xGov Beta" } },
  WalletId.EXODUS,
  WalletId.KIBISIS,
  /* {
      id: WalletId.WALLETCONNECT,
      options: { projectId: '<TBD>' }
  }, */
];

if (liquidOrigin && liquidRtcUsername && liquidRtcCredential) {
  // Create singleton provider instance
  if (!liquidProviderInstance) {
    liquidProviderInstance = createLiquidProvider();
    console.log("[Liquid Auth] Created provider singleton");
  } else {
    console.log("[Liquid Auth] Reusing provider singleton");
  }

  if (liquidProviderInstance) {
    walletProviders.push({
      id: WalletId.CUSTOM,
      options: {
        provider: liquidProviderInstance,
      },
      metadata: {
        name: "Liquid",
        icon: LiquidIcon,
      },
    });
  }
}

if (import.meta.env.PUBLIC_NETWORK === "localnet") {
  walletProviders = [WalletId.KMD, ...walletProviders];
}

// Exported for use in other modules
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const walletManager = new WalletManager({
  wallets: walletProviders,
  defaultNetwork: import.meta.env.PUBLIC_NETWORK,
});
