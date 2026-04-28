import { env, FEE_SINK } from '@/constants'
import algosdk, {
  ABIType,
  makePaymentTxnWithSuggestedParamsFromObject,
  encodeAddress,
  encodeUint64,
  decodeUint64
} from "algosdk";
import type { RegistryGlobalState, XGovSubscribeRequestBoxValue } from "./types";
import { algod, algorand, network, RegistryAppID, registryClient } from "./algorand";
import type { ProposerBoxValue, XGovBoxValue, XGovRegistryComposer } from '@algorandfoundation/xgov/registry';
import { fundingLogicSig, fundingLogicSigSigner } from '@/api/testnet-funding-logicsig';
import type { TransactionHandlerProps } from '@/api/types/transaction_state';
import { wrapTransactionSigner } from '@/hooks/useTransactionState';
import { Buffer } from "buffer";
import { sleep } from './nfd';
import * as ghost from '@algorandfoundation/xgov-beta-ghost';

if (globalThis.Buffer === undefined) {
  globalThis.Buffer = Buffer;
}

console.log("registry app id", env.PUBLIC_REGISTRY_APP_ID);
const registryAppID: number = env.PUBLIC_REGISTRY_APP_ID;

export function proposerBoxName(address: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("p"),
      algosdk.decodeAddress(address).publicKey,
    ]),
  );
}

export function xGovBoxName(address: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("x"),
      algosdk.decodeAddress(address).publicKey,
    ]),
  );
}

export function requestBoxName(id: number): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("r"),
      encodeUint64(id),
    ]),
  );
}

export function proposalApprovalBoxName(): Uint8Array {
  return new Uint8Array(
    Buffer.from("pa")
  );
}

export async function getGlobalState(): Promise<RegistryGlobalState | undefined> {
  try {
    const state = await registryClient.state.global.getAll()
    return {
      ...state,
      committeeManager: !!state.committeeManager ? state.committeeManager : '',
      xgovDaemon: !!state.xgovDaemon ? state.xgovDaemon : '',
      kycProvider: !!state.kycProvider ? state.kycProvider : '',
      xgovManager: !!state.xgovManager ? state.xgovManager : '',
      xgovPayor: !!state.xgovPayor ? state.xgovPayor : '',
      xgovCouncil: !!state.xgovCouncil ? state.xgovCouncil : '',
      xgovSubscriber: !!state.xgovSubscriber ? state.xgovSubscriber : '',
    }

  } catch (e) {
    console.error("failed to fetch global registry contract state", e);
    return {} as RegistryGlobalState;
  }
}

export async function getIsXGov(
  address: string,
): Promise<{
  votingAddress: string,
  votedProposals: bigint,
  lastVoteTimestamp: bigint,
  subscriptionRound: bigint,
  isXGov: boolean,
}> {
  try {
    const xgovBoxValue = (await registryClient.newGroup().getXgovBox({
      sender: FEE_SINK,
      args: {
        xgovAddress: address,
      },
      boxReferences: [
        xGovBoxName(address),
      ],
    }).simulate({
      skipSignatures: true,
    })).returns[0] as [[string, bigint, bigint, bigint], boolean];

    return {
      votingAddress: xgovBoxValue[0][0],
      votedProposals: xgovBoxValue[0][1],
      lastVoteTimestamp: xgovBoxValue[0][2],
      subscriptionRound: xgovBoxValue[0][3],
      isXGov: xgovBoxValue[1],
    };
  } catch (e) {
    console.error(e);
    return {
      votingAddress: "",
      votedProposals: BigInt(0),
      lastVoteTimestamp: BigInt(0),
      subscriptionRound: BigInt(0),
      isXGov: false,
    };
  }
}

