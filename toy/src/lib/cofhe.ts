// CoFHE browser integration for Contingent.
// Bridges the app's ethers provider/signer to @cofhe/sdk (viem-based) via Ethers6Adapter, and exposes
// the two operations the UI needs: encrypt a hedge (size + direction) and decrypt a settlement payout.

import { ethers } from 'ethers';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web';
import { arbSepolia } from '@cofhe/sdk/chains';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { Encryptable, FheTypes } from '@cofhe/sdk';
import { ADDRESSES } from '../config/contracts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientPromise: Promise<any> | null = null;

/** Lazily create + connect a CoFHE client from the app's ethers provider/signer. */
export async function getCofheClient(provider: ethers.Provider, signer: ethers.Signer) {
  if (!clientPromise) {
    clientPromise = (async () => {
      const config = createCofheConfig({ supportedChains: [arbSepolia] });
      const client = createCofheClient(config);
      const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
      await client.connect(publicClient, walletClient);
      return client;
    })();
  }
  return clientPromise;
}

/** Drop the cached client (e.g. on account/network change). */
export function resetCofheClient() {
  clientPromise = null;
}

export interface EncryptedHedge {
  encSize: string; // externalEuint64 handle (bytes32)
  sizeProof: string; // batch signature for the size input
  encIsYes: string; // externalEbool handle (bytes32)
  dirProof: string; // batch signature for the direction input
}

/**
 * Encrypt a hedge's size + direction as two independent single-input proofs — matching
 * ContingentHedge.openHedge(eventId, encSize, sizeProof, encIsYes, dirProof). The consuming contract
 * is the Hedge, which runs FHE.asEuint64 / FHE.asEbool on these inputs.
 */
export async function encryptHedge(
  provider: ethers.Provider,
  signer: ethers.Signer,
  sizeUsdg6: bigint,
  isYes: boolean,
): Promise<EncryptedHedge> {
  const client = await getCofheClient(provider, signer);

  const sizeRes = await client
    .encryptInputs([Encryptable.uint64(sizeUsdg6)])
    .setConsumingContract(ADDRESSES.hedge)
    .execute();
  const dirRes = await client
    .encryptInputs([Encryptable.bool(isYes)])
    .setConsumingContract(ADDRESSES.hedge)
    .execute();

  // encryptInputs returns [handle..., batchSignature]; single input -> [handle, sig]
  return {
    encSize: sizeRes[0],
    sizeProof: sizeRes[sizeRes.length - 1],
    encIsYes: dirRes[0],
    dirProof: dirRes[dirRes.length - 1],
  };
}

/** Encrypt a single uint64 bound to `consumingContract` -> { handle, proof }. */
export async function encryptUint64(
  provider: ethers.Provider,
  signer: ethers.Signer,
  value: bigint,
  consumingContract: string,
): Promise<{ handle: string; proof: string }> {
  const client = await getCofheClient(provider, signer);
  const res = await client
    .encryptInputs([Encryptable.uint64(value)])
    .setConsumingContract(consumingContract)
    .execute();
  return { handle: res[0], proof: res[res.length - 1] };
}

/** Encrypt a single bool bound to `consumingContract` -> { handle, proof }. */
export async function encryptBool(
  provider: ethers.Provider,
  signer: ethers.Signer,
  value: boolean,
  consumingContract: string,
): Promise<{ handle: string; proof: string }> {
  const client = await getCofheClient(provider, signer);
  const res = await client
    .encryptInputs([Encryptable.bool(value)])
    .setConsumingContract(consumingContract)
    .execute();
  return { handle: res[0], proof: res[res.length - 1] };
}

/**
 * Privately decrypt a uint64 the connected account is ACL-allowed to see (e.g. its own perp collateral).
 * Uses a self ACP — one signature the first time, then cached by the SDK. Nothing is revealed on-chain.
 */
export async function decryptForView(
  provider: ethers.Provider,
  signer: ethers.Signer,
  ctHash: string,
): Promise<bigint> {
  const client = await getCofheClient(provider, signer);
  await client.acp.getOrCreateSelfACP();
  return BigInt(await client.decryptForView(ctHash, FheTypes.Uint64).withACP().execute());
}

/** Privately decrypt an ebool the connected account is ACL-allowed to see (e.g. its own perp direction). */
export async function decryptBoolForView(
  provider: ethers.Provider,
  signer: ethers.Signer,
  ctHash: string,
): Promise<boolean> {
  const client = await getCofheClient(provider, signer);
  await client.acp.getOrCreateSelfACP();
  return Boolean(await client.decryptForView(ctHash, FheTypes.Bool).withACP().execute());
}

/**
 * Decrypt a publicly-allowed handle (a settlement payout or the aggregate premium pool) for
 * on-chain submission — returns the plaintext and the Teecryptor signature.
 */
export async function decryptForTx(
  provider: ethers.Provider,
  signer: ethers.Signer,
  ctHash: string,
): Promise<{ value: bigint; signature: string }> {
  const client = await getCofheClient(provider, signer);
  // the threshold network can lag the tx that called allowPublic by seconds to minutes (seen: >90s) — retry
  for (let i = 0; ; i++) {
    try {
      const res = await client.decryptForTx(ctHash).withoutACP().execute();
      // res: { ctHash, decryptedValue, signature }
      return { value: BigInt(res.decryptedValue), signature: res.signature };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (i >= 75 || !/not_publicly_allowed|not.?found|404/i.test(msg)) throw e; // up to ~5 min
      if (i % 5 === 0) console.info(`[cofhe] decrypt not ready yet (${msg.slice(0, 60)}) — retry ${i + 1}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}
