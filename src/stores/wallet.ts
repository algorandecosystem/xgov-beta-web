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

const liquidOrigin = import.meta.env.PUBLIC_LIQUID_AUTH_ORIGIN;
const liquidRtcUsername = import.meta.env.PUBLIC_LIQUID_RTC_USERNAME;
const liquidRtcCredential = import.meta.env.PUBLIC_LIQUID_RTC_CREDENTIAL;

function createLiquidProvider() {
  const client = new LiquidAuthClient({
    origin: liquidOrigin,
    RTC_config_username: liquidRtcUsername,
    RTC_config_credential: liquidRtcCredential,
  });

  let connectedWallet: string | null = null;

  async function checkSession(): Promise<{ user?: { wallet: string } } | null> {
    try {
      const response = await fetch(`${liquidOrigin}/auth/session`, {
        method: "GET",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        return data;
      }
      return null;
    } catch (error) {
      console.error("Error checking session:", error);
      return null;
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
      await client.disconnect();
    },
    async resumeSession(): Promise<WalletAccount[] | void> {
      const session = await checkSession();
      if (session?.user?.wallet) {
        connectedWallet = session.user.wallet;
        return [
          {
            name: "Liquid Auth",
            address: session.user.wallet,
          },
        ];
      }
    },
    async signTransactions<T extends Transaction[] | Uint8Array[]>(
      txnGroup: T | T[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> {
      if (!connectedWallet) {
        const session = await checkSession();
        if (!session?.user?.wallet) {
          throw new Error("Liquid Auth: not connected");
        }
        connectedWallet = session.user.wallet;
      }
      return client.signTransactions(
        txnGroup as any,
        connectedWallet,
        indexesToSign,
      );
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
  walletProviders.push({
    id: WalletId.CUSTOM,
    options: {
      provider: createLiquidProvider(),
    },
    metadata: {
      name: "Liquid",
      icon: LiquidIcon,
    },
  });
}

if (import.meta.env.PUBLIC_NETWORK === "localnet") {
  walletProviders = [WalletId.KMD, ...walletProviders];
}

export const walletManager = new WalletManager({
  wallets: walletProviders,
  defaultNetwork: import.meta.env.PUBLIC_NETWORK,
});