export async function getIsProposer(
  address: string,
): Promise<{ isProposer: boolean } & ProposerBoxValue> {
  try {
    const proposerBoxValue = (await registryClient.newGroup().getProposerBox({
      sender: FEE_SINK,
      args: {
        proposerAddress: address,
      },
      boxReferences: [
        proposerBoxName(address),
      ],
    }).simulate({
      skipSignatures: true,
    })).returns[0] as [[boolean, boolean, bigint], boolean];

    return {
      activeProposal: proposerBoxValue[0][0],
      kycStatus: proposerBoxValue[0][1],
      kycExpiring: proposerBoxValue[0][2],
      isProposer: proposerBoxValue[1],
    };
  } catch (e) {
    console.error(e);
    return {
      activeProposal: false,
      kycStatus: false,
      kycExpiring: BigInt(0),
      isProposer: false,
    };
  }
}

export async function getAllProposers(): Promise<{
  [key: string]: ProposerBoxValue;
}> {
  const proposers: { [key: string]: ProposerBoxValue } = {};
  const boxes = await algorand.client.algod
    .getApplicationBoxes(registryAppID)
    .do();

  for (const box of boxes.boxes) {
    if (box.name[0] !== 112 || box.name.length !== 33) {
      continue;
    }

    const addr = encodeAddress(Buffer.from(box.name.slice(1)));

    const proposerBoxValue = await getIsProposer(addr);

    proposers[addr] = proposerBoxValue;
  }

  return proposers;
}

export async function getAllSubscribedXGovs(): Promise<string[]> {
  const boxes = await algorand.client.algod
    .getApplicationBoxes(registryAppID)
    .do();

  const xGovBoxes = boxes.boxes.filter((box) => {
    const boxName = new TextDecoder().decode(box.name);
    return boxName.startsWith("x");
  });

  return xGovBoxes.map((box) => {
    return encodeAddress(Buffer.from(box.name.slice(1)));
  });
}

export async function getAllXGovData(): Promise<string[]> {
  const all = await getAllSubscribedXGovs();

  const results: XGovBoxValue[] = [];
  for (let i = 0; i < all.length; i += 63) {
    const chunk = all.slice(i, i + 63);
    results.push(...((await ghost.getXGovs(algorand, BigInt(registryAppID), chunk))));
  }

  console.log('results', results)

  return all
}

export async function getDelegatedXGovData(account: string): Promise<(XGovBoxValue & { xgov: string })[]> {
  const all = await getAllSubscribedXGovs();

  const results: (XGovBoxValue & { xgov: string })[] = [];
  for (let i = 0; i < all.length; i += 63) {
    const chunk = all.slice(i, i + 63);
    results.push(
      ...(
        (await ghost.getXGovs(algorand, BigInt(registryAppID), chunk))
          .map((v, ii) => ({ ...v, xgov: all[i + ii] }))
          .filter(v => v.votingAddress === account && v.xgov !== account)
      )
    );
  }

  return results
}


export async function getAllXGovSubscribeRequests(): Promise<(XGovSubscribeRequestBoxValue & { id: bigint })[]> {
  const boxes = await algorand.client.algod
    .getApplicationBoxes(registryAppID)
    .do();

  const RequestBoxes = boxes.boxes.filter((box) => {
    const boxName = new TextDecoder().decode(box.name);
    return boxName.startsWith("r");
  });

  const results = await Promise.allSettled(
    RequestBoxes.map(async (box) => {
      return await algorand.client.algod.getApplicationBoxByName(registryAppID, box.name).do();
    })
  );

  const abi = ABIType.from('(address,address,uint64)');

  return results.map((result) => {
    if (result.status === "fulfilled") {
      const box = result.value
      const decoded = abi.decode(box.value)

      if (!Array.isArray(decoded)) {
        throw new Error("Decoded value is not an array");
      }

      return {
        id: BigInt(decodeUint64(box.name.slice(1), "safe")),
        xgovAddr: decoded[0] as string,
        ownerAddr: decoded[1] as string,
        relationType: BigInt(decoded[2] as number),
      }
    } else {
      throw new Error(`Failed to fetch box: ${result.reason}`);
    }
  }).sort(({ id: a }, { id: b }) => (a < b ? 1 : a > b ? -1 : 0));
}

export interface SubscribeXGovRequestProps extends TransactionHandlerProps {
  requestId: bigint;
}

export interface ApproveSubscribeXGovRequestProps extends SubscribeXGovRequestProps {
  xgovAddress: string;
}

export async function approveSubscribeRequest({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  requestId,
  xgovAddress
}: ApproveSubscribeXGovRequestProps): Promise<void> {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  if (!activeAddress || !transactionSigner) {
    setStatus(new Error("No active address or transaction signer"));
    return;
  }

  try {
    await registryClient.send.approveSubscribeXgov({
      sender: activeAddress,
      signer: transactionSigner,
      args: { requestId },
      boxReferences: [
        requestBoxName(Number(requestId)),
        xGovBoxName(xgovAddress),
      ],
    });

    setStatus("confirmed");
    await sleep(800);
    setStatus("idle");
    await Promise.all(refetch.map(r => r()));
  } catch (e: any) {
    console.error("Error during approveSubscribeXgov:", e.message);
    setStatus(new Error(`Failed to approve subscribe request`));
    return;
  }
}

export async function rejectSubscribeRequest({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  requestId
}: SubscribeXGovRequestProps): Promise<void> {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  if (!activeAddress || !transactionSigner) {
    setStatus(new Error("No active address or transaction signer"));
    return;
  }

  try {
    await registryClient.send.rejectSubscribeXgov({
      sender: activeAddress,
      signer: transactionSigner,
      args: { requestId },
      boxReferences: [
        requestBoxName(Number(requestId)),
      ],
    });

    setStatus("confirmed");
    await sleep(800);
    setStatus("idle");
    await Promise.all(refetch.map(r => r()));
  } catch (e: any) {
    console.error("Error during approveSubscribeXgov:", e.message);
    setStatus(new Error(`Failed to approve subscribe request`));
    return;
  }
}

export interface SubscribeXGovProps extends TransactionHandlerProps {
  xgovFee?: bigint
}

export async function subscribeXgov({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  xgovFee,
}: SubscribeXGovProps) {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  console.log("[subscribeXgov] Checking params - activeAddress:", activeAddress, "transactionSigner exists:", !!transactionSigner);

  if (!activeAddress || !transactionSigner) {
    console.error("[subscribeXgov] Missing required params - activeAddress:", activeAddress, "transactionSigner:", !!transactionSigner);
    setStatus(new Error("No active address or transaction signer - please check your wallet connection"));
    return;
  }

  if (!xgovFee) {
    setStatus(new Error("xgovFee is not set"));
    return;
  }

  const suggestedParams = await algorand.getSuggestedParams();

  // RAW APPROACH: Build and sign transactions manually instead of using composer
  try {
    console.log("[subscribeXgov] Using RAW approach - building algosdk transactions...");

    // Array to hold all transactions
    const txns: algosdk.Transaction[] = [];

    // 1. Funding transaction (testnet only) - will be signed by logic sig
    if (network === "testnet") {
      console.log("[subscribeXgov] Adding funding transaction");
      const fundingTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: fundingLogicSig.address(),
        receiver: activeAddress,
        amount: 100_000_000, // 100 ALGO
        suggestedParams,
      });
      txns.push(fundingTxn);
    }

    // 2. Payment transaction for xGov fee
    const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: activeAddress,
      receiver: algosdk.getApplicationAddress(RegistryAppID),
      amount: xgovFee,
      suggestedParams,
    });
    txns.push(paymentTxn);

    // 3. App call transaction for subscribeXgov
    const methodSignature = "subscribe_xgov(address,pay)void";
    const boxName = xGovBoxName(activeAddress);
    
    // Method selector for "subscribe_xgov(address,pay)void" 
    // First 4 bytes of SHA-512/256 hash: a082cef8
    const methodSelector = new Uint8Array([0xa0, 0x82, 0xce, 0xf8]);
    
    // Build app args: method selector + voting_address
    const appArgs = [
      methodSelector,
      // voting_address (32 bytes public key)
      algosdk.decodeAddress(activeAddress).publicKey,
    ];
    
    const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: activeAddress,
      appIndex: Number(RegistryAppID),
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs,
      boxes: [
        { appIndex: Number(RegistryAppID), name: boxName },
      ],
      suggestedParams: {
        ...suggestedParams,
        fee: 3000, // Fee for the app call
      },
    });
    txns.push(appCallTxn);

    console.log("[subscribeXgov] Created", txns.length, "transactions");

    // Group the transactions
    const groupId = algosdk.computeGroupID(txns);
    for (const txn of txns) {
      txn.group = groupId;
    }
    console.log("[subscribeXgov] Assigned group ID");

    // Sign transactions
    const signedTxns: (Uint8Array | null)[] = new Array(txns.length).fill(null);
    
    // 1. Sign funding transaction with logic sig (if testnet)
    if (network === "testnet") {
      console.log(`[subscribeXgov] Signing transaction 0 with logic sig...`);
      const signed = algosdk.signLogicSigTransactionObject(txns[0], fundingLogicSig);
      signedTxns[0] = signed.blob;
      console.log(`[subscribeXgov] Transaction 0 signed with logic sig (${signed.blob.length} bytes)`);
    }
    
    // 2. Sign all user transactions together (payment + app call)
    // These need to be signed as a group by the user
    const userTxnIndexes = network === "testnet" 
      ? [1, 2]  // Skip funding (index 0)
      : [0, 1]; // All transactions (no funding)
    
    const userTxns = userTxnIndexes.map(i => txns[i]);
    console.log(`[subscribeXgov] Signing ${userTxns.length} user transactions together...`);
    
    const signResults = await transactionSigner(userTxns, userTxnIndexes);
    
    // Check all signatures received
    for (let i = 0; i < userTxnIndexes.length; i++) {
      const originalIndex = userTxnIndexes[i];
      if (!signResults[i]) {
        throw new Error(`Failed to sign transaction ${originalIndex}`);
      }
      signedTxns[originalIndex] = signResults[i];
      console.log(`[subscribeXgov] Transaction ${originalIndex} signed (${signResults[i].length} bytes)`);
    }

    // Verify all transactions are signed
    if (signedTxns.some(tx => tx === null)) {
      throw new Error("Not all transactions were signed");
    }

    console.log("[subscribeXgov] All transactions signed, sending to network...");

    console.log("[subscribeXgov] All transactions signed, sending to network...");

    // Send transactions as a group
    const sendResponse = await algod.sendRawTransaction(signedTxns).do();
    const txId = typeof sendResponse === 'string' ? sendResponse : (sendResponse as { txid: string }).txid;
    console.log("[subscribeXgov] Group sent, txId:", txId);

    // Wait for confirmation
    console.log("[subscribeXgov] Waiting for confirmation...");
    const confirmation = await algosdk.waitForConfirmation(algod, txId, 4);
    console.log("[subscribeXgov] Confirmed in round:", confirmation.confirmedRound);

    setStatus("confirmed");
    await sleep(800);
    setStatus("idle");
    await Promise.all(refetch.map(r => r()));

  } catch (e: any) {
    console.error("Error during subscribeXgov:", e);
    setStatus(new Error(`Failed to subscribe to be a xGov: ${e.message}`));
    return;
  }
};

export async function unsubscribeXgov({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
}: TransactionHandlerProps): Promise<void> {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  if (!activeAddress || !transactionSigner) {
    setStatus(new Error("No active address or transaction signer"));
    return;
  }

  try {
    await registryClient.send.unsubscribeXgov({
      sender: activeAddress,
      signer: transactionSigner,
      args: {},
      extraFee: (1_000).microAlgos(),
      boxReferences: [
        xGovBoxName(activeAddress),
      ],
    });
  } catch (e: any) {
    console.error("Error during unsubscribeXgov:", e.message);
    setStatus(new Error(`Failed to unsubscribe from xGov`));
    return;
  }

  setStatus("confirmed");
  await sleep(800);
  setStatus("idle");
  await Promise.all(refetch.map(r => r()));
}

export interface SubscribeProposerProps extends TransactionHandlerProps {
  amount: bigint
}

export async function subscribeProposer({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  amount,
}: SubscribeProposerProps) {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  if (!activeAddress || !transactionSigner) {
    setStatus(new Error("No active address or transaction signer"));
    return;
  }

  const suggestedParams = await algorand.getSuggestedParams();

  const payment = makePaymentTxnWithSuggestedParamsFromObject({
    sender: activeAddress,
    receiver: algosdk.getApplicationAddress(RegistryAppID),
    amount,
    suggestedParams,
  });

  let builder: XGovRegistryComposer<any> = registryClient.newGroup();

  if (network === "testnet") {
    builder = builder.addTransaction(
      await registryClient.algorand.createTransaction.payment({
        sender: fundingLogicSig.address(),
        receiver: activeAddress,
        amount: (100).algos(),
      }),
      fundingLogicSigSigner,
    );
  }

  builder = builder.subscribeProposer({
    sender: activeAddress,
    signer: transactionSigner,
    args: { payment },
    boxReferences: [
      proposerBoxName(activeAddress),
    ],
  });

  try {
    await builder.send();
  } catch (e: any) {
    console.error("Error during subscribeProposer:", e.message);
    setStatus(new Error(`Failed to subscribe to be a proposer`));
    return;
  }

  setStatus("confirmed");
  await sleep(800);
  setStatus("idle");
  await Promise.all(refetch.map(r => r()));
}

export interface SetVotingAddressProps extends TransactionHandlerProps {
  newAddress: string
}

export async function setVotingAddress({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  newAddress,
}: SetVotingAddressProps): Promise<void> {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  if (!activeAddress || !transactionSigner) {
    setStatus(new Error("No active address or transaction signer"));
    return;
  }

  try {
    await registryClient.send.setVotingAccount({
      sender: activeAddress,
      signer: transactionSigner,
      args: {
        xgovAddress: activeAddress,
        votingAddress: newAddress,
      },
      boxReferences: [
        xGovBoxName(activeAddress),
      ],
    });
  } catch (e: any) {
    console.error("Error during setVotingAddress:", e.message);
    setStatus(new Error('Failed to set voting address'));
    return;
  }

  setStatus("confirmed");
  await sleep(800);
  setStatus("idle");
  await Promise.all(refetch.map(r => r()));
}

export type SetProposerKYCNoWallet = Omit<SetProposerKYCProps, "innerSigner" | "activeAddress">

export interface SetProposerKYCProps extends TransactionHandlerProps {
  proposalAddress: string;
  kycStatus: boolean;
  expiration: number;
}

export async function setProposerKYC({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  proposalAddress,
  kycStatus,
  expiration
}: SetProposerKYCProps) {
  if (!innerSigner) return;

  const transactionSigner = wrapTransactionSigner(
    innerSigner,
    setStatus,
  );

  setStatus("loading");

  if (!activeAddress || !transactionSigner) {
    setStatus(new Error("No active address or transaction signer"));
    return;
  }

  try {
    // fund proposers on testnet if they have < 200A balance
    let shouldFund = false;
    if (network === "testnet" && kycStatus === true) {
      const { amount } = await algod.accountInformation(proposalAddress).do();
      if (amount < 200_000_000) {
        shouldFund = true;
      }
    }

    let builder = registryClient.newGroup().setProposerKyc({
      sender: activeAddress,
      signer: transactionSigner,
      args: {
        proposer: proposalAddress,
        kycStatus: kycStatus,
        kycExpiring: expiration,
      },
      boxReferences: [proposerBoxName(proposalAddress)],
    });

    if (shouldFund) {
      builder = builder.addTransaction(
        await registryClient.algorand.createTransaction.payment({
          sender: activeAddress,
          receiver: proposalAddress,
          amount: (200).algos(),
        }),
        transactionSigner,
      );
    }

    const { confirmations: [confirmation] } = await builder.send();

    if (
      confirmation.confirmedRound !== undefined &&
      confirmation.confirmedRound > 0 &&
      confirmation.poolError === ""
    ) {
      setStatus("confirmed");
      await sleep(800);
      setStatus("idle");
      await Promise.all(refetch.map(r => r()));
      return;
    }

    setStatus(new Error("Failed to confirm transaction submission"));
  } catch (e: any) {
    console.error("Error during setVotingAddress:", e.message);
    setStatus(new Error(`Failed to set proposer KYC`));
    return;
  }
}
